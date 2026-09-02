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
//   { type: 'start' }, { type: 'delta', text }, { type: 'complete', result }, { type: 'error', error }
// opts.chunks — array of text chunks (alternative to handler)
// opts.errorAt — index at which to emit error (alternative to handler)
function createMockStreamingAiProvider(opts) {
    opts = opts || {};
    let handler = opts.handler || null;
    let chunks = Array.isArray(opts.chunks) ? opts.chunks.slice() : null;
    let callCount = 0;
    let errorAt = typeof opts.errorAt === 'number' ? opts.errorAt : -1;

    if (!handler && chunks) {
        handler = (payload, onEvent) => {
            if (callCount === errorAt) {
                callCount++;
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
            callCount++;
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

    function streamRequest(payload, cancellableOrOnEvent, maybeOnEvent) {
        let onEvent = cancellableOrOnEvent;
        if (typeof maybeOnEvent === 'function') onEvent = maybeOnEvent;
        const req = payload && typeof payload === 'object' ? payload : { query: String(payload || '') };
        try {
            handler(req, (evt) => {
                if (onEvent) onEvent(evt);
            });
        } catch (e) {
            if (onEvent) onEvent({ type: 'error', error: { code: 'provider_error', message: e.message } });
        }
    }

    // Non-streaming request: opts.requestHandler(payload, cb) for explicit non-streaming path.
    // If no requestHandler, falls back to converting streaming handler output.
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
                } else if (evt.type === 'error' && evt.error) {
                    error = new Error(evt.error.message);
                    error.code = evt.error.code;
                }
            });
        } catch (e) {
            error = e;
        }
        if (error) return cb(error);
        if (result) return cb(null, result);
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
