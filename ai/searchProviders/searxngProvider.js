// ai/searchProviders/searxngProvider.js — single canonical retrieval path for AI grounding.
// SearXNG HTML (GET /search?q=...) is the ONLY primary endpoint: on this runtime
// /search?q=...&format=json returns HTTP 403 while the HTML endpoint returns HTTP 200.
//   fetch HTML -> validate response -> parseSearXngHtml -> SearchResult[] (Promise)
// No multi-provider retry, no fallback chain, no AI/stream/tool-call logic in here.
let GLib = null;
try { GLib = require('gi.GLib'); } catch (e) {}
// searchResult is resolved with the same multi-candidate strategy the other modules use, because
// Cinnamon's module resolver is not guaranteed to be file-relative (it differs from Node).
let searchResultMod = null;
try { searchResultMod = require('./searchResult.js'); } catch (e) {}
try { if (!searchResultMod) searchResultMod = require('searchProviders/searchResult.js'); } catch (e) {}
try { if (!searchResultMod) searchResultMod = require('ai/searchProviders/searchResult.js'); } catch (e) {}
if (!searchResultMod) throw new Error('searchResult module unavailable (no candidate path resolved)');
const { normalizeSearchResults } = searchResultMod;

const PROVIDER_NAME = 'searxng_html';
const DEFAULT_TIMEOUT_MS = 4000;
const MAX_PARSE_RESULTS = 10;
// Canonical stage names so runtime errors are never "Stage: unknown":
//   web_search_request  — the HTTP request itself failed (network, status >= 400, timeout)
//   web_search_parse    — response received (HTTP 200) but body/parse yielded nothing usable
//   web_search_normalize — parser produced items but canonicalization dropped them all

function _log(line) {
    try { if (typeof global !== 'undefined' && typeof global.log === 'function') global.log('[WebSearch] ' + line); } catch (e) {}
}
function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}
function _scheduleTimeout(ms, fn) {
    if (GLib && typeof GLib.timeout_add === 'function') {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
    }
    return setTimeout(fn, ms);
}
function _cancelTimeout(id) {
    if (!id) return;
    if (GLib && typeof GLib.source_remove === 'function') {
        try { GLib.source_remove(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} }
    } else try { clearTimeout(id); } catch (e) {}
}

function _makeError(message, code, stage, extra) {
    const e = new Error(String(message || code));
    e.code = code;
    e.stage = stage;
    e._stage = stage;
    if (extra) {
        if (extra.httpStatus != null) { e.status = extra.httpStatus; e.httpStatus = extra.httpStatus; }
        if (extra.backend) e.backend = extra.backend;
        if (extra.contentType) e.contentType = extra.contentType;
    }
    return e;
}

