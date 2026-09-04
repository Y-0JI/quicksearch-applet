// ai/sourceContentExpander.js — expand search results into full-page evidence for the AI.
//
// Flow (P1/P2/P3/P6/P7/P12):
//   search results -> rank/select (domain diversity, max N) -> fetch concurrently (limit,
//   timeout, cancellable) -> extract main content -> normalize -> budget window -> evidence
//   Full page content is PRIMARY evidence; snippets become the fallback per source when a
//   fetch/extraction fails. A failed source never fails the whole request.
//
// Pure helpers are exported for unit tests; network access is injected via opts.httpGet
// (production default: Soup -> fetch, mirroring webSearchTool's transport) so tests never
// touch the network. Evidence and stats are plain objects — no UI, no provider coupling.

const htmlExtractor = (() => {
    try { return require('./ai/htmlTextExtractor.js'); } catch (e) {}
    try { return require('./htmlTextExtractor.js'); } catch (e) {}
    try { return require('ai/htmlTextExtractor.js'); } catch (e) { return null; }
})();
const wsTool = (() => {
    try { return require('./ai/webSearchTool.js'); } catch (e) {}
    try { return require('./webSearchTool.js'); } catch (e) {}
    try { return require('ai/webSearchTool.js'); } catch (e) { return null; }
})();

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_SOURCES = 3;
const DEFAULT_PER_SOURCE_CHARS = 6000;
const DEFAULT_TOTAL_BUDGET_CHARS = 16000;
const MIN_MAIN_CONTENT_CHARS = (htmlExtractor && htmlExtractor.MIN_MAIN_CONTENT_CHARS) || 160;

function _isCancelled(c) {
    if (wsTool && typeof wsTool._isCancelled === 'function') { try { return wsTool._isCancelled(c); } catch (e) {} }
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}
function _resolveSoupCancellable(c) {
    if (wsTool && typeof wsTool._resolveSoupCancellable === 'function') { try { return wsTool._resolveSoupCancellable(c); } catch (e) {} }
    return { soupCancellable: c || null, bridgeCleanup: function () {} };
}

function _hostOf(url) {
    try {
        const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || '').trim());
        if (!m) return '';
        return String(m[1]).toLowerCase().replace(/^www\./, '');
    } catch (e) { return ''; }
}

