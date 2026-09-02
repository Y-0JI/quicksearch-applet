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

const _exp = { createMockAiProvider, createAiProvider, normalizeResult, ALLOWED_TOOL };
try {
    const nr = require('./nineRouterProvider.js');
    _exp.createNineRouterProvider = nr.createNineRouterProvider;
    _exp.NineRouterProvider = nr.createNineRouterProvider;
    _exp.buildChatCompletionsUrl = nr.buildChatCompletionsUrl;
} catch (e) {}
module.exports = _exp;
