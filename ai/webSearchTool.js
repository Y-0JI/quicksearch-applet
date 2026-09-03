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
// Fail-closed scope: canonical AI-3+ production path (object request → tool_result/tool_error) is fail-closed
// when groundingTypes is unavailable (returns tool_error invalid_response). Legacy string-query path in
// createMockWebSearchTool remains available for AI-0/AI-2 test compatibility and is intentionally not fail-closed.
// Canonical callback errors: pure {type:'tool_error',...} → Gt.toCallbackError() → Error instance is the
// single canonical callback boundary. Legacy fallbacks construct plain Error directly and never enrich the
// canonical AI-3 path.

const Gt = (() => {
    try { return require('./ai/groundingTypes.js'); } catch (e) {}
    try { return require('./groundingTypes.js'); } catch (e) {}
    try { return require('ai/groundingTypes.js'); } catch (e) { return null; }
})();

let Gio = null, GLib = null, Soup = null;
try { Gio = require('gi.Gio'); } catch (e) {}
try { GLib = require('gi.GLib'); } catch (e) {}
try { Soup = require('gi.Soup'); } catch (e) {}
function __setGioSoupForTest(g, gl, s) { Gio = g; GLib = gl; Soup = s; }
const DEFAULT_TIMEOUT_MS = 4000;
function _scheduleTimeout(ms, fn) {
    if (GLib && typeof GLib.timeout_add === 'function') return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
    return setTimeout(fn, ms);
}
function _cancelTimeout(id) {
    if (!id) return;
    if (GLib && typeof GLib.source_remove === 'function') { try { GLib.source_remove(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} } }
    else try { clearTimeout(id); } catch (e) {}
}

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function _isGioCancellable(c) {
    if (!c || !Gio || !Gio.Cancellable) return false;
    try {
        if (typeof c.connect === 'function' && typeof c.cancel === 'function' && typeof c.is_cancelled === 'function') {
            try { if (c instanceof Gio.Cancellable) return true; } catch (e) {}
            if (typeof c.disconnect === 'function') return true;
        }
    } catch (e) {}
    return false;
}
function _newNativeCancellable() {
    if (Gio && Gio.Cancellable) {
        try { return new Gio.Cancellable(); } catch (e) { return null; }
    }
    return null;
}
function _bridgeAppToNative(appCancellable, nativeCancellable) {
    if (!appCancellable || !nativeCancellable) return { cleanup: function(){}, native: nativeCancellable };
    try { if (typeof appCancellable.is_cancelled === 'function' && appCancellable.is_cancelled()) { try { nativeCancellable.cancel(); } catch (e) {} } } catch (e) {}
    if (_isGioCancellable(appCancellable)) return { cleanup: function(){}, native: appCancellable };
    if (typeof appCancellable.connect === 'function') {
        try {
            const id = appCancellable.connect('cancelled', function() { try { nativeCancellable.cancel(); } catch (e) {} });
            return { cleanup: function(){ try { if (typeof appCancellable.disconnect === 'function') appCancellable.disconnect(id); } catch (e) {} }, native: nativeCancellable };
        } catch (e) {}
    }
    if (typeof appCancellable.cancel === 'function') {
        try {
            const orig = appCancellable.cancel.bind(appCancellable);
            const originalCancel = orig;
            appCancellable.cancel = function bridgedCancel() {
                let r; try { r = originalCancel(); } catch (e) {}
                try { nativeCancellable.cancel(); } catch (e2) {}
                return r;
            };
            return { cleanup: function(){ try { appCancellable.cancel = originalCancel; } catch (e) {} }, native: nativeCancellable };
        } catch (e) {}
    }
    return { cleanup: function(){}, native: nativeCancellable };
}
function _resolveSoupCancellable(appCancellable) {
    if (!Gio || !Gio.Cancellable) return { soupCancellable: appCancellable || null, bridgeCleanup: function(){} };
    if (_isGioCancellable(appCancellable)) return { soupCancellable: appCancellable, bridgeCleanup: function(){} };
    if (appCancellable) {
        const native = _newNativeCancellable();
        if (!native) return { soupCancellable: appCancellable, bridgeCleanup: function(){} };
        const bridged = _bridgeAppToNative(appCancellable, native);
        return { soupCancellable: bridged.native, bridgeCleanup: bridged.cleanup };
    }
    const standalone = _newNativeCancellable();
    return { soupCancellable: standalone, bridgeCleanup: function(){} };
}

