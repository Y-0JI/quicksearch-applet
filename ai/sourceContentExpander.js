// ai/sourceContentExpander.js — expand search results into full-page evidence for the AI.
//
// Flow: search results -> rank/select (domain diversity, max N) -> fetch concurrently (limit,
// timeout, cancellable) -> extract main content -> clean/normalize -> budget window -> evidence.
// Full page content is PRIMARY evidence; snippets become the per-source fallback.
//
// Hardening guarantees:
//  - P1-4: only safe public http(s) URLs are fetched (no localhost/private/loopback/link-local,
//    no file:/data:/javascript:). Redirects re-validate the FINAL url before content is used.
//  - P1-3: every fetch has a real abort: timeout aborts the request, external cancellation
//    aborts it too, and all timers/listeners are cleaned up on completion.
//  - P1-2: page_content AND snippet_fallback share ONE global budget (sum <= totalBudgetChars).
//  - P1-1: queries asking for complete data get multi-window coverage, not a single window.
//  - P2-2: big page + near-empty extraction retries with a loose extraction before falling back.
//  - P2-1: per-source diagnostics (url, status, raw/extracted/final chars) ride on the evidence
//    and are logged by the engine only when AI Debug Mode is on.
//
// Network access is injected via opts.httpGet (production default below); pure helpers are
// exported for tests. No UI, no provider coupling.

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
const DEFAULT_CANCEL_POLL_MS = 150;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_SOURCES = 3;
const DEFAULT_PER_SOURCE_CHARS = 6000;
const DEFAULT_TOTAL_BUDGET_CHARS = 16000;
const MIN_MAIN_CONTENT_CHARS = (htmlExtractor && htmlExtractor.MIN_MAIN_CONTENT_CHARS) || 160;
const MIN_LOOSE_CONTENT_CHARS = (htmlExtractor && htmlExtractor.MIN_LOOSE_CONTENT_CHARS) || 160;
const LOOSE_FALLBACK_RAW_MIN = (htmlExtractor && htmlExtractor.LOOSE_FALLBACK_RAW_MIN) || 4000;

function _isCancelled(c) {
    if (wsTool && typeof wsTool._isCancelled === 'function') { try { return wsTool._isCancelled(c); } catch (e) {} }
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}
function _resolveSoupCancellable(c) {
    if (wsTool && typeof wsTool._resolveSoupCancellable === 'function') { try { return wsTool._resolveSoupCancellable(c); } catch (e) {} }
    return { soupCancellable: c || null, bridgeCleanup: function () {} };
}

// ── P1-4 safe URL validation ──────────────────────────────────────────────────────────────
// Only public http(s) destinations may be fetched: no localhost, loopback, private/link-local
// ranges, no non-http schemes, no mDNS/private TLDs.
function _isIpv4Private(host) {
    const parts = host.split('.').map(p => Number(p));
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    if (a === 127 || a === 0) return true;              // loopback + "this network"
    if (a === 10) return true;                          // 10/8
    if (a === 192 && b === 168) return true;            // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16-31/12
    if (a === 169 && b === 254) return true;            // link-local
    return false;
}
function _isIpv6Private(host) {
    const h = host.toLowerCase();
    if (h === '::1' || h === '::' || h.indexOf('::1') === 0 || h.indexOf('::') === 0) return true;
    if (h.indexOf('fe80:') === 0 || h.indexOf('fc') === 0 || h.indexOf('fd') === 0) return true; // link-local + ULA
    return false;
}
function isSafeFetchUrl(u) {
    try {
        const s = String(u || '').trim();
        if (!/^https?:\/\//i.test(s)) return false; // only http/https
        if (/\s/.test(s)) return false;
        if (/[\u0000-\u001f]/.test(s)) return false;
        const rest = s.slice(s.indexOf('://') + 3);
        if (!rest) return false;
        if (/^[./?#:]/.test(rest)) return false;
        let host = rest.split('/')[0].split('?')[0].split('#')[0].toLowerCase();
        // strip userinfo (http://user:pass@host/)
        const at = host.lastIndexOf('@');
        if (at !== -1) host = host.slice(at + 1);
        // strip ipv6 brackets
        if (host.charAt(0) === '[') {
            const close = host.indexOf(']');
            host = close !== -1 ? host.slice(1, close) : host.slice(1);
        } else {
            // strip port from a host:port pair only when host is not an ipv6 literal
            const colon = host.lastIndexOf(':');
            if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon);
        }
        if (!host) return false;
        if (host === 'localhost' || host === 'localhost.') return false;
        if (/(^|\.)localhost$/.test(host) || /(^|\.)local$/.test(host) || /(^|\.)internal$/.test(host) || /(^|\.)home\.arpa$/.test(host) || /(^|\.)lan$/.test(host)) return false;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host) && _isIpv4Private(host)) return false;
        if (host.indexOf(':') !== -1 && _isIpv6Private(host)) return false;
        return true;
    } catch (e) { return false; }
}

