// ai/webSearchTool.js — normalized web search interface (AI-3A contract)
// Contracts delegated to groundingTypes. No UI, no Cinnamon, no scraping.
// Supports both contract request {query, maxResults} and legacy string query for AI-2 engine compat.
const Gt = (() => {
    try { return require('./groundingTypes.js'); } catch (e) { return null; }
})();

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function _validateResult(r) {
    if (!r || typeof r !== 'object') return false;
    if (Gt && typeof Gt.isValidHttpUrl === 'function') return Gt.isValidHttpUrl(r.url) && typeof r.title === 'string' && r.title.trim().length > 0;
    return typeof r.title === 'string' && typeof r.url === 'string' && /^https?:\/\/.+/i.test(r.url);
}

function _sanitizeMessage(msg) {
    const s = String(msg || '').trim();
    if (!s) return 'Web search error';
    // cap length, strip stack traces
    return s.split('\n')[0].slice(0, 200);
}

function _mapError(err, fallbackCode) {
    if (!Gt) {
        const e = new Error(_sanitizeMessage(err && err.message));
        e.code = (err && err.code) ? err.code : (fallbackCode || 'request_failed');
        return e;
    }
    if (err && err.type === 'tool_error') return err;
    if (!err) return Gt.createToolError(fallbackCode || 'request_failed', 'Web search error');
    const code = err.code;
    const msg = _sanitizeMessage(err.message);
    if (code === 'invalid_query' || code === 'backend_unavailable' || code === 'request_failed' || code === 'cancelled' || code === 'invalid_response') {
        return Gt.createToolError(code, msg);
    }
    // treat generic backend error as request_failed unless it looks like backend_unavailable
    const lower = msg.toLowerCase();
    if (lower.includes('backend unavailable') || lower.includes('econnrefused') || lower.includes('enotfound')) {
        return Gt.createToolError('backend_unavailable', 'Backend unavailable');
    }
    return Gt.createToolError(fallbackCode || 'request_failed', msg || 'Web search error');
}

function _normalizeResults(rawResults, maxResults) {
    if (!Gt) {
        const out = [];
        for (const r of (Array.isArray(rawResults) ? rawResults : [])) if (_validateResult(r)) out.push({ title: String(r.title).slice(0, 200), url: String(r.url).trim(), snippet: String(r.snippet || r.content || r.description || '').slice(0, 500) });
        return out;
    }
    return Gt.normalizeSources(rawResults, maxResults);
}