// P2: source selection — provider ranking order preserved; same-domain repeats limited so
// the evidence set stays diverse. Pure and testable.
function selectSourcesForExpansion(sources, maxSources) {
    const max = (typeof maxSources === 'number' && maxSources > 0) ? Math.floor(maxSources) : DEFAULT_MAX_SOURCES;
    if (!Array.isArray(sources)) return [];
    const out = [];
    const perDomain = {};
    for (const s of sources) {
        if (!s || typeof s !== 'object') continue;
        const url = String(s.url || '').trim();
        if (!/^https?:\/\//i.test(url)) continue;
        const host = _hostOf(url);
        const domain = host || url;
        perDomain[domain] = (perDomain[domain] || 0) + 1;
        if (perDomain[domain] > 2) continue; // keep at most 2 results per domain
        out.push({
            title: String(s.title || domain || url).slice(0, 200),
            url,
            domain,
            snippet: String(s.snippet || s.content || s.description || '').slice(0, 500)
        });
        if (out.length >= max) break;
    }
    return out;
}

function _isHtmlish(text, meta) {
    try {
        const ct = (meta && (meta.contentType || meta['content-type'])) ? String(meta.contentType || meta['content-type'] || '').toLowerCase() : '';
        if (ct && ct.indexOf('html') !== -1) return true;
        if (ct && ct.indexOf('text/plain') !== -1) return true; // plain text pages still useful
        if (ct && (ct.indexOf('pdf') !== -1 || ct.indexOf('image/') === 0 || ct.indexOf('json') !== -1 || ct.indexOf('xml') !== -1 && ct.indexOf('html') === -1)) return false;
    } catch (e) {}
    const head = String(text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    if (/^<\s*(!doctype|html)/i.test(head)) return true;
    if (/^[<]/.test(head)) return true; // starts with a tag -> html-ish
    return true; // no content-type signal: attempt extraction (regex extractor is harmless)
}

// default transport: Soup (Cinnamon) then fetch (node/runtime), with timeout + cancellable.
function _defaultHttpGet(url, cancellable, cb, timeoutMs) {
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    let done = false;
    function finish(err, text, meta) {
        if (done) return;
        done = true;
        if (_isCancelled(cancellable)) {
            const e = new Error('cancelled');
            e.code = 'cancelled';
            return cb(e);
        }
        cb(err, text, meta);
    }
    function timeoutErr() {
        const e = new Error('timeout');
        e.code = 'timeout';
        finish(e);
    }
    try {
        let Soup = null, GLib = null;
        try { Soup = require('gi.Soup'); } catch (e) {}
        try { GLib = require('gi.GLib'); } catch (e) {}
        if (Soup && typeof Soup.Session !== 'undefined') {
            const session = new Soup.Session();
            try { session.timeout = Math.max(1, Math.ceil(ms / 1000)); } catch (e) {}
            const msg = Soup.Message.new('GET', url);
            if (!msg) return finish(new Error('bad-url'));
            try { msg.request_headers.append('User-Agent', 'Mozilla/5.0 QuickSearch'); } catch (e) {}
            const resolved = _resolveSoupCancellable(cancellable);
            const soupCancellable = resolved.soupCancellable;
            const bridgeCleanup = resolved.bridgeCleanup;
            let tid = null;
            if (GLib && typeof GLib.timeout_add === 'function') {
                tid = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { try { if (soupCancellable && typeof soupCancellable.cancel === 'function') soupCancellable.cancel(); } catch (e) {} return false; });
            } else if (typeof setTimeout === 'function') {
                tid = setTimeout(timeoutErr, ms);
            }
            session.send_and_read_async(msg, GLib ? GLib.PRIORITY_DEFAULT : 0, soupCancellable, (sess, res) => {
                try { if (tid && GLib && typeof GLib.source_remove === 'function') GLib.source_remove(tid); else if (tid) clearTimeout(tid); } catch (e) {}
                try { bridgeCleanup(); } catch (e) {}
                if (done) return;
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const text = new TextDecoder().decode(bytes.get_data());
                    let status = 0;
                    try {
                        if (typeof msg.get_status === 'function') status = msg.get_status();
                        else if (typeof msg.get_status_code === 'function') status = msg.get_status_code();
                        else if (typeof msg.status_code === 'number') status = msg.status_code;
                    } catch (e) {}
                    let ct = '';
                    try {
                        if (msg.response_headers && typeof msg.response_headers.get_one === 'function') ct = msg.response_headers.get_one('Content-Type') || '';
                        else if (typeof msg.get_response_headers === 'function') {
                            const h = msg.get_response_headers();
                            if (h && typeof h.get_one === 'function') ct = h.get_one('Content-Type') || '';
                        }
                    } catch (e) {}
                    if (status >= 400) {
                        const e = new Error('HTTP ' + status);
                        e.status = status;
                        return finish(e, text, { status, contentType: ct });
                    }
                    finish(null, text, { status, contentType: ct });
                } catch (e) { finish(e); }
            });
            return;
        }
        if (typeof fetch === 'function') {
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            let tid2 = null;
            if (ctrl) tid2 = setTimeout(timeoutErr, ms);
            const init = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 QuickSearch', 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } };
            if (ctrl) init.signal = ctrl.signal;
            fetch(url, init).then(r => r.text().then(t => {
                if (tid2) clearTimeout(tid2);
                if (!r.ok) {
                    const e = new Error('HTTP ' + r.status);
                    e.status = r.status;
                    let ct = '';
                    try { ct = r.headers.get('Content-Type') || ''; } catch (e2) {}
                    return finish(e, t, { status: r.status, contentType: ct });
                }
                let ctOk = '';
                try { ctOk = r.headers.get('Content-Type') || ''; } catch (e2) {}
                finish(null, t, { status: r.status, contentType: ctOk });
            })).catch(e => {
                if (tid2) clearTimeout(tid2);
                finish(e);
            });
            return;
        }
        finish(new Error('no http transport'));
    } catch (e) {
        finish(e);
    }
}

