// AIProvider: provider-neutral async AI client (Phase 3).
// Pure CJS module: runs under Cinnamon GJS AND node --test.
//
// The HTTP transport is injected so tests can mock the network. The default
// transport uses libsoup when running inside Cinnamon; outside (plain node)
// it fails gracefully with a normalized error instead of crashing.
//
// No UI/SearchEngine knowledge lives here. The first concrete backend is
// OpenRouter, expressed only as the default endpoint + request shape.

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TOKENS = 512;

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
                        cb({ error: /cancel/i.test(msg2) ? 'cancelled' : 'network', detail: msg2 });
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
    const http = opts.http || defaultTransport(timeoutMs);

    let gen = 0;

    // ask(question, ctx, cb): cb(err, result)
    // err/result are normalized objects; exactly one callback per call,
    // except after cancel() which permanently invalidates pending calls.
    function ask(question, ctx, cb) {
        ctx = ctx || {};
        const myGen = ++gen;
        const done = (err, data) => {
            if (myGen !== gen) return; // stale: superseded by cancel()/newer ask
            cb(err, data);
        };

        const q = String(question == null ? '' : question).trim();
        if (!q) { done({ error: 'empty-question' }); return; }
        // NOTE: key requirement is decided by AIManager via registry
        // needsKey; local/keyless providers may send an empty Bearer.

        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: q }],
            max_tokens: MAX_TOKENS
        });

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
            cancellable: ctx.cancellable || null,
            timeoutMs: timeoutMs
        }, (err, res) => {
            if (err) { done(err); return; }
            const status = Number(res.status) || 0;
            if (status < 200 || status >= 300) {
                done({ error: 'http-' + status });
                return;
            }
            try {
                const json = JSON.parse(res.text);
                const choice = json.choices && json.choices[0];
                const content = choice && choice.message && choice.message.content;
                if (content == null) { done({ error: 'bad-response' }); return; }
                done(null, { answer: String(content).trim(), model: json.model || model });
            } catch (e) {
                done({ error: 'bad-response' });
            }
        });
    }

    // invalidates every in-flight ask(); transport-level abort happens through
    // the Gio.Cancellable supplied by the caller in ctx
    function cancel() {
        gen++;
    }

    return { ask: ask, cancel: cancel };
}

module.exports = { createAIProvider, REGISTRY, DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, MAX_TOKENS };
