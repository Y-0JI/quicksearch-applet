// ai/webSearchTool.js — normalized web search interface. Mock for Phase AI-0.
// No AI logic, no scraping, no URL fetch. Real backend plugs later without changing engine.
function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function _validateResult(r) {
    if (!r || typeof r !== 'object') return false;
    return typeof r.title === 'string' && typeof r.url === 'string' && /^https?:\/\/.+/i.test(r.url);
}

// handler: (query, cancellable, cb) => cb(err, results)
// results: [{title, url, snippet}]
function createMockWebSearchTool(opts) {
    opts = opts || {};
    let handler = opts.handler || null;
    let queue = Array.isArray(opts.results) ? opts.results.slice() : (Array.isArray(opts.queue) ? opts.queue.slice() : null);
    let callCount = 0;
    let errorAt = typeof opts.errorAt === 'number' ? opts.errorAt : -1;

    if (!handler && queue !== null) {
        handler = (query, cancellable, cb) => {
            if (callCount === errorAt) { callCount++; return cb(new Error('mock web search error')); }
            const item = queue[callCount++];
            if (item instanceof Error) return cb(item);
            if (item === undefined) return cb(new Error('mock webSearch queue exhausted'));
            // item can be array or single
            if (Array.isArray(item)) return cb(null, item);
            return cb(null, [item]);
        };
    }
    if (!handler) {
        handler = (query, cancellable, cb) => {
            const q = String(query || '').trim() || 'mock';
            cb(null, [{ title: 'Mock result for ' + q, url: 'https://example.com/search?q=' + encodeURIComponent(q), snippet: 'snippet for ' + q }]);
        };
    }

    function search(query, cancellable, onDone) {
        // tolerate (query, onDone) overload
        if (typeof cancellable === 'function' && !onDone) { onDone = cancellable; cancellable = null; }
        if (_isCancelled(cancellable)) return;
        const q = String(query || '').trim();
        if (!q) {
            const e = new Error('Web search unavailable');
            e.code = 'web_search_unavailable';
            return onDone(e);
        }
        try {
            handler(q, cancellable, (err, results) => {
                if (_isCancelled(cancellable)) return;
                if (err) {
                    if (!err.code) err.code = 'web_search_unavailable';
                    return onDone(err);
                }
                if (!Array.isArray(results)) {
                    const e2 = new Error('Web search unavailable');
                    e2.code = 'web_search_unavailable';
                    return onDone(e2);
                }
                // filter invalid entries but preserve valid ones (like sourceFormatter)
                const out = [];
                for (const r of results) if (_validateResult(r)) out.push({ title: String(r.title).slice(0,200), url: String(r.url), snippet: String(r.snippet || r.content || r.description || '').slice(0,500) });
                onDone(null, out);
            });
        } catch (e) {
            if (!e.code) e.code = 'web_search_unavailable';
            onDone(e);
        }
    }

    return { search, __callCount: () => callCount };
}

function createWebSearchTool(opts) { return createMockWebSearchTool(opts); }

module.exports = { createMockWebSearchTool, createWebSearchTool };
