// AgentManager (Phase 9): orchestrates AIManager <-> ToolRegistry in a bounded
// agent loop. Pure CJS module: runs under Cinnamon GJS AND node --test.
//
// Responsibilities (roadmap Phase 9):
//   - send available tool definitions with each model call
//   - accept final answer OR tool requests from the model
//   - validate + execute tool calls through the EXISTING ToolRegistry
//     (unknown tool / invalid arguments / failures become normalized
//     role:'tool' error payloads — never crashes, never auto-retries)
//   - hard step cap (LIMITS.maxAgentSteps)
//   - one cancellable per run shared by AI + tools; cancel() kills the whole
//     run and stale callbacks are silently dropped (never render)
//
// No UI/SearchEngine knowledge lives here. ConversationManager keeps owning
// history; the agent only extends its own working message list within a run.

let Gio = null;
try { Gio = require('gi.Gio'); } catch (e) { /* plain node: no cancellable */ }

// LOADER INVARIANT: no project-relative requires here — Cinnamon resolves
// EVERY relative require against the APPLET ROOT (zena strips './' sequences
// anywhere), so cross-file constants arrive via injection (opts.limits).
// Fallbacks mirror toolRegistry.LIMITS so pure loop tests need no wiring.
const FALLBACK_LIMITS = {
    maxAgentSteps: 8,
    maxResultChars: 4000,
    maxImageDataUrlChars: 6000000
};

// Phase 12: keeps the model honest about tool use — intent narration is NOT
// execution. Short by design (token cost); policy enforcement lives in code,
// never in the prompt.
const AGENT_SYSTEM_PROMPT =
    'You are Quick Search, an agent with tools. ' +
    'When the user asks you to open/launch/focus an app, open a URL or file, ' +
    'search files or the web, calculate, look at the screen, or control the ' +
    'mouse/keyboard, you MUST call the matching tool instead of replying with text alone. ' +
    'Never claim an action succeeded unless its tool result reports success. ' +
    'If a tool returns an error (for example permission-denied or app-not-found), ' +
    'say so honestly.';

