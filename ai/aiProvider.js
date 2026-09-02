// ai/aiProvider.js — normalized provider contract. Mock + 9router facade.
const ALLOWED_TOOL = 'web_search';

function normalizeResult(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'error', code: 'invalid_response', message: 'Invalid AI response' };
    if (raw.type === 'answer') {
        if (typeof raw.text !== 'string') return { type: 'error', code: 'invalid_response', message: 'Invalid AI response' };
        return { type: 'answer', text: raw.text };
    }
    if (raw.type === 'tool_call') {
        if (raw.tool !== ALLOWED_TOOL) return { type: 'error', code: 'unsupported_tool', message: 'Unsupported AI tool request' };
        const q = raw.arguments && raw.arguments.query;
        if (typeof q !== 'string' || !q.trim()) return { type: 'error', code: 'invalid_query', message: 'Invalid search query' };
        return { type: 'tool_call', tool: ALLOWED_TOOL, arguments: { query: q.trim() } };
    }
    return { type: 'error', code: 'invalid_response', message: 'Invalid AI response' };
}

function createMockAiProvider(opts) {
    opts = opts || {};
    let handler = opts.handler || null;
    let queue = Array.isArray(opts.responses) ? opts.responses.slice() : null;
    let callCount = 0;
    let errorAt = typeof opts.errorAt === 'number' ? opts.errorAt : -1;

    if (!handler && queue) {
        handler = (req, cb) => {
            if (callCount === errorAt) { callCount++; return cb(new Error('mock provider error')); }
            const raw = queue[callCount++];
            if (raw === undefined) return cb(new Error('mock queue exhausted'));
            cb(null, raw);
        };
    }
    if (!handler) {
        handler = (req, cb) => cb(null, { type: 'answer', text: 'mock answer for: ' + (req && req.query) });
    }

    function request(payload, cancellableOrCb, maybeCb) {
        let cb = cancellableOrCb;
        if (typeof maybeCb === 'function') cb = maybeCb;
        const req = payload && typeof payload === 'object' ? payload : { query: String(payload || '') };
        try {
            const maybe = handler(req, (err, raw) => {
                if (err) return cb(err);
                const norm = normalizeResult(raw);
                if (norm.type === 'error') {
                    const e = new Error(norm.message);
                    e.code = norm.code;
                    return cb(e);
                }
                cb(null, norm);
            });
            if (maybe && typeof maybe.then === 'function') {
                maybe.then(r => {
                    const norm = normalizeResult(r);
                    if (norm.type === 'error') { const e = new Error(norm.message); e.code = norm.code; return cb(e); }
                    cb(null, norm);
                }).catch(e => cb(e));
            }
        } catch (e) {
            cb(e);
        }
    }

    return { request, __callCount: () => callCount };
}

function createAiProvider(handler) {
    return createMockAiProvider({ handler });
}