function _sanitizeMessage(msg) {
    const s = String(msg || '').trim();
    if (!s) return 'Web search error';
    return s.split('\n')[0].slice(0, 200);
}

function _mapError(err, fallbackCode) {
    function _attachStage(target, source) {
        try {
            if (source && (source.stage || source._stage)) {
                target.stage = source.stage || source._stage;
                target._stage = source.stage || source._stage;
            }
            if (source && source.status != null) target.status = source.status;
            if (source && source.httpStatus != null) target.httpStatus = source.httpStatus;
        } catch (e) {}
        return target;
    }
    if (!Gt) {
        const e = new Error(_sanitizeMessage(err && err.message));
        e.code = (err && err.code) ? err.code : (fallbackCode || 'request_failed');
        return _attachStage(e, err);
    }
    if (err && err.type === 'tool_error') return err;
    if (!err) return Gt.createToolError(fallbackCode || 'request_failed', 'Web search error');
    const code = err.code;
    const msg = _sanitizeMessage(err.message);
    if (code === 'invalid_query' || code === 'backend_unavailable' || code === 'request_failed' || code === 'cancelled' || code === 'invalid_response') {
        const te = Gt.createToolError(code, msg);
        return _attachStage(te, err);
    }
    const lower = msg.toLowerCase();
    if (lower.includes('backend unavailable') || lower.includes('econnrefused') || lower.includes('enotfound')) {
        const te = Gt.createToolError('backend_unavailable', 'Backend unavailable');
        return _attachStage(te, err);
    }
    const te = Gt.createToolError(fallbackCode || 'request_failed', msg || 'Web search error');
    return _attachStage(te, err);
}