function _hostOf(url) {
    try {
        const m = /^https?:\/\/([^\/?#]+)/i.exec(String(url || '').trim());
        if (!m) return '';
        return String(m[1]).toLowerCase().replace(/^www\./, '');
    } catch (e) { return ''; }
}

// P2: source selection — provider ranking order preserved; same-domain repeats limited;
// unsafe/private urls are skipped so the next valid source takes their slot.
function selectSourcesForExpansion(sources, maxSources) {
    const max = (typeof maxSources === 'number' && maxSources > 0) ? Math.floor(maxSources) : DEFAULT_MAX_SOURCES;
    if (!Array.isArray(sources)) return [];
    const out = [];
    const perDomain = {};
    for (const s of sources) {
        if (!s || typeof s !== 'object') continue;
        const url = String(s.url || '').trim();
        if (!isSafeFetchUrl(url)) continue;
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
        if (ct && (ct.indexOf('pdf') !== -1 || ct.indexOf('image/') === 0 || ct.indexOf('json') !== -1 || (ct.indexOf('xml') !== -1 && ct.indexOf('html') === -1))) return false;
    } catch (e) {}
    const head = String(text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    if (/^<\s*(!doctype|html)/i.test(head)) return true;
    if (/^[<]/.test(head)) return true; // starts with a tag -> html-ish
    return true; // no content-type signal: attempt extraction (regex extractor is harmless)
}

// ── timers (GLib in Cinnamon, setTimeout fallback under node) ────────────────────────────
function _scheduleTimeout(ms, fn) {
    let GLib = null;
    try { GLib = require('gi.GLib'); } catch (e) {}
    if (GLib && typeof GLib.timeout_add === 'function') {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
    }
    return setTimeout(fn, ms);
}
function _scheduleInterval(ms, fn) {
    let GLib = null;
    try { GLib = require('gi.GLib'); } catch (e) {}
    if (GLib && typeof GLib.timeout_add === 'function') {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { return fn() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE; });
    }
    return setInterval(fn, ms);
}
function _cancelTimer(id) {
    if (!id) return;
    let GLib = null;
    try { GLib = require('gi.GLib'); } catch (e) {}
    if (GLib && typeof GLib.source_remove === 'function') { try { GLib.source_remove(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} } }
    else { try { clearTimeout(id); } catch (e) {} try { clearInterval(id); } catch (e2) {} }
}

// P1-3 default transport: real abort on timeout AND external cancel, with full cleanup.
// cb(err, text, meta) where meta = { status, contentType, finalUrl } (finalUrl present when a
// redirect was followed and validated against isSafeFetchUrl by the caller).
function _defaultHttpGet(url, cancellable, cb, timeoutMs, cancelPollMs) {
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const poll = (typeof cancelPollMs === 'number' && cancelPollMs > 0) ? cancelPollMs : DEFAULT_CANCEL_POLL_MS;
    let done = false;
    let timedOut = false;
    let timeoutId = null;
    let pollId = null;
    let soupCancellable = null;
    let bridgeCleanup = function () {};
    function cleanup() {
        if (timeoutId) { _cancelTimer(timeoutId); timeoutId = null; }
        if (pollId) { _cancelTimer(pollId); pollId = null; }
        try { bridgeCleanup(); } catch (e) {}
    }
    function finish(err, text, meta) {
        if (done) return;
        done = true;
        cleanup();
        if (_isCancelled(cancellable) && !timedOut) {
            const e = new Error('cancelled');
            e.code = 'cancelled';
            return cb(e);
        }
        cb(err, text, meta);
    }
    function timeoutErr() {
        if (done) return;
        timedOut = true;
        abortRequest();
        const e = new Error('timeout');
        e.code = 'timeout';
        finish(e);
    }
    let abortRequest = function () {};
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
            soupCancellable = resolved.soupCancellable;
            bridgeCleanup = resolved.bridgeCleanup;
            abortRequest = function () {
                try { if (soupCancellable && typeof soupCancellable.cancel === 'function') soupCancellable.cancel(); } catch (e) {}
            };
            timeoutId = _scheduleTimeout(ms, timeoutErr);
            // external cancel on plain wrappers (no Gio bridge): poll and abort
            pollId = _scheduleInterval(poll, () => {
                if (_isCancelled(cancellable) && !done) { abortRequest(); return false; }
                return true;
            });
            session.send_and_read_async(msg, GLib ? GLib.PRIORITY_DEFAULT : 0, soupCancellable, (sess, res) => {
                if (done) return;
                cleanup();
                if (timedOut || _isCancelled(cancellable)) { timeoutId = null; pollId = null; }
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
                    let finalUrl = url;
                    try {
                        const uri = msg.get_uri();
                        if (uri) {
                            const sUri = (typeof uri.to_string === 'function') ? uri.to_string() : String(uri);
                            if (sUri) finalUrl = sUri;
                        }
                    } catch (e) {}
                    if (timedOut) return finish(timeoutErr());
                    if (status >= 400) {
                        const e = new Error('HTTP ' + status);
                        e.status = status;
                        return finish(e, text, { status, contentType: ct, finalUrl });
                    }
                    finish(null, text, { status, contentType: ct, finalUrl });
                } catch (e) {
                    if (timedOut) return finish(timeoutErr());
                    if (_isCancelled(cancellable)) { const c = new Error('cancelled'); c.code = 'cancelled'; return finish(c); }
                    finish(e);
                }
            });
            return;
        }
        if (typeof fetch === 'function') {
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            abortRequest = function () { try { if (ctrl) ctrl.abort(); } catch (e) {} };
            timeoutId = _scheduleTimeout(ms, timeoutErr);
            pollId = _scheduleInterval(poll, () => {
                if (_isCancelled(cancellable) && !done) { abortRequest(); return false; }
                return true;
            });
            const init = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 QuickSearch', 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' } };
            if (ctrl) init.signal = ctrl.signal;
            fetch(url, init).then(r => r.text().then(t => {
                if (done) return;
                cleanup();
                if (!r.ok) {
                    const e = new Error('HTTP ' + r.status);
                    e.status = r.status;
                    let ct = '';
                    try { ct = r.headers.get('Content-Type') || ''; } catch (e2) {}
                    let finalUrl = url;
                    try { if (r.url) finalUrl = r.url; } catch (e2) {}
                    return finish(e, t, { status: r.status, contentType: ct, finalUrl });
                }
                let ctOk = '';
                try { ctOk = r.headers.get('Content-Type') || ''; } catch (e2) {}
                let finalUrlOk = url;
                try { if (r.url) finalUrlOk = r.url; } catch (e2) {}
                finish(null, t, { status: r.status, contentType: ctOk, finalUrl: finalUrlOk });
            })).catch(e => {
                if (done) return;
                cleanup();
                if (timedOut) return finish(timeoutErr());
                const nm = (e && e.name) || '';
                if (nm === 'AbortError' || _isCancelled(cancellable)) {
                    const c = new Error('cancelled');
                    c.code = 'cancelled';
                    return finish(c);
                }
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
    const httpGet = (typeof opts.httpGet === 'function')
        ? opts.httpGet
        : (url, cancellable, cb, timeoutMs) => _defaultHttpGet(url, cancellable, cb, timeoutMs, opts.cancelPollMs);
    const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const maxConcurrent = (typeof opts.maxConcurrent === 'number' && opts.maxConcurrent > 0) ? Math.floor(opts.maxConcurrent) : DEFAULT_MAX_CONCURRENT;
    const maxSources = (typeof opts.maxSources === 'number' && opts.maxSources > 0) ? Math.floor(opts.maxSources) : DEFAULT_MAX_SOURCES;
    const perSourceChars = (typeof opts.perSourceChars === 'number' && opts.perSourceChars > 0) ? Math.floor(opts.perSourceChars) : DEFAULT_PER_SOURCE_CHARS;
    const totalBudgetChars = (typeof opts.totalBudgetChars === 'number' && opts.totalBudgetChars > 0) ? Math.floor(opts.totalBudgetChars) : DEFAULT_TOTAL_BUDGET_CHARS;

    function _snippetFallbackEvidence(src, status, errReason, extra) {
        const ev = {
            title: src.title,
            url: src.url,
            domain: src.domain,
            evidenceType: 'snippet_fallback',
            content: src.snippet || '',
            fetchStatus: status,
            charCount: (src.snippet || '').length,
            httpStatus: (extra && typeof extra.httpStatus === 'number') ? extra.httpStatus : null,
            rawHtmlChars: (extra && typeof extra.rawHtmlChars === 'number') ? extra.rawHtmlChars : null,
            extractedChars: (extra && typeof extra.extractedChars === 'number') ? extra.extractedChars : null
        };
        if (errReason) ev.fetchError = errReason;
        return ev;
    }

    function _fetchOne(selected, cancellable, cb) {
        const src = selected;
        // P1-4: never fetch an unsafe url (double gate — selection already filtered)
        if (!isSafeFetchUrl(src.url)) {
            return cb(null, _snippetFallbackEvidence(src, 'blocked', 'unsafe url'));
        }
        function respond(err, text, meta) {
            if (err) {
                if (err.code === 'cancelled') return; // engine handles cancellation itself
                // P1-4 redirect safety: final url must still be public before content is used
                return cb(null, _snippetFallbackEvidence(src, 'failed', _shortReason(err), {
                    httpStatus: (err && err.status) != null ? err.status : (meta && typeof meta.status === 'number' ? meta.status : null)
                }));
            }
            const body = String(text || '');
            const httpStatus = (meta && typeof meta.status === 'number') ? meta.status : null;
            const finalUrl = (meta && typeof meta.finalUrl === 'string' && meta.finalUrl.trim()) ? meta.finalUrl.trim() : src.url;
            // P1-4 redirect target validation — content from a redirect to a private/local host is
            // never used (treated like a fetch failure: snippet fallback).
            if (!isSafeFetchUrl(finalUrl)) {
                return cb(null, _snippetFallbackEvidence(src, 'blocked', 'redirect to unsafe url', { httpStatus, rawHtmlChars: body.length, extractedChars: null }));
            }
            if (!_isHtmlish(body, meta)) {
                return cb(null, _snippetFallbackEvidence(src, 'failed', 'non-html content', { httpStatus, rawHtmlChars: body.length, extractedChars: 0 }));
            }
            const rawHtmlChars = body.length;
            let extracted = '';
            let usedLoose = false;
            try {
                if (htmlExtractor && typeof htmlExtractor.extractMainText === 'function') extracted = htmlExtractor.extractMainText(body);
                else extracted = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            } catch (e) { extracted = ''; }
            // P2-2 extraction quality: big raw page but almost nothing extracted -> retry loose
            if (String(extracted).trim().length < MIN_MAIN_CONTENT_CHARS && rawHtmlChars >= LOOSE_FALLBACK_RAW_MIN) {
                let loose = '';
                try {
                    loose = (htmlExtractor && typeof htmlExtractor.extractMainTextLoose === 'function')
                        ? htmlExtractor.extractMainTextLoose(body)
                        : body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                } catch (e) { loose = ''; }
                if (String(loose).trim().length >= MIN_LOOSE_CONTENT_CHARS) {
                    extracted = loose;
                    usedLoose = true;
                }
            }
            const extractedChars = String(extracted).trim().length;
            if (extractedChars < MIN_MAIN_CONTENT_CHARS) {
                return cb(null, _snippetFallbackEvidence(src, usedLoose ? 'empty' : 'empty', 'empty page content', { httpStatus, rawHtmlChars, extractedChars }));
            }
            cb(null, {
                title: src.title,
                url: src.url,
                domain: src.domain,
                evidenceType: 'page_content',
                content: extracted,
                fetchStatus: 'ok',
                charCount: extractedChars,
                httpStatus,
                rawHtmlChars,
                extractedChars,
                extractionFallback: usedLoose || undefined
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
        const fullIntent = (htmlExtractor && typeof htmlExtractor.isFullContentIntent === 'function')
            ? htmlExtractor.isFullContentIntent(query)
            : false;
        if (selected.length === 0) {
            const stats = { total: Array.isArray(sources) ? sources.length : 0, selected: 0, fetchedOk: 0, fetchFailed: 0, pageContent: 0, snippetFallback: 0, totalChars: 0, budgetChars: totalBudgetChars, budgetPercent: 0, fullContentIntent: !!fullIntent };
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
            budgetPercent: 0,
            fullContentIntent: !!fullIntent
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
                    if (done === selected.length) { finishAll(); return; }
                    step();
                });
            }
        }
        function finishAll() {
            if (_isCancelled(cancellable)) return;
            // P1-2 unified global budget: EVERY evidence (page_content and snippet_fallback)
            // consumes the same remaining budget — invariant: sum(all chars) <= totalBudgetChars.
            let used = 0;
            const evidence = [];
            for (let i = 0; i < selected.length; i++) {
                const ev = results[i];
                if (!ev) continue;
                let content = ev.content || '';
                if (content) {
                    if (ev.evidenceType === 'page_content' && content.length > perSourceChars) {
                        try {
                            if (fullIntent && htmlExtractor && typeof htmlExtractor.buildFullContentWindows === 'function') {
                                content = htmlExtractor.buildFullContentWindows(content, query, perSourceChars);
                            } else if (htmlExtractor && typeof htmlExtractor.selectRelevantWindow === 'function') {
                                content = htmlExtractor.selectRelevantWindow(content, query, perSourceChars);
                            } else {
                                content = content.slice(0, perSourceChars);
                            }
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
                    fetchError: ev.fetchError,
                    httpStatus: ev.httpStatus != null ? ev.httpStatus : null,
                    rawHtmlChars: ev.rawHtmlChars != null ? ev.rawHtmlChars : null,
                    extractedChars: ev.extractedChars != null ? ev.extractedChars : null,
                    extractionFallback: ev.extractionFallback || undefined,
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

module.exports = {
    createSourceContentExpander,
    selectSourcesForExpansion,
    isSafeFetchUrl,
    _defaultHttpGet,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_CONCURRENT,
    DEFAULT_MAX_SOURCES,
    DEFAULT_PER_SOURCE_CHARS,
    DEFAULT_TOTAL_BUDGET_CHARS
};