// handler: (query, cancellable, cb) => cb(err, results)
// results: [{title, url, snippet}]
// Also supports backend: { search(query, maxResults, cancellable, cb) }
function createMockWebSearchTool(opts) {
    opts = opts || {};
    let handler = opts.handler || null;
    let backend = opts.backend || null;
    let queue = Array.isArray(opts.results) ? opts.results.slice() : (Array.isArray(opts.queue) ? opts.queue.slice() : null);
    let callCount = 0;
    let errorAt = typeof opts.errorAt === 'number' ? opts.errorAt : -1;

    if (!handler && !backend && queue !== null) {
        handler = (query, cancellable, cb) => {
            if (callCount === errorAt) { callCount++; return cb(new Error('mock web search error')); }
            const item = queue[callCount++];
            if (item instanceof Error) return cb(item);
            if (item === undefined) return cb(new Error('mock webSearch queue exhausted'));
            if (Array.isArray(item)) return cb(null, item);
            return cb(null, [item]);
        };
    }
    if (!handler && !backend) {
        handler = (query, cancellable, cb) => {
            const q = String(query || '').trim() || 'mock';
            cb(null, [{ title: 'Mock result for ' + q, url: 'https://example.com/search?q=' + encodeURIComponent(q), snippet: 'snippet for ' + q }]);
        };
    }

    function search(requestOrQuery, cancellable, onDone) {
        if (typeof cancellable === 'function' && !onDone) { onDone = cancellable; cancellable = null; }
        if (!onDone || typeof onDone !== 'function') return;
        if (_isCancelled(cancellable)) return;

        let isContract = false;
        let query;
        let maxResults;

        if (requestOrQuery && typeof requestOrQuery === 'object' && !Array.isArray(requestOrQuery) && ('query' in requestOrQuery || 'maxResults' in requestOrQuery)) {
            isContract = true;
            query = requestOrQuery.query;
            maxResults = requestOrQuery.maxResults;
        } else {
            query = requestOrQuery;
            maxResults = undefined;
        }

        let validated;
        if (Gt && typeof Gt.validateRequest === 'function') {
            validated = Gt.validateRequest({ query, maxResults });
            if (validated.error) {
                const toolErr = validated.error;
                // make it Error-like for legacy callers that check err.code
                const e = new Error(toolErr.message);
                e.code = toolErr.code;
                e.type = toolErr.type;
                e.tool = toolErr.tool;
                e.message = toolErr.message;
                // contract callers expect tool_error object; pass as err but also carry type
                // For contract mode, spec resolves to tool_error; we emit via err param so both legacy and contract can check.
                return onDone(Object.assign(e, toolErr));
            }
            query = validated.query;
            maxResults = validated.maxResults;
        } else {
            const q = String(query || '').trim();
            if (!q) {
                const e = new Error('Web search unavailable');
                e.code = 'web_search_unavailable';
                return onDone(e);
            }
            query = q;
            if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) maxResults = 5;
            maxResults = Math.max(1, Math.min(10, Math.floor(maxResults)));
        }

        // dispatch to backend or handler
        try {
            if (backend && typeof backend.search === 'function') {
                // backend.search may have sig (query, maxResults, cancellable, cb) or (query, cancellable, cb)
                const expectsMax = backend.search.length >= 4;
                const cb = (err, rawResults) => {
                    if (_isCancelled(cancellable)) return;
                    if (err) {
                        if (_isCancelled(cancellable)) return;
                        // cancelled error should not deliver active result
                        if (err.code === 'cancelled' || (Gt && err.code === Gt.ERROR_CODES.cancelled)) return;
                        const mapped = _mapError(err, 'request_failed');
                        // attach code for engine normalization
                        const e = new Error(mapped.message);
                        e.code = mapped.code;
                        e.type = mapped.type;
                        e.tool = mapped.tool;
                        Object.assign(e, mapped);
                        // for contract mode, also return tool_error via err
                        return onDone(e);
                    }
                    if (!Array.isArray(rawResults)) {
                        const mapped = Gt ? Gt.createToolError('invalid_response', 'Invalid response') : (() => { const e2 = new Error('Web search unavailable'); e2.code = 'web_search_unavailable'; return e2; })();
                        if (mapped.type === 'tool_error') {
                            const e2 = new Error(mapped.message); e2.code = mapped.code; e2.type = mapped.type; e2.tool = mapped.tool; Object.assign(e2, mapped);
                            return onDone(e2);
                        }
                        const e2 = new Error('Web search unavailable'); e2.code = 'web_search_unavailable'; return onDone(e2);
                    }
                    const normalized = _normalizeResults(rawResults, maxResults);
                    if (isContract && Gt) {
                        const toolResult = Gt.createToolResult(query, normalized);
                        return onDone(null, toolResult);
                    }
                    return onDone(null, normalized);
                };
                if (expectsMax) backend.search(query, maxResults, cancellable, cb);
                else backend.search(query, cancellable, cb);
                return;
            }

            // handler path
            handler(query, cancellable, (err, results) => {
                if (_isCancelled(cancellable)) return;
                if (err) {
                    if (err.code === 'cancelled') return;
                    const mapped = _mapError(err, 'request_failed');
                    // map web_search_unavailable legacy to request_failed? keep legacy code for engine compat
                    // engine expects web_search_unavailable for its _normalizeWebError; but spec wants request_failed/backend_unavailable
                    // Support both: if legacy mapping was web_search_unavailable, map to request_failed unless contract explicitly wants backend_unavailable
                    let outErr;
                    if (!Gt) outErr = err;
                    else {
                        // preserve original web_search_unavailable as request_failed/backend_unavailable for spec
                        if (err.code === 'web_search_unavailable') {
                            outErr = Gt.createToolError('request_failed', _sanitizeMessage(err.message) || 'Web search error');
                        } else {
                            outErr = mapped;
                        }
                    }
                    const e = new Error(outErr.message || outErr.code);
                    e.code = outErr.code || err.code || 'request_failed';
                    if (outErr.type) { e.type = outErr.type; e.tool = outErr.tool; Object.assign(e, outErr); }
                    else if (err.code) e.code = err.code;
                    return onDone(e);
                }
                if (!Array.isArray(results)) {
                    if (Gt) {
                        const mapped = Gt.createToolError('invalid_response', 'Invalid response');
                        const e2 = new Error(mapped.message); e2.code = mapped.code; e2.type = mapped.type; e2.tool = mapped.tool; Object.assign(e2, mapped);
                        return onDone(e2);
                    }
                    const e2 = new Error('Web search unavailable');
                    e2.code = 'web_search_unavailable';
                    return onDone(e2);
                }
                const normalized = _normalizeResults(results, maxResults);
                if (isContract && Gt) {
                    const toolResult = Gt.createToolResult(query, normalized);
                    return onDone(null, toolResult);
                }
                return onDone(null, normalized);
            });
        } catch (e) {
            if (_isCancelled(cancellable)) return;
            const mapped = _mapError(e, 'request_failed');
            const out = new Error(mapped.message || String(e.message || 'Web search error'));
            out.code = mapped.code || e.code || 'request_failed';
            if (mapped.type) { out.type = mapped.type; out.tool = mapped.tool; Object.assign(out, mapped); }
            return onDone(out);
        }
    }

    return { search, __callCount: () => callCount, __backend: backend, __handler: handler };
}

function createWebSearchTool(opts) { return createMockWebSearchTool(opts); }

module.exports = { createMockWebSearchTool, createWebSearchTool };