function _toCallbackError(toolError) {
    function _attachStage(target, source) {
        try {
            if (source && (source.stage || source._stage)) {
                target.stage = source.stage || source._stage;
                target._stage = source.stage || source._stage;
            }
            if (source && source.status != null) target.status = source.status;
            if (source && source.httpStatus != null) target.httpStatus = source.httpStatus;
        } catch (e) {}
        return target;
    }
    if (!Gt) {
        const e = new Error(toolError.message || 'Web search error');
        e.code = toolError.code;
        e.type = toolError.type;
        e.tool = toolError.tool;
        Object.assign(e, toolError);
        return _attachStage(e, toolError);
    }
    const e = Gt.toCallbackError(toolError);
    return _attachStage(e, toolError);
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

function _defaultHttpGet(url, cancellable, cb) {
    try {
        if (Soup && typeof Soup.Session !== 'undefined') {
            let session = new Soup.Session();
            try { session.timeout = Math.ceil(DEFAULT_TIMEOUT_MS / 1000); } catch (e) {}
            const msg = Soup.Message.new('GET', url);
            if (!msg) return cb(new Error('bad-url'));
            try { msg.request_headers.append('User-Agent', 'Mozilla/5.0 QuickSearch'); } catch (e) {}
            const resolved = _resolveSoupCancellable(cancellable);
            const soupCancellable = resolved.soupCancellable;
            const bridgeCleanup = resolved.bridgeCleanup;
            session.send_and_read_async(msg, GLib ? GLib.PRIORITY_DEFAULT : 0, soupCancellable, (sess, res) => {
                try { bridgeCleanup(); } catch (e) {}
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const text = new TextDecoder().decode(bytes.get_data());
                    let status = 0;
                    try {
                        if (typeof msg.get_status === 'function') status = msg.get_status();
                        else if (typeof msg.get_status_code === 'function') status = msg.get_status_code();
                        else if (typeof msg.status_code === 'number') status = msg.status_code;
                    } catch (e) {}
                    if (status >= 400) {
                        const ct = (() => {
                            try {
                                if (msg.response_headers && typeof msg.response_headers.get_one === 'function') {
                                    return msg.response_headers.get_one('Content-Type') || '';
                                }
                                if (typeof msg.get_response_headers === 'function') {
                                    const h = msg.get_response_headers();
                                    if (h && typeof h.get_one === 'function') return h.get_one('Content-Type') || '';
                                }
                            } catch (e) {}
                            return '';
                        })();
                        const e = new Error('HTTP ' + status);
                        e.status = status;
                        e.httpStatus = status;
                        e.bodyText = text;
                        e.contentType = ct;
                        e.stage = 'web_search_request';
                        e._stage = 'web_search_request';
                        return cb(e);
                    }
                    cb(null, text);
                } catch (e) { cb(e); }
            });
            return;
        }
        if (typeof fetch === 'function') {
            const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            let timeoutId = null;
            if (ctrl) timeoutId = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, DEFAULT_TIMEOUT_MS);
            const init = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 QuickSearch' } };
            if (ctrl) init.signal = ctrl.signal;
            fetch(url, init).then(r => r.text().then(t => {
                if (timeoutId) clearTimeout(timeoutId);
                if (!r.ok) {
                    const e = new Error('HTTP ' + r.status);
                    e.status = r.status;
                    e.httpStatus = r.status;
                    try { e.contentType = r.headers.get('Content-Type') || ''; } catch (e2) { e.contentType = ''; }
                    e.bodyText = t;
                    e.stage = 'web_search_request';
                    e._stage = 'web_search_request';
                    if (r.status === 429) e.code = 'backend_unavailable';
                    return cb(e);
                }
                cb(null, t);
            })).catch(e => {
                if (timeoutId) clearTimeout(timeoutId);
                cb(e);
            });
            return;
        }
        cb(new Error('no http transport'));
    } catch (e) { cb(e); }
}