// Streaming mock provider: simulates streaming SSE behavior for tests.
// opts.handler(payload, onEvent) — onEvent receives normalized stream events:
//   { type: 'start' }, { type: 'delta', text }, { type: 'tool_call', tool, arguments }, { type: 'complete', result }, { type: 'error', error }
// opts.chunks — array of text chunks (alternative to handler)
// opts.errorAt — index at which to emit error (alternative to handler)
// opts.requestHandler(payload, cb) — legacy non-streaming handler for first-leg tool_call detection;
//   when present, streamRequest will use it for non-grounded vs grounded routing (back-compat shim>
//   so that existing tests using requestHandler still work after engine switches to pure streaming.
function createMockStreamingAiProvider(opts) {
    opts = opts || {};
    let handler = opts.handler || null;
    let chunks = Array.isArray(opts.chunks) ? opts.chunks.slice() : null;
    let callCount = 0;
    let streamCallCount = 0;
    let errorAt = typeof opts.errorAt === 'number' ? opts.errorAt : -1;

    if (!handler && chunks) {
        handler = (payload, onEvent) => {
            if (streamCallCount === errorAt) {
                streamCallCount++;
                onEvent({ type: 'error', error: { code: 'provider_error', message: 'mock stream error' } });
                return;
            }
            onEvent({ type: 'start' });
            for (const chunk of chunks) {
                if (typeof chunk === 'string') {
                    onEvent({ type: 'delta', text: chunk });
                } else if (chunk && chunk.type === 'error') {
                    onEvent(chunk);
                    return;
                }
            }
            streamCallCount++;
            onEvent({ type: 'complete', result: { text: chunks.join(''), sources: [], grounded: false } });
        };
    }
    if (!handler) {
        handler = (payload, onEvent) => {
            const text = 'mock streaming answer for: ' + (payload && payload.query);
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: text });
            onEvent({ type: 'complete', result: { text, sources: [], grounded: false } });
        };
    }

    function isSecondLeg(payload) {
        return !!(payload && (payload.groundingContext || payload.groundingContextObj || payload.searchResults));
    }

    function streamRequest(payload, cancellableOrOnEvent, maybeOnEvent) {
        let onEvent = cancellableOrOnEvent;
        if (typeof maybeOnEvent === 'function') onEvent = maybeOnEvent;
        const req = payload && typeof payload === 'object' ? payload : { query: String(payload || '') };
        // Back-compat shim: if legacy requestHandler exists and this is first leg (no grounding),
        // let requestHandler decide tool_call vs answer to keep existing tests green while engine
        // is now pure-streaming.
        if (opts.requestHandler && !isSecondLeg(req)) {
            let requestResult = null;
            let requestError = null;
            try {
                opts.requestHandler(req, (err, raw) => {
                    if (err) requestError = err;
                    else requestResult = raw;
                });
            } catch (e) {
                requestError = e;
            }
            if (requestError) {
                const code = requestError.code || 'provider_error';
                onEvent({ type: 'error', error: { code, message: requestError.message || code } });
                return;
            }
            if (requestResult && requestResult.type === 'tool_call') {
                const norm = normalizeResult(requestResult);
                if (norm.type === 'error') {
                    onEvent({ type: 'error', error: { code: norm.code, message: norm.message } });
                    return;
                }
                // Emit tool_call without start/complete — engine suppresses first-leg extras
                onEvent({ type: 'tool_call', tool: norm.tool, arguments: norm.arguments });
                return;
            }
            if (requestResult && requestResult.type === 'answer') {
                // Fall through to streaming handler but use the answer text as chunks
                // This ensures direct answer via streaming path still works with legacy handler
                const text = requestResult.text || '';
                onEvent({ type: 'start' });
                if (text) onEvent({ type: 'delta', text: text });
                onEvent({ type: 'complete', result: { text, sources: [], grounded: false } });
                return;
            }
            // If requestHandler returned nothing conclusive, fall through to normal handler
        }
        try {
            handler(req, (evt) => {
                if (onEvent) onEvent(evt);
            });
        } catch (e) {
            if (onEvent) onEvent({ type: 'error', error: { code: 'provider_error', message: e.message } });
        }
    }

    // Non-streaming request: opts.requestHandler(payload, cb) for explicit non-streaming path.
    function request(payload, cancellableOrCb, maybeCb) {
        let cb = cancellableOrCb;
        if (typeof maybeCb === 'function') cb = maybeCb;
        const req = payload && typeof payload === 'object' ? payload : { query: String(payload || '') };
        if (opts.requestHandler) {
            try {
                opts.requestHandler(req, cb);
            } catch (e) {
                cb(e);
            }
            return;
        }
        // Fallback: run handler but only collect the complete event
        let result = null;
        let error = null;
        try {
            handler(req, (evt) => {
                if (evt.type === 'complete' && evt.result) {
                    result = { type: 'answer', text: evt.result.text };
                } else if (evt.type === 'tool_call') {
                    result = { type: 'tool_call', tool: evt.tool, arguments: evt.arguments };
                } else if (evt.type === 'error' && evt.error) {
                    error = new Error(evt.error.message);
                    error.code = evt.error.code;
                }
            });
        } catch (e) {
            error = e;
        }
        if (error) return cb(error);
        if (result) {
            const norm = normalizeResult(result);
            if (norm.type === 'error') { const e = new Error(norm.message); e.code = norm.code; return cb(e); }
            return cb(null, norm);
        }
        cb(null, { type: 'answer', text: '' });
    }

    return { request, streamRequest, __callCount: () => callCount };
}

const _exp = { createMockAiProvider, createMockStreamingAiProvider, createAiProvider, normalizeResult, ALLOWED_TOOL };
try {
    const nr = require('./nineRouterProvider.js');
    _exp.createNineRouterProvider = nr.createNineRouterProvider;
    _exp.NineRouterProvider = nr.createNineRouterProvider;
    _exp.buildChatCompletionsUrl = nr.buildChatCompletionsUrl;
} catch (e) {}
module.exports = _exp;
