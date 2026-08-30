// AIProvider: provider-neutral async AI client (Phase 3).
// Pure CJS module: runs under Cinnamon GJS AND node --test.
//
// The HTTP transport is injected so tests can mock the network. The default
// transport uses libsoup when running inside Cinnamon; outside (plain node)
// it fails gracefully with a normalized error instead of crashing.
//
// No UI/SearchEngine knowledge lives here. The first concrete backend is
// OpenRouter, expressed only as the default endpoint + request shape.

let Gio = null;
try { Gio = require('gi.Gio'); } catch (e) { /* plain node: no cancellable */ }

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_TOKENS = 2048;

function defaultTransport(timeoutMs) {
    try {
        const Soup = require('gi.Soup');
        const GLib = require('gi.GLib');
        const session = new Soup.Session();
        session.timeout = Math.max(1, Math.ceil((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000));
        return function soupTransport(opts, cb) {
            const msg = Soup.Message.new(opts.method || 'POST', opts.url);
            if (!msg) { cb({ error: 'bad-request' }); return; }
            const headers = opts.headers || {};
            for (const k in headers) msg.get_request_headers().append(k, headers[k]);
            if (opts.body) {
                msg.set_request_body_from_bytes('application/json', GLib.Bytes.new(opts.body));
            }
            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, opts.cancellable || null,
                (s, res) => {
                    if (opts.cancellable && opts.cancellable.is_cancelled()) {
                        cb({ error: 'cancelled' });
                        return;
                    }
                    try {
                        const bytes = s.send_and_read_finish(res);
                        const text = new TextDecoder().decode(bytes.get_data());
                        cb(null, { status: msg.get_status(), text: text });
                    } catch (e) {
                        const msg2 = String(e.message || '');
                        if (/cancel/i.test(msg2)) cb({ error: 'cancelled' });
                        else if (/timed?\s*out/i.test(msg2)) cb({ error: 'timeout', detail: msg2 });
                        else cb({ error: 'network', detail: msg2 });
                    }
                });
        };
    } catch (e) {
        // no Soup outside Cinnamon: normalized failure, never a crash
        return function noTransport(_opts, cb) { cb({ error: 'no-http-transport' }); };
    }
}

// Provider registry metadata: adding a new OpenAI-compatible backend is a
// data-only change (id + label + defaults). Non-OpenAI-compatible APIs
// (e.g. Ollama) need their own engine before being registered.
const REGISTRY = {
    '9router': {
        label: '9Router',
        defaultEndpoint: 'http://127.0.0.1:20128/v1/chat/completions',
        defaultModel: '',
        needsKey: false
    },
    'openrouter': {
        label: 'OpenRouter',
        defaultEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
        defaultModel: '',
        needsKey: true
    },
    'openai': {
        label: 'OpenAI',
        defaultEndpoint: '',
        defaultModel: '',
        needsKey: true
    },
    'custom': {
        label: 'Custom OpenAI-compatible',
        defaultEndpoint: '',
        defaultModel: '',
        needsKey: false
    }
};