function _parseSearxngJsonForSources(dataStr) {
    try {
        const data = JSON.parse(dataStr);
        const items = (data && data.results) || [];
        const out = [];
        for (const it of items) {
            if (!it || !it.url || !/^https?:\/\//.test(it.url)) continue;
            out.push({ title: String(it.title || '').slice(0, 200), url: String(it.url).trim(), snippet: String(it.content || it.snippet || '').slice(0, 500) });
            if (out.length >= 10) break;
        }
        return out;
    } catch (e) { throw e; }
}

function _parseSearxngHtmlForSources(html) {
    const clean = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(Number(n))).replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    const out = [];
    const htmlStr = html || '';
    const pushValid = (title, url, snippet) => {
        if (!url || !/^https?:\/\//.test(url) || /^https?:\/\/127\.0\.0\.1/.test(url) || /^https?:\/\/localhost/.test(url)) return;
        if (url.includes('searx.space') || url.includes('github.com/searxng')) return;
        if (!title || title.length < 3) return;
        if (/^javascript:/i.test(url) || /^#/.test(url)) return;
        out.push({ title: title.slice(0, 200), url: url.trim(), snippet: String(snippet||'').slice(0, 500) });
    };
    const articleRe = /<article[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let am;
    while ((am = articleRe.exec(htmlStr)) !== null && out.length < 10) {
        const block = am[1];
        const h3a = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!h3a) continue;
        const url = h3a[1];
        const title = clean(h3a[2]);
        let snippet = '';
        const p = /<p[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (p) snippet = clean(p[1]);
        if (!snippet) {
            const p2 = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
            if (p2) snippet = clean(p2[1]);
        }
        pushValid(title, url, snippet);
    }
    if (out.length > 0) return out.slice(0, 10);
    const divRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let dm;
    while ((dm = divRe.exec(htmlStr)) !== null && out.length < 10) {
        const block = dm[1];
        const a = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!a) continue;
        const url = a[1];
        const title = clean(a[2]);
        let snippet = '';
        const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (p) snippet = clean(p[1]);
        pushValid(title, url, snippet);
    }
    if (out.length > 0) return out.slice(0, 10);
    const genericRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]{3,}?)<\/a>/gi;
    let gm;
    const seen = new Set();
    while ((gm = genericRe.exec(htmlStr)) !== null && out.length < 10) {
        const url = gm[1];
        if (seen.has(url)) continue;
        seen.add(url);
        if (url.includes('127.0.0.1') || url.includes('searx.space') || url.includes('github.com/searxng')) continue;
        const title = clean(gm[2]);
        if (title.length < 5 || title.toLowerCase().includes('searxng') || title.toLowerCase().includes('about') || title.toLowerCase().includes('preferences')) continue;
        let snippet = '';
        const after = htmlStr.slice(gm.index, gm.index + 2000);
        const p = /<p[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(after);
        if (p) snippet = clean(p[1]);
        pushValid(title, url, snippet);
    }
    return out.slice(0, 10);
}

function _parseGoogleSerperForSources(dataStr) {
    const data = JSON.parse(dataStr);
    const items = (data && data.organic) || [];
    const out = [];
    for (const it of items) {
        if (!it || !it.link || !/^https?:\/\//.test(it.link)) continue;
        out.push({ title: String(it.title || '').slice(0, 200), url: String(it.link).trim(), snippet: String(it.snippet || '').slice(0, 500) });
        if (out.length >= 10) break;
    }
    return out;
}

function _parseBingHtmlForSources(html) {
    const clean = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(Number(n))).replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    const out = [];
    const blockRe = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let bm;
    while ((bm = blockRe.exec(html || '')) !== null && out.length < 10) {
        const block = bm[1];
        const h2a = /<h2[^>]*>\s*<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!h2a) continue;
        const url = h2a[1];
        const title = clean(h2a[2]);
        if (!url || !/^https?:\/\//.test(url) || !title) continue;
        let snippet = '';
        const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (p) snippet = clean(p[1]).slice(0, 500);
        out.push({ title: title.slice(0, 200), url, snippet });
    }
    return out;
}

function _parseDdgHtmlForSources(html) {
    const clean = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(Number(n))).replace(/&[a-z]+;/gi,' ').replace(/\s+/g,' ').trim();
    const realUrl = href => {
        const m = /\/l\/\?uddg=([^&]+)/.exec(href || '');
        if (m) { try { return decodeURIComponent(m[1]); } catch (e) {} }
        return /^https?:\/\//.test(href || '') ? href : '';
    };
    const out = [];
    const htmlStr = html || '';
    const blockRe = /<div\s+class="(?:result|web-result)[^"]*">([\s\S]*?)<\/div>/gi;
    let bm;
    while ((bm = blockRe.exec(htmlStr)) !== null && out.length < 10) {
        const block = bm[1];
        const anchorRe = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let am, title='', url='';
        while ((am = anchorRe.exec(block)) !== null) {
            const href = am[1];
            const text = clean(am[2]);
            const decoded = realUrl(href);
            if (decoded && text.length > 2) { title = text; url = decoded; break; }
        }
        if (!url || !/^https?:\/\//.test(url)) continue;
        let snippet = '';
        const snip = /<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (snip) snippet = clean(snip[1]).slice(0, 500);
        out.push({ title: title.slice(0, 200), url, snippet });
    }
    if (out.length === 0) {
        const flatRe = /<a\s+class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const snippets = [...htmlStr.matchAll(/<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)].map(m=>clean(m[1]));
        let idx=0, fm;
        while ((fm = flatRe.exec(htmlStr)) !== null && out.length < 10) {
            const url = realUrl(fm[1]);
            if (!/^https?:\/\//.test(url)) continue;
            out.push({ title: clean(fm[2]).slice(0, 200), url, snippet: (snippets[idx]||'').slice(0, 500) });
            idx++;
        }
    }
    return out;
}

function _createProductionBackend(config) {
    config = config || {};
    const rawEngine = String(config.engine || 'ddgo').toLowerCase();
    const engine = rawEngine === 'ddgo' ? 'ddgo' : rawEngine === 'duckduckgo' ? 'ddgo' : rawEngine;
    const searxngUrl = String(config.searxngUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const googleApiKey = String(config.googleApiKey || config.webSearchApiKey || '');
    const injectedGet = typeof config.httpGet === 'function' ? config.httpGet : null;
    const injectedPost = typeof config.httpPost === 'function' ? config.httpPost : null;
    const doGet = injectedGet || _defaultHttpGet;
    const doPost = injectedPost || null;
    return {
        search(query, maxResults, cancellable, cb) {
            if (typeof maxResults === 'function' && !cb) { cb = maxResults; maxResults = 5; }
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            const q = String(query || '').trim();
            if (!q) {
                const e = new Error('Invalid search query');
                e.code = 'invalid_query';
                return cb(e);
            }
            const max = typeof maxResults === 'number' && Number.isFinite(maxResults) ? Math.max(1, Math.min(10, Math.floor(maxResults))) : 5;
            if (engine === 'searxng') {
                const urlJson = searxngUrl + '/search?q=' + encodeURIComponent(q) + '&format=json';
                const urlHtml = searxngUrl + '/search?q=' + encodeURIComponent(q);
                let done = false;
                let tid = _scheduleTimeout(DEFAULT_TIMEOUT_MS, () => {
                    if (done) return;
                    done = true;
                    const e = new Error('SearXNG request timeout');
                    e.code = 'backend_unavailable';
                    e.stage = 'web_search_request';
                    e._stage = 'web_search_request';
                    cb(e);
                });
                const tryHtmlFallback = (origErr, origDataStr) => {
                    let htmlDone = false;
                    let htmlTid = _scheduleTimeout(DEFAULT_TIMEOUT_MS, () => {
                        if (htmlDone) return;
                        htmlDone = true;
                        const status = (origErr && (origErr.status || origErr.httpStatus)) || 0;
                        const ct = (origErr && origErr.contentType) || 'text/html';
                        const e = new Error('SearXNG JSON forbidden (HTTP ' + (status || 403) + '), HTML fallback timeout. Expected application/json got ' + (ct || 'text/html'));
                        e.code = 'invalid_response';
                        e.stage = 'web_search_request';
                        e._stage = 'web_search_request';
                        e.httpStatus = status;
                        e.status = status;
                        cb(e);
                    });
                    doGet(urlHtml, cancellable, (hErr, hDataStr) => {
                        if (htmlDone) return;
                        htmlDone = true;
                        _cancelTimeout(htmlTid);
                        if (_isCancelled(cancellable)) return;
                        if (hErr) {
                            const status = (hErr.status || hErr.httpStatus) || (origErr && (origErr.status || origErr.httpStatus)) || 0;
                            const e = new Error('SearXNG JSON forbidden (HTTP ' + (status || 403) + '), HTML fallback failed: ' + (hErr.message || 'request failed'));
                            e.code = 'invalid_response';
                            e.stage = 'web_search_request';
                            e._stage = 'web_search_request';
                            e.httpStatus = status;
                            e.status = status;
                            return cb(e);
                        }
                        try {
                            let raw = _parseSearxngHtmlForSources(hDataStr);
                            if (raw.length === 0) {
                                const status = (origErr && (origErr.status || origErr.httpStatus)) || 0;
                                // SearXNG HTML returned 200 but no parseable results (e.g., "Sorry! No results found." dialog). Fallback to DDG HTML which is more stable.
                                const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
                                let ddgDone = false;
                                let ddgTid = _scheduleTimeout(DEFAULT_TIMEOUT_MS, () => {
                                    if (ddgDone) return; ddgDone = true;
                                    const e = new Error('SearXNG HTML fallback returned no results (JSON HTTP ' + (status || 403) + ' Expected application/json Got text/html) Parser searxng_html Extracted 0');
                                    e.code = 'request_failed';
                                    e.stage = 'web_search_request';
                                    e._stage = 'web_search_request';
                                    e.httpStatus = status;
                                    e.status = status;
                                    e.backend = 'searxng';
                                    e.contentType = 'text/html';
                                    return cb(e);
                                });
                                doGet(ddgUrl, cancellable, (ddgErr, ddgHtml) => {
                                    if (ddgDone) return; ddgDone = true; _cancelTimeout(ddgTid);
                                    if (_isCancelled(cancellable)) return;
                                    if (ddgErr) {
                                        const e = new Error('SearXNG HTML fallback returned no results (JSON HTTP ' + (status || 403) + ' Expected application/json Got text/html) DDG fallback failed: ' + (ddgErr.message||''));
                                        e.code = 'request_failed';
                                        e.stage = 'web_search_request';
                                        e._stage = 'web_search_request';
                                        e.httpStatus = status;
                                        e.status = status;
                                        e.backend = 'searxng';
                                        return cb(e);
                                    }
                                    try {
                                        const ddgRaw = _parseDdgHtmlForSources(ddgHtml);
                                        if (ddgRaw.length === 0) {
                                            const e = new Error('SearXNG HTML fallback returned no results (JSON HTTP ' + (status || 403) + ' Expected application/json Got text/html) Parser searxng_html Extracted 0 DDG fallback also 0');
                                            e.code = 'request_failed';
                                            e.stage = 'web_search_request';
                                            e._stage = 'web_search_request';
                                            e.httpStatus = status;
                                            e.status = status;
                                            e.backend = 'searxng';
                                            e.contentType = 'text/html';
                                            return cb(e);
                                        }
                                        cb(null, ddgRaw.slice(0, max));
                                    } catch (e2) {
                                        const e = new Error('SearXNG HTML fallback returned no results, DDG fallback parse failed');
                                        e.code = 'invalid_response';
                                        e.stage = 'web_search_request';
                                        e._stage = 'web_search_request';
                                        return cb(e);
                                    }
                                });
                                return;
                            }
                            cb(null, raw.slice(0, max));
                        } catch (e) {
                            const status = (origErr && (origErr.status || origErr.httpStatus)) || 0;
                            const e2 = new Error('SearXNG HTML fallback invalid response (JSON HTTP ' + (status || 403) + ')');
                            e2.code = 'invalid_response';
                            e2.stage = 'web_search_request';
                            e2._stage = 'web_search_request';
                            e2.httpStatus = status;
                            e2.status = status;
                            cb(e2);
                        }
                    });
                };
                doGet(urlJson, cancellable, (err, dataStr) => {
                    if (done) return;
                    done = true;
                    _cancelTimeout(tid);
                    if (_isCancelled(cancellable)) return;
                    if (err) {
                        const status = err.status || err.httpStatus || 0;
                        const isJsonForbidden = status === 403 || (err.bodyText && String(err.bodyText).includes('Forbidden')) || (String(err.message||'').includes('403'));
                        if (isJsonForbidden) {
                            return tryHtmlFallback(err, null);
                        }
                        const e2 = new Error(err.message || 'SearXNG unavailable');
                        e2.code = err.code || 'backend_unavailable';
                        e2.stage = err.stage || 'web_search_request';
                        e2._stage = err._stage || 'web_search_request';
                        e2.status = status;
                        e2.httpStatus = status;
                        if (String(err.message||'').toLowerCase().includes('econnrefused') || String(err.message||'').toLowerCase().includes('enotfound')) e2.code = 'backend_unavailable';
                        return cb(e2);
                    }
                    if (dataStr && String(dataStr).trim().startsWith('<')) {
                        const e = new Error('HTTP 200 but Expected application/json Got text/html');
                        e.status = 200;
                        e.httpStatus = 200;
                        e.contentType = 'text/html';
                        e.stage = 'web_search_request';
                        e._stage = 'web_search_request';
                        return tryHtmlFallback(e, dataStr);
                    }
                    try {
                        const raw = _parseSearxngJsonForSources(dataStr);
                        if (raw.length === 0) {
                            const e = new Error('No search results');
                            e.code = 'request_failed';
                            e.stage = 'web_search_request';
                            e._stage = 'web_search_request';
                            return cb(e);
                        }
                        cb(null, raw.slice(0, max));
                    } catch (e) {
                        const looksHtml = dataStr && String(dataStr).trim().startsWith('<');
                        if (looksHtml) {
                            return tryHtmlFallback({ status: 200, httpStatus: 200, contentType: 'text/html', message: 'Invalid JSON (got HTML)' }, dataStr);
                        }
                        const e2 = new Error('Invalid response: ' + (e.message || 'JSON parse failed') + ' HTTP 200 Expected application/json');
                        e2.code = 'invalid_response';
                        e2.stage = 'web_search_request';
                        e2._stage = 'web_search_request';
                        e2.status = 200;
                        e2.httpStatus = 200;
                        cb(e2);
                    }
                });
                return;
            }
            if (engine === 'google' && !googleApiKey) {
                const e = new Error('Google API key missing');
                e.code = 'backend_unavailable';
                e.stage = 'web_search_init';
                e._stage = 'web_search_init';
                return cb(e);
            }
            if (engine === 'google' && googleApiKey) {
                const url = 'https://google.serper.dev/search';
                const body = JSON.stringify({ q, num: max });
                if (doPost) {
                    let done = false;
                    let tid = _scheduleTimeout(DEFAULT_TIMEOUT_MS, () => {
                        if (done) return;
                        done = true;
                        const e = new Error('Google request timeout');
                        e.code = 'backend_unavailable';
                        cb(e);
                    });
                    doPost(url, body, cancellable, (err, dataStr) => {
                        if (done) return;
                        done = true;
                        _cancelTimeout(tid);
                        if (_isCancelled(cancellable)) return;
                        if (err) {
                            const e2 = new Error(err.message || 'Google unavailable');
                            e2.code = err.code || 'backend_unavailable';
                            return cb(e2);
                        }
                        try {
                            const raw = _parseGoogleSerperForSources(dataStr);
                            if (raw.length === 0) {
                                const e = new Error('No search results');
                                e.code = 'request_failed';
                                return cb(e);
                            }
                            cb(null, raw.slice(0, max));
                        } catch (e) {
                            const e2 = new Error('Invalid response');
                            e2.code = 'invalid_response';
                            cb(e2);
                        }
                    });
                    return;
                }
                if (Soup) {
                    try {
                        let session = new Soup.Session();
                        try { session.timeout = Math.ceil(DEFAULT_TIMEOUT_MS/1000); } catch(e){}
                        const msg = Soup.Message.new('POST', url);
                        if (!msg) { const e=new Error('bad-url'); e.code='backend_unavailable'; return cb(e); }
                        msg.request_headers.append('X-API-KEY', googleApiKey);
                        msg.request_headers.append('Content-Type', 'application/json');
                        if (GLib) {
                            try { msg.set_request_body_from_bytes('application/json', GLib.Bytes.new(String(body))); }
                            catch(e){ msg.set_request_body_from_bytes('application/json', new GLib.Bytes(String(body))); }
                        }
                        const resolvedG = _resolveSoupCancellable(cancellable);
                        const soupCancellableG = resolvedG.soupCancellable;
                        const bridgeCleanupG = resolvedG.bridgeCleanup;
                        let done=false;
                        let tid=_scheduleTimeout(DEFAULT_TIMEOUT_MS, ()=>{ if(done) return; done=true; try { bridgeCleanupG(); } catch(e) {} try { if (soupCancellableG && typeof soupCancellableG.cancel === 'function') soupCancellableG.cancel(); } catch(e) {} const e=new Error('Google request timeout'); e.code='backend_unavailable'; cb(e); });
                        session.send_and_read_async(msg, GLib?GLib.PRIORITY_DEFAULT:0, soupCancellableG, (sess,res)=>{
                            try { bridgeCleanupG(); } catch(e) {}
                            if(done) return; done=true; _cancelTimeout(tid);
                            if(_isCancelled(cancellable) || _isCancelled(soupCancellableG)) return;
                            try {
                                const bytes=sess.send_and_read_finish(res);
                                const dataStr=new TextDecoder().decode(bytes.get_data());
                                const status=msg.get_status();
                                if(status===429){ const e=new Error('rate limited'); e.code='backend_unavailable'; return cb(e); }
                                if(status>=400){ const e=new Error('HTTP '+status); e.code='backend_unavailable'; return cb(e); }
                                const raw=_parseGoogleSerperForSources(dataStr);
                                if(raw.length===0){ const e=new Error('No search results'); e.code='request_failed'; return cb(e); }
                                cb(null, raw.slice(0,max));
                            } catch(e){ const e2=new Error('Invalid response'); e2.code='invalid_response'; cb(e2); }
                        });
                        return;
                    } catch(e){ const e2=new Error('Google backend error'); e2.code='backend_unavailable'; return cb(e2); }
                }
                const e=new Error('no http transport for google');
                e.code='backend_unavailable';
                return cb(e);
            }
            if (engine === 'bing') {
                const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q);
                let done=false;
                let tid=_scheduleTimeout(DEFAULT_TIMEOUT_MS, ()=>{ if(done) return; done=true; const e=new Error('Bing request timeout'); e.code='backend_unavailable'; cb(e); });
                doGet(url, cancellable, (err, html)=>{
                    if(done) return; done=true; _cancelTimeout(tid);
                    if(_isCancelled(cancellable)) return;
                    if(err){ const e2=new Error(err.message||'Bing unavailable'); e2.code=err.code||'backend_unavailable'; return cb(e2); }
                    try {
                        const raw=_parseBingHtmlForSources(html);
                        if(raw.length===0){ const e=new Error('No search results'); e.code='request_failed'; return cb(e); }
                        cb(null, raw.slice(0,max));
                    } catch(e){ const e2=new Error('Invalid response'); e2.code='invalid_response'; cb(e2); }
                });
                return;
            }
            const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
            let done=false;
            let tid=_scheduleTimeout(DEFAULT_TIMEOUT_MS, ()=>{ if(done) return; done=true; const e=new Error('DDG request timeout'); e.code='backend_unavailable'; cb(e); });
            doGet(url, cancellable, (err, html)=>{
                if(done) return; done=true; _cancelTimeout(tid);
                if(_isCancelled(cancellable)) return;
                if(err){ const e2=new Error(err.message||'DDG unavailable'); e2.code=err.code||'backend_unavailable'; return cb(e2); }
                try {
                    const raw=_parseDdgHtmlForSources(html);
                    if(raw.length===0){ const e=new Error('No search results'); e.code='request_failed'; return cb(e); }
                    cb(null, raw.slice(0,max));
                } catch(e){ const e2=new Error('Invalid response'); e2.code='invalid_response'; cb(e2); }
            });
        }
    };
}

function createProductionWebSearchTool(config) {
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
            },
            __isProduction: true
        };
    }
    const backend = _createProductionBackend(config);
    const tool = createMockWebSearchTool({ backend });
    tool.__isProduction = true;
    tool.__backend = backend;
    return tool;
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
    if (opts && (opts.engine || opts.searxngUrl || opts.googleApiKey || opts.webSearchApiKey)) {
        return createProductionWebSearchTool(opts);
    }
    return createMockWebSearchTool(opts);
}

module.exports = { createMockWebSearchTool, createWebSearchTool, createProductionWebSearchTool, _createProductionBackend, _parseSearxngJsonForSources, _parseBingHtmlForSources, _parseDdgHtmlForSources, _isGioCancellable: typeof _isGioCancellable !== 'undefined' ? _isGioCancellable : () => false, _resolveSoupCancellable: typeof _resolveSoupCancellable !== 'undefined' ? _resolveSoupCancellable : () => ({ soupCancellable: null, bridgeCleanup: ()=>{} }), _isCancelled, __setGioSoupForTest };
