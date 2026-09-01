// ai/webSearchTool.js — normalized web search interface (AI-3A canonical contract)
// Canonical API (AI-3+ source of truth):
//   tool.search({ query, maxResults }, cancellable, onDone)
//   onDone(null, tool_result) where tool_result = { type:'tool_result', tool:'web_search', query, sources:[{id,title,url,snippet}] }
//   onDone(err) where err is tool_error as Error (err.type='tool_error', err.code, err.tool='web_search')
// Legacy overload exists ONLY for backward compatibility with AI-0/AI-2 tests and AISearchEngine dormant path:
//   tool.search("query", cancellable, onDone)  OR  tool.search("query", onDone)
//   onDone(null, Array)  — raw array [{title,url,snippet}], NOT tool_result
// Legacy must NOT be used for new AI-3B orchestration and must not gain new features.
// Contracts delegated to groundingTypes. No UI, no Cinnamon, no scraping.
// Backend injection: backend.search(query, maxResults, cancellable, cb) preferred; 3-arg legacy tolerated.

const Gt = (() => {
    try { return require('./groundingTypes.js'); } catch (e) { return null; }
})();

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function _sanitizeMessage(msg) {
    const s = String(msg || '').trim();
    if (!s) return 'Web search error';
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
    const lower = msg.toLowerCase();
    if (lower.includes('backend unavailable') || lower.includes('econnrefused') || lower.includes('enotfound')) {
        return Gt.createToolError('backend_unavailable', 'Backend unavailable');
    }
    return Gt.createToolError(fallbackCode || 'request_failed', msg || 'Web search error');
}

function _toCallbackError(toolError) {
    if (!Gt) {
        const e = new Error(toolError.message || 'Web search error');
        e.code = toolError.code;
        e.type = toolError.type;
        e.tool = toolError.tool;
        Object.assign(e, toolError);
        return e;
    }
    return Gt.toCallbackError(toolError);
}

function _normalizeResults(rawResults, maxResults) {
    if (!Gt) {
        const out = [];
        for (const r of (Array.isArray(rawResults) ? rawResults : [])) {
            if (!r || typeof r !== 'object') continue;
            if (typeof r.title !== 'string' || !r.title.trim()) continue;
            if (typeof r.url !== 'string' || !/^https?:\/\/.+/i.test(r.url.trim())) continue;
            out.push({ title: String(r.title).slice(0, 200), url: String(r.url).trim(), snippet: String(r.snippet || r.content || r.description || '').slice(0, 500) });
        }
        // legacy path still respects maxResults cap
        const max = typeof maxResults === 'number' && Number.isFinite(maxResults) ? Math.max(1, Math.min(10, Math.floor(maxResults))) : 5;
        return out.slice(0, max);
    }
    return Gt.normalizeSources(rawResults, maxResults);
}