function _shortReason(err) {
    try {
        const code = (err && err.code) || '';
        if (code === 'timeout') return 'timeout';
        if (code === 'cancelled') return 'cancelled';
        const st = (err && err.status) != null ? String(err.status) : '';
        if (st) return 'HTTP ' + st;
        const msg = String((err && err.message) || '').trim();
        return msg ? msg.split('\n')[0].slice(0, 60) : 'unavailable';
    } catch (e) { return 'unavailable'; }
}

function createSourceContentExpander(opts) {
    opts = opts || {};
    const httpGet = (typeof opts.httpGet === 'function') ? opts.httpGet : _defaultHttpGet;
    const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxConcurrent = (typeof opts.maxConcurrent === 'number' && opts.maxConcurrent > 0) ? Math.floor(opts.maxConcurrent) : DEFAULT_MAX_CONCURRENT;
    const maxSources = (typeof opts.maxSources === 'number' && opts.maxSources > 0) ? Math.floor(opts.maxSources) : DEFAULT_MAX_SOURCES;
    const perSourceChars = (typeof opts.perSourceChars === 'number' && opts.perSourceChars > 0) ? Math.floor(opts.perSourceChars) : DEFAULT_PER_SOURCE_CHARS;
    const totalBudgetChars = (typeof opts.totalBudgetChars === 'number' && opts.totalBudgetChars > 0) ? Math.floor(opts.totalBudgetChars) : DEFAULT_TOTAL_BUDGET_CHARS;

    function _fetchOne(selected, cancellable, cb) {
        const src = selected;
        function respond(err, text, meta) {
            const failed = !!err;
            const reason = failed ? _shortReason(err) : '';
            if (err && err.code === 'cancelled') return; // engine handles cancellation itself
            if (err) {
                // snippet fallback — the source is still usable as weak evidence
                return cb(null, {
                    title: src.title,
                    url: src.url,
                    domain: src.domain,
                    evidenceType: 'snippet_fallback',
                    content: src.snippet || '',
                    fetchStatus: 'failed',
                    fetchError: reason,
                    charCount: (src.snippet || '').length
                });
            }
            const body = String(text || '');
            if (!_isHtmlish(body, meta)) {
                return cb(null, {
                    title: src.title,
                    url: src.url,
                    domain: src.domain,
                    evidenceType: 'snippet_fallback',
                    content: src.snippet || '',
                    fetchStatus: 'failed',
                    fetchError: 'non-html content',
                    charCount: (src.snippet || '').length
                });
            }
            let extracted = '';
            try {
                if (htmlExtractor && typeof htmlExtractor.extractMainText === 'function') extracted = htmlExtractor.extractMainText(body);
                else extracted = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            } catch (e) { extracted = ''; }
            if (String(extracted).trim().length < MIN_MAIN_CONTENT_CHARS) {
                // extraction produced nothing useful -> snippet fallback
                return cb(null, {
                    title: src.title,
                    url: src.url,
                    domain: src.domain,
                    evidenceType: 'snippet_fallback',
                    content: src.snippet || '',
                    fetchStatus: 'empty',
                    fetchError: 'empty page content',
                    charCount: (src.snippet || '').length
                });
            }
            cb(null, {
                title: src.title,
                url: src.url,
                domain: src.domain,
                evidenceType: 'page_content',
                content: extracted,
                fetchStatus: 'ok',
                charCount: extracted.length
            });
        }
        httpGet(src.url, cancellable, (err, text, meta) => respond(err, text, meta), timeoutMs);
    }

    // expand({ query, sources, cancellable }, cb) -> cb(null, { evidence, stats })
    // cb is NOT invoked when cancelled (engine drops stale results anyway).
    function expand(req, cb) {
        if (typeof cb !== 'function') return;
        const query = String((req && req.query) || '').trim();
        const sources = (req && req.sources) || [];
        const cancellable = (req && req.cancellable) || null;
        const selected = selectSourcesForExpansion(sources, maxSources);
        if (_isCancelled(cancellable)) return;
        if (selected.length === 0) {
            const stats = { total: Array.isArray(sources) ? sources.length : 0, selected: 0, fetchedOk: 0, fetchFailed: 0, pageContent: 0, snippetFallback: 0, totalChars: 0, budgetChars: totalBudgetChars, budgetPercent: 0 };
            return cb(null, { evidence: [], stats });
        }
        const stats = {
            total: Array.isArray(sources) ? sources.length : 0,
            selected: selected.length,
            fetchedOk: 0,
            fetchFailed: 0,
            pageContent: 0,
            snippetFallback: 0,
            totalChars: 0,
            budgetChars: totalBudgetChars,
            budgetPercent: 0
        };
        const results = new Array(selected.length);
        let next = 0;
        let active = 0;
        let done = 0;
        function step() {
            if (_isCancelled(cancellable)) return; // never call cb after cancel
            while (active < maxConcurrent && next < selected.length) {
                const idx = next++;
                active++;
                _fetchOne(selected[idx], cancellable, (err, ev) => {
                    active--;
                    if (!err && ev) results[idx] = ev;
                    done++;
                    if (done === selected.length) {
                        finishAll();
                        return;
                    }
                    step();
                });
            }
        }
        function finishAll() {
            if (_isCancelled(cancellable)) return;
            // budget: rank order keeps priority; global cap trims later sources first
            let used = 0;
            const evidence = [];
            for (let i = 0; i < selected.length; i++) {
                const ev = results[i];
                if (!ev) continue;
                let content = ev.content || '';
                if (ev.evidenceType === 'page_content') {
                    // per-source cap via query-aware window
                    if (content.length > perSourceChars) {
                        try {
                            content = (htmlExtractor && typeof htmlExtractor.selectRelevantWindow === 'function')
                                ? htmlExtractor.selectRelevantWindow(content, query, perSourceChars)
                                : content.slice(0, perSourceChars);
                        } catch (e) { content = content.slice(0, perSourceChars); }
                    }
                    const remaining = totalBudgetChars - used;
                    if (content.length > remaining) content = content.slice(0, Math.max(0, remaining));
                }
                if (!content) continue;
                used += content.length;
                if (ev.evidenceType === 'page_content') { stats.pageContent++; stats.fetchedOk++; }
                else stats.snippetFallback++;
                if (ev.fetchStatus && ev.fetchStatus !== 'ok') stats.fetchFailed++;
                evidence.push({
                    title: ev.title,
                    url: ev.url,
                    domain: ev.domain,
                    evidenceType: ev.evidenceType,
                    content,
                    fetchStatus: ev.fetchStatus || 'ok',
                    charCount: content.length
                });
            }
            stats.totalChars = used;
            stats.budgetPercent = totalBudgetChars > 0 ? Math.min(100, Math.round((used / totalBudgetChars) * 100)) : 0;
            cb(null, { evidence, stats });
        }
        step();
    }

    return { expand, selectSourcesForExpansion, __httpGet: httpGet, __statsDefaults: { maxConcurrent, maxSources, perSourceChars, totalBudgetChars } };
}

module.exports = { createSourceContentExpander, selectSourcesForExpansion, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_CONCURRENT, DEFAULT_MAX_SOURCES, DEFAULT_PER_SOURCE_CHARS, DEFAULT_TOTAL_BUDGET_CHARS };