// Dedicated SearXNG HTML parser (simple theme). Responsibilities ONLY:
// 1. find result items (article.result), 2. take title, 3. take destination URL,
// 4. take snippet, 5. drop invalid items. No AI/fallback/tool/stream logic.
function parseSearXngHtml(html) {
    const clean = s => String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ').trim();
    const out = [];
    const htmlStr = String(html || '');
    const pushValid = (title, url, snippet) => {
        if (!url || !/^https?:\/\//i.test(url)) return;
        if (/^https?:\/\/127\.0\.0\.1/.test(url) || /^https?:\/\/localhost/.test(url)) return;
        if (url.indexOf('searx.space') >= 0 || url.indexOf('github.com/searxng') >= 0) return;
        const t = clean(title);
        if (!t) return;
        if (/^javascript:/i.test(url) || /^#/.test(url)) return;
        out.push({ title: t.slice(0, 200), url: url.trim(), snippet: String(snippet || '').slice(0, 500) });
    };
    // SearXNG simple theme result markup:
    //   <article class="result"><h3><a href="URL">TITLE</a></h3><p class="content">SNIPPET</p></article>
    const articleRe = /<article[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let am;
    while ((am = articleRe.exec(htmlStr)) !== null && out.length < MAX_PARSE_RESULTS) {
        const block = am[1];
        const h3a = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!h3a) continue;
        const url = h3a[1];
        const title = h3a[2];
        let snippet = '';
        const p = /<p[^>]*class="[^"]*\bcontent\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (p) snippet = clean(p[1]);
        if (!snippet) {
            const p2 = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
            if (p2) snippet = clean(p2[1]);
        }
        pushValid(title, url, snippet);
    }
    return out.slice(0, MAX_PARSE_RESULTS);
}

// SearchProvider interface: search(query, cancellable) -> Promise<SearchResult[]>
function createSearXngProvider(opts) {
    opts = opts || {};
    const searxngUrl = String(opts.searxngUrl || 'http://127.0.0.1:8080').replace(/\/+$/, '');
    const doGet = (typeof opts.httpGet === 'function') ? opts.httpGet : null;
    const timeoutMs = (typeof opts.timeoutMs === 'number') ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    function fetchHtml(query, cancellable) {
        const url = searxngUrl + '/search?q=' + encodeURIComponent(query);
        return new Promise((resolve, reject) => {
            if (!doGet) {
                return reject(_makeError('SearXNG HTML transport unavailable', 'request_failed', 'web_search_request', { backend: PROVIDER_NAME }));
            }
            if (_isCancelled(cancellable)) {
                return reject(_makeError('cancelled', 'cancelled', 'web_search_request', { backend: PROVIDER_NAME }));
            }
            let settled = false;
            let tid = _scheduleTimeout(timeoutMs, () => {
                if (settled) return;
                settled = true;
                reject(_makeError('SearXNG HTML request timeout', 'backend_unavailable', 'web_search_request', { backend: PROVIDER_NAME }));
            });
            doGet(url, cancellable, (err, body, meta) => {
                if (settled) return;
                settled = true;
                _cancelTimeout(tid);
                if (_isCancelled(cancellable)) {
                    return reject(_makeError('cancelled', 'cancelled', 'web_search_request', { backend: PROVIDER_NAME }));
                }
                if (err) {
                    const status = (err && (err.status != null ? err.status : err.httpStatus)) || 0;
                    const msg = (err && err.message) ? String(err.message) : ('SearXNG HTML request failed' + (status ? ' (HTTP ' + status + ')' : ''));
                    const code = status >= 400 ? 'request_failed' : ((err && err.code) || 'backend_unavailable');
                    _log('query="' + query.slice(0, 120) + '" provider=' + PROVIDER_NAME + ' http_status=' + (status || '-') + ' error=' + msg.slice(0, 200) + ' stage=web_search_request');
                    return reject(_makeError(msg, code, 'web_search_request', {
                        httpStatus: status || undefined,
                        backend: PROVIDER_NAME,
                        contentType: err && err.contentType
                    }));
                }
                meta = meta || {};
                const status = (meta.status != null) ? meta.status : 200;
                const contentType = String(meta.contentType || '').toLowerCase();
                const bodyText = typeof body === 'string' ? body : '';
                if (!bodyText.trim()) {
                    _log('query="' + query.slice(0, 120) + '" provider=' + PROVIDER_NAME + ' http_status=' + status + ' error=empty response body stage=web_search_parse');
                    return reject(_makeError('SearXNG HTML returned an empty body', 'invalid_response', 'web_search_parse', { httpStatus: status, backend: PROVIDER_NAME, contentType }));
                }
                if (contentType && contentType.indexOf('html') < 0 && contentType.indexOf('xml') < 0) {
                    _log('query="' + query.slice(0, 120) + '" provider=' + PROVIDER_NAME + ' http_status=' + status + ' content_type=' + contentType + ' error=unexpected content type stage=web_search_parse');
                    return reject(_makeError('SearXNG HTML unexpected Content-Type: ' + contentType, 'invalid_response', 'web_search_parse', { httpStatus: status, backend: PROVIDER_NAME, contentType }));
                }
                resolve({ status, contentType, body: bodyText });
            });
        });
    }

    function search(query, cancellable) {
        const q = String(query || '').trim();
        if (!q) {
            return Promise.reject(_makeError('Invalid search query', 'invalid_query', 'web_search_request', { backend: PROVIDER_NAME }));
        }
        return fetchHtml(q, cancellable).then(({ status, contentType, body }) => {
            const parsed = parseSearXngHtml(body);
            _log('query="' + q.slice(0, 120) + '" provider=' + PROVIDER_NAME + ' http_status=' + status + ' content_type=' + (contentType || 'text/html') + ' parsed_results=' + parsed.length);
            if (parsed.length === 0) {
                return Promise.reject(_makeError('No search results found', 'no_results', 'web_search_parse', { httpStatus: status, backend: PROVIDER_NAME, contentType }));
            }
            const results = normalizeSearchResults(parsed);
            if (results.length === 0) {
                return Promise.reject(_makeError('Search results were all invalid after normalization', 'request_failed', 'web_search_normalize', { httpStatus: status, backend: PROVIDER_NAME, contentType }));
            }
            return results;
        });
    }

    return { search, __providerName: PROVIDER_NAME };
}

module.exports = { createSearXngProvider, parseSearXngHtml, PROVIDER_NAME, DEFAULT_TIMEOUT_MS };