// opts: { handler, backend, results|queue, errorAt }
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

        // Detect canonical vs legacy
        const isObjectRequest = requestOrQuery && typeof requestOrQuery === 'object' && !Array.isArray(requestOrQuery) && ('query' in requestOrQuery || 'maxResults' in requestOrQuery);
        const isContract = !!isObjectRequest;

        // Production fail-closed: canonical request requires Gt
        if (isContract && !Gt) {
            const toolErr = { type: 'tool_error', tool: 'web_search', code: 'invalid_response', message: 'Grounding contracts unavailable' };
            const e = new Error(toolErr.message);
            e.code = toolErr.code; e.type = toolErr.type; e.tool = toolErr.tool;
            Object.assign(e, toolErr);
            return onDone(e);
        }

        let query;
        let maxResults;

        if (isContract) {
            query = requestOrQuery.query;
            maxResults = requestOrQuery.maxResults;
        } else {
            query = requestOrQuery;
            maxResults = undefined;
        }

        let validated;
        if (Gt && typeof Gt.validateRequest === 'function' && isContract) {
            validated = Gt.validateRequest({ query, maxResults });
            if (validated.error) {
                return onDone(_toCallbackError(validated.error));
            }
            query = validated.query;
            maxResults = validated.maxResults;
        } else if (isContract) {
            // Gt missing but isContract already handled above (fail-closed)
            const q = String(query || '').trim();
            if (!q) {
                const e = new Error('Invalid search query');
                e.code = 'invalid_query'; e.type = 'tool_error'; e.tool = 'web_search';
                return onDone(e);
            }
            query = q;
            if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) maxResults = 5;
            maxResults = Math.max(1, Math.min(10, Math.floor(maxResults)));
        } else {
            // legacy path: tolerate string query; keep AI-0/AI-2 behavior
            // Note: legacy path validates only non-empty trim and does NOT enforce Gt maxResults canonical defaults beyond simple cap
            const q = String(query || '').trim();
            if (!q) {
                // legacy callers expect web_search_unavailable for empty, but spec prefers invalid_query
                // keep legacy code for backward compat; canonical callers never hit this branch
                const e = new Error('Web search unavailable');
                e.code = 'web_search_unavailable';
                return onDone(e);
            }
            query = q;
            if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) maxResults = 5;
            maxResults = Math.max(1, Math.min(10, Math.floor(maxResults)));
        }

        try {
            if (backend && typeof backend.search === 'function') {
                const expectsMax = backend.search.length >= 4;
                const cb = (err, rawResults) => {
                    if (_isCancelled(cancellable)) return;
                    if (err) {
                        if (err.code === 'cancelled' || (Gt && err.code === Gt.ERROR_CODES.cancelled)) return;
                        const mapped = _mapError(err, 'request_failed');
                        // legacy web_search_unavailable -> request_failed for spec, but keep code translation
                        let outErr = mapped;
                        if (Gt && err.code === 'web_search_unavailable') {
                            outErr = Gt.createToolError('request_failed', _sanitizeMessage(err.message) || 'Web search error');
                        } else if (!Gt && mapped.type === 'tool_error') {
                            // convert tool_error object to Error for legacy Gt-missing path
                            const e = new Error(mapped.message); e.code = mapped.code; e.type = mapped.type; e.tool = mapped.tool; Object.assign(e, mapped); outErr = e;
                        }
                        if (outErr && outErr.type === 'tool_error') return onDone(_toCallbackError(outErr));
                        // Gt missing fallback
                        const e = new Error(outErr.message || String(err.message || 'Web search error'));
                        e.code = outErr.code || err.code || 'request_failed';
                        if (outErr.type) { e.type = outErr.type; e.tool = outErr.tool; Object.assign(e, outErr); }
                        return onDone(e);
                    }
                    if (!Array.isArray(rawResults)) {
                        const mapped = Gt ? Gt.createToolError('invalid_response', 'Invalid response') : (() => { const e2 = new Error('Web search unavailable'); e2.code = 'web_search_unavailable'; return e2; })();
                        if (mapped.type === 'tool_error') return onDone(_toCallbackError(mapped));
                        const e2 = new Error('Web search unavailable'); e2.code = 'web_search_unavailable'; return onDone(e2);
                    }
                    const normalized = _normalizeResults(rawResults, maxResults);
                    if (isContract) {
                        // canonical path NEVER returns raw array; always tool_result
                        const toolResult = Gt ? Gt.createToolResult(query, normalized) : { type: 'tool_result', tool: 'web_search', query, sources: normalized };
                        return onDone(null, toolResult);
                    }
                    return onDone(null, normalized);
                };
                if (expectsMax) backend.search(query, maxResults, cancellable, cb);
                else backend.search(query, cancellable, cb);
                return;
            }

            handler(query, cancellable, (err, results) => {
                if (_isCancelled(cancellable)) return;
                if (err) {
                    if (err.code === 'cancelled') return;
                    const mapped = _mapError(err, 'request_failed');
                    let outErr;
                    if (!Gt) outErr = err;
                    else {
                        if (err.code === 'web_search_unavailable') {
                            outErr = Gt.createToolError('request_failed', _sanitizeMessage(err.message) || 'Web search error');
                        } else {
                            outErr = mapped;
                        }
                    }
                    if (outErr && outErr.type === 'tool_error') return onDone(_toCallbackError(outErr));
                    const e = new Error(outErr.message || outErr.code);
                    e.code = outErr.code || err.code || 'request_failed';
                    if (outErr.type) { e.type = outErr.type; e.tool = outErr.tool; Object.assign(e, outErr); }
                    else if (err.code) e.code = err.code;
                    return onDone(e);
                }
                if (!Array.isArray(results)) {
                    if (Gt) {
                        const mapped = Gt.createToolError('invalid_response', 'Invalid response');
                        return onDone(_toCallbackError(mapped));
                    }
                    const e2 = new Error('Web search unavailable');
                    e2.code = 'web_search_unavailable';
                    return onDone(e2);
                }
                const normalized = _normalizeResults(results, maxResults);
                if (isContract) {
                    const toolResult = Gt ? Gt.createToolResult(query, normalized) : { type: 'tool_result', tool: 'web_search', query, sources: normalized };
                    return onDone(null, toolResult);
                }
                return onDone(null, normalized);
            });
        } catch (e) {
            if (_isCancelled(cancellable)) return;
            const mapped = _mapError(e, 'request_failed');
            if (mapped.type === 'tool_error') return onDone(_toCallbackError(mapped));
            const out = new Error(mapped.message || String(e.message || 'Web search error'));
            out.code = mapped.code || e.code || 'request_failed';
            if (mapped.type) { out.type = mapped.type; out.tool = mapped.tool; Object.assign(out, mapped); }
            return onDone(out);
        }
    }

    return { search, __callCount: () => callCount, __backend: backend, __handler: handler };
}

function createWebSearchTool(opts) {
    // Production entry point — fail closed if canonical contracts unavailable.
    // Do NOT silently downgrade to legacy array behavior when groundingTypes is missing.
    if (!Gt) {
        const toolErr = { type: 'tool_error', tool: 'web_search', code: 'invalid_response', message: 'Grounding contracts unavailable' };
        return {
            search(requestOrQuery, cancellable, onDone) {
                if (typeof cancellable === 'function' && !onDone) { onDone = cancellable; cancellable = null; }
                if (!onDone || typeof onDone !== 'function') return;
                const e = new Error(toolErr.message);
                e.code = toolErr.code; e.type = toolErr.type; e.tool = toolErr.tool;
                Object.assign(e, toolErr);
                return onDone(e);
            }
        };
    }
    return createMockWebSearchTool(opts);
}

module.exports = { createMockWebSearchTool, createWebSearchTool };