function createAgentManager(opts) {
    opts = opts || {};
    if (typeof opts.aiAsk !== 'function') throw new Error('agent-manager-requires-aiAsk');
    const aiAsk = opts.aiAsk;
    const registry = opts.registry || null;
    const L = Object.assign({}, FALLBACK_LIMITS, opts.limits || {});
    const maxSteps = Number(opts.maxSteps) || L.maxAgentSteps;
    const maxToolChars = L.maxResultChars;
    // Phase 10: vision capability is determined by the HOST (settings +
    // provider metadata); default OFF so screenshots never happen by accident
    const hasVision = opts.hasVision || (() => false);
    // Phase 12: single permission entry point. Absent policy = legacy
    // allow-all behavior (kept for pure-loop tests); the applet ALWAYS wires
    // a real policy.
    const policy = opts.policy || null;
    const requestConfirmation = typeof opts.requestConfirmation === 'function'
        ? opts.requestConfirmation : null;
    // Phase 13: lightweight activity events for the UI status line.
    // Optional; UI errors must never break the agent loop, so every emit is
    // guarded. Payloads carry tool IDS only — never args/results.
    const onPhase = typeof opts.onPhase === 'function' ? opts.onPhase : null;
    const onToolStart = typeof opts.onToolStart === 'function' ? opts.onToolStart : null;
    const onToolComplete = typeof opts.onToolComplete === 'function' ? opts.onToolComplete : null;
    const onToolError = typeof opts.onToolError === 'function' ? opts.onToolError : null;
    const safeEmit = (fn, ...args) => {
        if (!fn) return;
        try { fn.apply(null, args); } catch (e) {}
    };
    // injectable for node tests; real Gio.Cancellable inside Cinnamon
    const makeCancellable = opts.makeCancellable ||
        (() => ((Gio && Gio.Cancellable) ? new Gio.Cancellable() : null));

    let gen = 0;                    // monotonic run generation: stale-run guard
    let activeCancellable = null;

    // OpenAI wire-format tool definitions, derived fresh from the registry.
    // Conversion lives HERE so ToolRegistry stays free of AI knowledge.
    function toolDefs() {
        if (!registry) return null;
        const defs = registry.list().map(t => ({
            type: 'function',
            function: {
                name: t.id,
                description: t.description,
                parameters: {
                    type: 'object',
                    properties: t.inputSchema.properties || {},
                    required: t.inputSchema.required || []
                }
            }
        }));
        return defs.length ? defs : null;
    }

    // run(question, ctx, cb): cb(err|null, {answer}|null). A new run
    // supersedes any previous run (single-flight, stale runs go silent).
    function run(question, ctx, cb) {
        const myGen = ++gen;
        if (activeCancellable) { try { activeCancellable.cancel(); } catch (e) {} }
        const cancellable = makeCancellable() || null;
        activeCancellable = cancellable;

        const base = Array.isArray(ctx && ctx.messages) ? ctx.messages.slice() : [];
        if (!base.length) base.push({ role: 'user', content: String(question == null ? '' : question) });
        // Phase 12: one system message per run so the model USES the tools
        // instead of narrating intent — it may only claim success after a
        // successful tool result. Never a substitute for policy enforcement.
        if (toolDefs() && !base.some(m => m && m.role === 'system')) {
            base.unshift({ role: 'system', content: AGENT_SYSTEM_PROMPT });
        }
        let steps = 0;
        // capability snapshot per run (Phase 10): tools read it via ctx
        const capabilities = { vision: !!hasVision() };

        function finish(err, data) {
            if (activeCancellable === cancellable) activeCancellable = null;
            if (myGen !== gen) return;  // superseded/cancelled -> NEVER render
            cb(err || null, err ? null : data);
        }

        // every tool outcome — success or normalized failure — becomes a
        // role:'tool' message the model can read on its next turn
        function pushToolMessage(callId, payload) {
            let s;
            try { s = JSON.stringify(payload); } catch (e) { s = '{"error":"unserializable"}'; }
            base.push({ role: 'tool', tool_call_id: String(callId || ''),
                        content: s.slice(0, maxToolChars) });
        }

        // Phase 10: an image payload never rides inside the tool message —
        // strict providers reject array content on role:'tool'. The pixels
        // become ONE user turn (OpenAI multimodal shape) right after a small
        // tool ack, so history stays lean and protocol-clean.
        function _handleImageResult(call, result) {
            const url = result && result.image;
            if (typeof url !== 'string') return false;
            // inline gate (loader-safe): prefix + shared image ceiling
            const ok = url.lastIndexOf('data:image/', 0) === 0 &&
                url.length <= L.maxImageDataUrlChars;
            if (!ok) {
                pushToolMessage(call.id, { error: 'image-too-large' });
                return true;
            }
            base.push({ role: 'tool', tool_call_id: String(call.id || ''),
                        content: JSON.stringify({ image_received: true }) });
            base.push({
                role: 'user',
                content: [
                    { type: 'text', text: '(screenshot layar terlampir — analisis gambar ini)' },
                    { type: 'image_url', image_url: { url: url } }
                ]
            });
            return true;
        }

        function executeCalls(calls, i) {
            if (myGen !== gen) return;
            if (i >= calls.length) { step(); return; }
            const c = calls[i];

            let parsed = null, parseErr = null;
            try { parsed = JSON.parse(String(c.argsJson == null ? '{}' : c.argsJson)); }
            catch (e) { parseErr = e; }
            if (parseErr || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                pushToolMessage(c.id, parseErr
                    ? { error: 'invalid-arguments', reason: 'unparseable-json' }
                    : { error: 'invalid-arguments', reason: 'args-must-be-object' });
                executeCalls(calls, i + 1);
                return;
            }

            // Phase 12: single policy entry point BEFORE any execution
            const toolMeta = registry ? registry.get(String(c.name || '')) : null;
            const verdict = policy
                ? policy.decide(String(c.name || ''), toolMeta ? toolMeta.riskLevel : undefined)
                : 'allow';

            const proceed = () => {
                safeEmit(onToolStart, String(c.name || ''));
                try {
                    registry.execute(String(c.name || ''), parsed,
                        { cancellable: cancellable, capabilities: capabilities },
                        (err, result) => {
                            if (myGen !== gen) return;
                            if (err) {
                                safeEmit(onToolError, String(c.name || ''), err);
                                pushToolMessage(c.id,
                                    Object.assign({ error: err.error || 'tool-error' }, err));
                                executeCalls(calls, i + 1);
                                return;
                            }
                            if (_handleImageResult(c, result)) {
                                safeEmit(onToolComplete, String(c.name || ''));
                                executeCalls(calls, i + 1);
                                return;
                            }
                            safeEmit(onToolComplete, String(c.name || ''));
                            pushToolMessage(c.id, result);
                            executeCalls(calls, i + 1);
                        });
                } catch (e) {
                    // defense in depth: registry already guards, this can't leak
                    safeEmit(onToolError, String(c.name || ''),
                        { error: 'tool-failed', message: String((e && e.message) || e) });
                    pushToolMessage(c.id, { error: 'tool-failed',
                                            message: String((e && e.message) || e) });
                    executeCalls(calls, i + 1);
                }
            };

            if (verdict === 'deny') {
                safeEmit(onToolError, String(c.name || ''), { error: 'permission-denied' });
                pushToolMessage(c.id, { error: 'permission-denied' });
                executeCalls(calls, i + 1);
                return;
            }
            if (verdict === 'confirm') {
                if (!requestConfirmation) {
                    safeEmit(onToolError, String(c.name || ''), { error: 'permission-denied' });
                    pushToolMessage(c.id, { error: 'permission-denied' }); // no dialog wired: fail-closed
                    executeCalls(calls, i + 1);
                    return;
                }
                requestConfirmation({
                    tool: String(c.name || ''),
                    args: parsed,
                    risk: toolMeta ? toolMeta.riskLevel : undefined
                }, approved => {
                    if (myGen !== gen) return; // cancelled/superseded while dialog open
                    if (!approved) {
                        pushToolMessage(c.id, { error: 'permission-denied' });
                        executeCalls(calls, i + 1);
                        return;
                    }
                    proceed();
                });
                return;
            }
            proceed();
        }

        function step() {
            if (myGen !== gen) return;
            if (steps >= maxSteps) { finish({ error: 'max-steps', steps: steps }); return; }
            steps++;
            safeEmit(onPhase, 'thinking');
            aiAsk(String(question == null ? '' : question), {
                messages: base,
                tools: toolDefs(),
                cancellable: cancellable
            }, (err, res) => {
                if (myGen !== gen) return;  // cancelled/superseded -> silent stop
                if (err) { finish(err, null); return; }
                if (!res.toolCalls || !res.toolCalls.length) {
                    finish(null, { answer: String(res.answer == null ? '' : res.answer) });
                    return;
                }
                // record the assistant tool_calls turn exactly as received:
                // the OpenAI protocol requires it before any role:'tool' reply
                base.push({
                    role: 'assistant',
                    content: String(res.answer == null ? '' : res.answer),
                    tool_calls: res.toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: { name: tc.name, arguments: tc.argsJson }
                    }))
                });
                executeCalls(res.toolCalls, 0);
            });
        }

        step();
    }

    // cancel(): terminates the whole active run — pending AI HTTP request and
    // in-flight tool work share the same cancellable; late callbacks are
    // dropped by the generation guard. No partial rendering ever happens.
    function cancel() {
        gen++;
        if (activeCancellable) { try { activeCancellable.cancel(); } catch (e) {} }
        activeCancellable = null;
    }

    function destroy() { cancel(); }

    return { run: run, cancel: cancel, destroy: destroy };
}

module.exports = { createAgentManager, AGENT_SYSTEM_PROMPT };