function createAIProvider(opts) {
    opts = opts || {};
    const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    const apiKey = String(opts.apiKey || '');
    // explicit empty string is respected (local routers may not need one);
    // omitting the option falls back to the generic default
    const model = (opts.model != null) ? String(opts.model) : DEFAULT_MODEL;
    const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    // configurable: some Combo/reasoning models spend many tokens thinking
    const maxTokens = Number(opts.maxTokens) || DEFAULT_MAX_TOKENS;
    const http = opts.http || defaultTransport(timeoutMs);

    let gen = 0;
    // Phase 5: real transport cancellation (Soup aborts the request).
    // opts.cancellable override exists for tests (node has no Gio).
    const cancellable = opts.cancellable ||
        ((Gio && Gio.Cancellable) ? new Gio.Cancellable() : null);

    // ask(question, ctx, cb): cb(err, result)
    // err/result are normalized objects; exactly one callback per call,
    // except after cancel() which permanently invalidates pending calls.
    function ask(question, ctx, cb) {
        ctx = ctx || {};
        const myGen = ++gen;
        const done = (err, data) => {
            // stale results are dropped — EXCEPT cancellation, a terminal
            // state upper layers need so they can roll back pending turns
            if (myGen !== gen && !(err && err.error === 'cancelled')) return;
            cb(err, data);
        };

        const q = String(question == null ? '' : question).trim();
        if (!q) { done({ error: 'empty-question' }); return; }
        // NOTE: key requirement is decided by AIManager via registry
        // needsKey; local/keyless providers may send an empty Bearer.

        // multi-turn (Phase 4.5): a valid ctx.messages array replaces the
        // single-message body; its last user message IS the question.
        // Phase 9 (additive): agent-loop shapes pass through untouched —
        // assistant turns carrying tool_calls and role:'tool' results —
        // while legacy user/assistant coercion stays exactly as before.
        let messages = null;
        if (Array.isArray(ctx.messages) && ctx.messages.length) {
            messages = ctx.messages.map(m => {
                // Phase 10: multimodal content ARRAYS pass through verbatim
                // (text + image_url parts); role coercion still applies.
                if (m && Array.isArray(m.content)) {
                    return {
                        role: (m && m.role === 'assistant') ? 'assistant' : 'user',
                        content: m.content
                    };
                }
                if (m && m.role === 'tool') {
                    const t = { role: 'tool', content: String((m && m.content) != null ? m.content : '') };
                    if (m.tool_call_id) t.tool_call_id = String(m.tool_call_id);
                    return t;
                }
                // Phase 12: agent system message passes through verbatim
                if (m && m.role === 'system') {
                    return { role: 'system', content: String((m && m.content) != null ? m.content : '') };
                }
                if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                    return { role: 'assistant', content: (m.content != null) ? String(m.content) : null,
                             tool_calls: m.tool_calls };
                }
                return {
                    role: (m && m.role === 'assistant') ? 'assistant' : 'user',
                    content: String((m && m.content) != null ? m.content : '')
                };
            });
        }
        if (!messages) messages = [{ role: 'user', content: q }];

        // Phase 9: optional tool definitions (AgentManager supplies them,
        // already in OpenAI wire format); omitted entirely when absent so
        // legacy requests keep their proven shape.
        let tools = null;
        if (Array.isArray(ctx.tools) && ctx.tools.length) tools = ctx.tools;

        const body = JSON.stringify(Object.assign({
            model: model,
            messages: messages,
            stream: false,
            max_tokens: maxTokens
        }, tools ? { tools: tools } : {}));

        http({
            url: endpoint,
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://cinnamon.org',
                'X-Title': 'Quick Search'
            },
            body: body,
            cancellable: ctx.cancellable || cancellable || null,
            timeoutMs: timeoutMs
        }, (err, res) => {
            if (err) { done(err); return; }
            const status = Number(res.status) || 0;
            if (status < 200 || status >= 300) {
                // surface the upstream/provider message when present so the
                // UI can show something informative instead of a bare code
                let detail = '';
                try {
                    const j = JSON.parse(res.text);
                    const m = j && j.error ? (j.error.message || j.error) : null;
                    if (m) detail = String(m).slice(0, 200);
                } catch (e) {}
                done({ error: 'http-' + status, detail: detail });
                return;
            }
            try {
                const json = JSON.parse(res.text);
                const choice = json.choices && json.choices[0];
                const msg = choice && choice.message;
                // Phase 9: tool-call requests resolve BEFORE the empty-content
                // check — a tool_calls turn may legitimately have empty content.
                if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
                    const tcs = [];
                    for (let i = 0; i < msg.tool_calls.length; i++) {
                        const tc = msg.tool_calls[i];
                        tcs.push({
                            id: String((tc && tc.id) || ''),
                            name: (tc && tc.function) ? String(tc.function.name || '') : '',
                            argsJson: (tc && tc.function && tc.function.arguments != null)
                                ? String(tc.function.arguments) : '{}'
                        });
                    }
                    done(null, { answer: String(msg.content || '').trim(), toolCalls: tcs,
                                 model: json.model || model });
                    return;
                }
                const content = msg && msg.content;
                if (content == null || !String(content).trim()) {
                    // ponytail: empty 200+stop must stay an error — never
                    // synthesize an answer from reasoning fields. Upgrade
                    // only by adding explicit reasoning UI, not by coercing.
                    const parts = ['empty-content'];
                    if (choice && choice.finish_reason) parts.push('finish_reason=' + choice.finish_reason);
                    const respModel = (json && json.model) || model;
                    if (respModel) parts.push('model=' + String(respModel).slice(0, 80));
                    const hasReasoning = !!(msg && (msg.reasoning_content || msg.reasoning)) ||
                        !!(choice && (choice.reasoning_content || choice.reasoning || choice.reasoning_details));
                    if (hasReasoning) parts.push('reasoning_present');
                    done({ error: 'bad-response', detail: parts.join(' ') });
                    return;
                }
                done(null, { answer: String(content).trim(), model: json.model || model });
            } catch (e) {
                done({ error: 'bad-response' });
            }
        });
    }

    // invalidates every in-flight ask() and aborts the real HTTP request
    function cancel() {
        gen++;
        if (cancellable) { try { cancellable.cancel(); } catch (e) {} }
    }

    return { ask: ask, cancel: cancel };
}

module.exports = { createAIProvider, REGISTRY, DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS };
