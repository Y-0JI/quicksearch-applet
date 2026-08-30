// Web search (spec §10 / 24-H): browser-search fallback ALWAYS instant,
// DuckDuckGo instant answers best-effort upgrade. Failure here never breaks
// local search. Cancellable owned by engine (guardrail 3).
//
// Phase 13 — full rewrite:
//   BUG A fix: defaultHttpGet/HttpPost now use session-scoped closures so the
//   Soup.Session lives inside createWebProvider, not at module scope.
//   BUG B fix: parseDdgHtml is more robust — extracts result blocks from
//   <div class="result"> or <div class="web-result"> containers, and falls
//   back to generic anchor+text extraction when class="result__a" is absent.
//   NEW: Google backend via Serper.dev API (user-provided API key).
//   The agent never knows which backend is used — search_web returns a
//   uniform {query, count, results:[{title,url,summary}]} format.
//
// SECURITY: no API keys in source, no shell, no browser automation.

let Gio = null, GLib = null, Soup = null;
try { Gio = require('gi.Gio'); } catch (e) {}
try { GLib = require('gi.GLib'); } catch (e) {}
try { Soup = require('gi.Soup'); } catch (e) {}

const REQUEST_TIMEOUT_MS = 4000;

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

// Normalized error codes for web search (Step 4/8 of Phase 13).
// UI must never show raw API errors — only these codes.
const WEB_ERRORS = {
    API_KEY_MISSING: 'web-search-api-key-missing',
    UNAVAILABLE:    'web-search-unavailable',
    RATE_LIMITED:   'web-search-rate-limited',
    NETWORK_ERROR:  'web-search-network-error',
    BAD_RESPONSE:   'web-search-bad-response',
    NO_RESULTS:     'web-search-no-results',
    SEARXNG_UNAVAILABLE: 'searxng-unavailable'
};

// ── Robust HTML parser (BUG B fix) ────────────────────────────────────────
// Parse DuckDuckGo HTML results. More tolerant than the old version:
//   - matches <div class="result ..."> OR <div class="web-result ..."> blocks
//   - extracts title + URL from any anchor inside the result block
//   - extracts snippet from <a class="result__snippet"> OR <span> text
//   - decodes DDG uddg redirect URLs
//   - caps at 5 results, sanitizes HTML entities

function parseDdgHtml(html, makeResult, scoreResult) {
    const clean = s => String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

    const realUrl = href => {
        const m = /\/l\/\?uddg=([^&]+)/.exec(href || '');
        if (m) { try { return decodeURIComponent(m[1]); } catch (e) {} }
        return /^https?:\/\//.test(href || '') ? href : '';
    };

    const out = [];
    const max = 5;
    const htmlStr = html || '';

    // Strategy 1: extract result blocks (<div class="result ..."> or web-result)
    // Each block contains a title anchor and optionally a snippet anchor.
    const blockRe = /<div\s+class="(?:result|web-result)[^"]*">([\s\S]*?)<\/div>/gi;
    let blockMatch;
    while ((blockMatch = blockRe.exec(htmlStr)) !== null && out.length < max) {
        const block = blockMatch[1];
        // title + url: look for any anchor with href containing /l/?uddg or http(s)
        const anchorRe = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let anchorMatch;
        let title = '', url = '';
        while ((anchorMatch = anchorRe.exec(block)) !== null) {
            const href = anchorMatch[1];
            const text = clean(anchorMatch[2]);
            const decoded = realUrl(href);
            if (decoded && text.length > 2) {
                title = text;
                url = decoded;
                break;
            }
        }
        if (!url || !/^https?:\/\//.test(url)) continue;
        // snippet: look for result__snippet or just grab remaining text
        let snippet = '';
        const snipRe = /<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
        const snipMatch = snipRe.exec(block);
        if (snipMatch) {
            snippet = clean(snipMatch[1]);
        } else {
            // fallback: extract any text not inside anchors
            const textOnly = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            // remove the title text to get the snippet
            const idx = textOnly.indexOf(title.slice(0, 20));
            if (idx >= 0) snippet = textOnly.slice(idx + title.length).trim();
            if (snippet.length > 300) snippet = snippet.slice(0, 300);
        }
        out.push(makeResult({
            type: 'web',
            title: title.slice(0, 120),
            description: snippet,
            icon: 'web-browser',
            score: scoreResult('web-instant'),
            url: url,
            action: () => _openBrowser(url)
        }));
    }

    // Strategy 2 (fallback): if no blocks found, try flat anchor extraction
    // (some DDG HTML variants don't wrap in <div class="result">)
    if (out.length === 0) {
        const flatRe = /<a\s+class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        const flatSnippets = [...htmlStr.matchAll(/<a\s+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)]
            .map(m => clean(m[1]));
        let idx = 0;
        let flatMatch;
        while ((flatMatch = flatRe.exec(htmlStr)) !== null && out.length < max) {
            const url = realUrl(flatMatch[1]);
            if (!/^https?:\/\//.test(url)) continue;
            out.push(makeResult({
                type: 'web',
                title: clean(flatMatch[2]).slice(0, 120),
                description: flatSnippets[idx] || '',
                icon: 'web-browser',
                score: scoreResult('web-instant'),
                url: url,
                action: () => _openBrowser(url)
            }));
            idx++;
        }
    }

    return out;
}

// ── SearXNG JSON result parser ────────────────────────────────────────────
// SearXNG returns: { results: [{ title, url, content, engine, ... }], ... }
// Normalized to the same result shape as parseDdgHtml.

function parseSearxngJson(data, makeResult, scoreResult) {
    const out = [];
    const items = (data && data.results) || [];
    const max = 5;
    for (let i = 0; i < Math.min(items.length, max); i++) {
        const item = items[i];
        const url = item.url || '';
        if (!url || !/^https?:\/\//.test(url)) continue;
        out.push(makeResult({
            type: 'web',
            title: String(item.title || '').slice(0, 120),
            description: String(item.content || ''),
            icon: 'web-browser',
            score: scoreResult('web-instant'),
            url: url,
            action: () => _openBrowser(url)
        }));
    }
    return out;
}

// ── Google (Serper) JSON result parser ─────────────────────────────────────
// Serper returns: { organic: [{ title, link, snippet, position }], ... }
// Normalized to the same result shape as parseDdgHtml.

function parseGoogleJson(data, makeResult, scoreResult) {
    const out = [];
    const items = (data && data.organic) || [];
    const max = 5;
    for (let i = 0; i < Math.min(items.length, max); i++) {
        const item = items[i];
        const url = item.link || '';
        if (!url || !/^https?:\/\//.test(url)) continue;
        out.push(makeResult({
            type: 'web',
            title: String(item.title || '').slice(0, 120),
            description: String(item.snippet || ''),
            icon: 'web-browser',
            score: scoreResult('web-instant'),
            url: url,
            action: () => _openBrowser(url)
        }));
    }
    return out;
}

// ── Bing HTML result parser ────────────────────────────────────────────────
// Parses Bing HTML search results (<li class="b_algo"> blocks).
// Normalized to the same result shape as parseDdgHtml / parseGoogleJson.
// No API key or credential needed — HTML scrape only.

function parseBingHtml(html, makeResult, scoreResult) {
    const clean = s => String(s)
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

    const out = [];
    const max = 5;
    const htmlStr = html || '';
    const blockRe = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let bm;
    while ((bm = blockRe.exec(htmlStr)) !== null && out.length < max) {
        const block = bm[1];
        let title = '', url = '';
        const h2a = /<h2[^>]*>\s*<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (h2a) {
            url = h2a[1];
            title = clean(h2a[2]);
        }
        if (!url || !/^https?:\/\//.test(url) || !title) continue;
        let snippet = '';
        const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        if (p) snippet = clean(p[1]);
        if (snippet.length > 300) snippet = snippet.slice(0, 300);
        out.push(makeResult({
            type: 'web',
            title: title.slice(0, 120),
            description: snippet,
            icon: 'web-browser',
            score: scoreResult('web-instant'),
            url: url,
            action: () => _openBrowser(url)
        }));
    }
    return out;
}

// Strip full-page HTML (script/style/comments included) down to plain
// text. Unlike the small-snippet `clean()` inside each parser, this must
// remove <script>/<style> BODIES first — snippet parsers never see a
// target site's own JS/CSS, a full-page fetch does.
function _htmlToText(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ── WebProvider factory ────────────────────────────────────────────────────

function createWebProvider(helpers) {
    helpers = helpers || {};
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    const fallbackUrlFor = helpers.fallbackUrlFor || (q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q));
    const searchEngineLabel = helpers.searchEngineLabel || 'DuckDuckGo';
    const useInstantAnswers = helpers.useInstantAnswers !== false;

    // Engine selection: 'ddgo' (default), 'google' (Serper API), 'searxng' (local)
    const engine = helpers.engine || 'ddgo';
    const googleApiKey = helpers.googleApiKey || '';
    const searxngUrl = helpers.searxngUrl || 'http://127.0.0.1:8080';

    // Injected transports (optional; for tests and benchmarks)
    const httpGet = typeof helpers.httpGet === 'function' ? helpers.httpGet : null;
    const httpPost = typeof helpers.httpPost === 'function' ? helpers.httpPost : null;
    const onStage = typeof helpers.onStage === 'function' ? helpers.onStage : null;
    const stage = (name) => { if (onStage) { try { onStage(name, Date.now()); } catch (e) {} } };

    // Session-scoped Soup.Session (BUG A fix): created per WebProvider instance.
    // The old design had session as a module-level free variable that the
    // defaultHttpGet/HttpPost functions could not reach — causing undefined
    // session access in Cinnamon runtime. Now both default transports are
    // closures that own their session reference.
    let session = null;
    function ensureSession() {
        if (!session && Soup) {
            session = new Soup.Session();
            session.timeout = Math.ceil(REQUEST_TIMEOUT_MS / 1000); // seconds
        }
        return session;
    }

    // Default transports: session-scoped closures (BUG A fix)
    function scopedHttpGet(url, cancellable, onResult) {
            try {
                const s = ensureSession();
                if (!s) return onResult(new Error('no-soup'));
                const msg = Soup.Message.new('GET', url);
                if (!msg) return onResult(new Error('bad-url'));
                // Bing (and some endpoints) reject requests without a User-Agent;
                // a generic browser UA keeps the no-credential HTML scrape working
                try { msg.request_headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) QuickSearch'); } catch (e) {}
                s.send_and_read_async(msg, (GLib ? GLib.PRIORITY_DEFAULT : 0), cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    onResult(null, new TextDecoder().decode(bytes.get_data()));
                } catch (e) { onResult(e); }
            });
        } catch (e) { onResult(e); }
    }

    function scopedHttpPost(url, body, cancellable, onResult) {
        try {
            const s = ensureSession();
            if (!s) return onResult(new Error('no-soup'));
            const msg = Soup.Message.new('POST', url);
            if (!msg) return onResult(new Error('bad-url'));
            if (GLib) {
                try { msg.set_request_body_from_bytes('application/x-www-form-urlencoded', GLib.Bytes.new(String(body))); }
                catch (e) { msg.set_request_body_from_bytes('application/x-www-form-urlencoded', new GLib.Bytes(String(body))); }
            } else {
                try { msg.set_request_body_from_bytes('application/x-www-form-urlencoded', new (require('gi.GLib').Bytes)(String(body))); }
                catch (e) { }
            }
            s.send_and_read_async(msg, (GLib ? GLib.PRIORITY_DEFAULT : 0), cancellable, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    onResult(null, new TextDecoder().decode(bytes.get_data()));
                } catch (e) { onResult(e); }
            });
        } catch (e) { onResult(e); }
    }

    // Resolved transports: injected or session-scoped defaults
    const doGet = httpGet || scopedHttpGet;
    const doPost = httpPost || scopedHttpPost;

    // ── SearXNG pre-flight availability check ─────────────────────────
    // Phase 14 latency: ping once at startup. Result is a HINT only
    // (unknown → null, available → true, unavailable → false).
    // search() always retries the real endpoint; hint only warms cache.
    let searxngAvailable = null; // null = unknown, true/false = hint

    function preflight(cb) {
        if (engine !== 'searxng') { if (cb) cb(null); return; }
        const base = String(searxngUrl).replace(/\/+$/, '');
        const pingUrl = base + '/search?q=test&format=json';
        doGet(pingUrl, null, (err) => {
            searxngAvailable = !err;
            if (cb) cb(err ? err : null);
        });
    }

    function search(query, cancellable, onDone, opts) {
        const q = String(query || '').trim();
        const searchUrl = fallbackUrlFor(q);

        const fallback = makeResult({
            type: 'web',
            title: 'Search the web for "' + q + '"',
            description: searchEngineLabel,
            icon: 'web-browser',
            score: scoreResult('web-fallback'),
            url: searchUrl,
            action: () => _openBrowser(searchUrl)
        });

        const deliver = (list) => {
            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
            onDone(list);
        };

        stage('search-start');
        deliver([fallback]); // guaranteed, instant (spec 24-H)

        if (!q) return;

        const isAgent = !!(opts && opts.agent);
        const makeErrorFallback = (title, desc) => makeResult({
            type: 'web',
            title: title,
            description: desc,
            icon: 'dialog-warning',
            score: scoreResult('web-fallback'),
            url: searchUrl,
            action: () => _openBrowser(searchUrl)
        });

        // ── SearXNG Local backend ─────────────────────────────────────
        // searxngAvailable is a hint only — never a permanent breaker.
        // Every search() retries the real endpoint; success flips to
        // true, failure flips to false, but no state blocks the next
        // HTTP attempt. Phase 14 preflight only warms this hint.
        if (engine === 'searxng') {
            try {
                const base = String(searxngUrl).replace(/\/+$/, '');
                const apiUrl = base + '/search?q=' + encodeURIComponent(q) + '&format=json';
                stage('http-start');
                let searxngDone = false;
                let searxngTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                    if (searxngDone) return;
                    searxngDone = true;
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    searxngAvailable = false;
                    const errFallback = makeResult({
                        type: 'web',
                        title: 'SearXNG lokal tidak tersedia',
                        description: 'Pastikan SearXNG sedang berjalan di ' + base,
                        icon: 'dialog-warning',
                        score: scoreResult('web-fallback'),
                        url: searchUrl,
                        action: () => _openBrowser(searchUrl)
                    });
                    deliver([errFallback]);
                });
                doGet(apiUrl, cancellable, (err, dataStr) => {
                    if (searxngDone) return;
                    searxngDone = true;
                    _cancelTimeout(searxngTid);
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    if (err) {
                        // hint only — next search() will still retry
                        searxngAvailable = false;
                        const errFallback = makeResult({
                            type: 'web',
                            title: 'SearXNG lokal tidak tersedia',
                            description: 'Pastikan SearXNG sedang berjalan di ' + base,
                            icon: 'dialog-warning',
                            score: scoreResult('web-fallback'),
                            url: searchUrl,
                            action: () => _openBrowser(searchUrl)
                        });
                        deliver([errFallback]);
                        return;
                    }
                    searxngAvailable = true;
                    try {
                        const data = JSON.parse(dataStr);
                        const extra = parseSearxngJson(data, makeResult, scoreResult);
                        stage('parse-done');
                        if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                    } catch (e) {
                        // parse fail is not availability — keep true from successful HTTP
                        const parseErr = makeErrorFallback('SearXNG: response tidak valid', 'Pastikan SearXNG berjalan');
                        deliver([parseErr]);
                    }
                });
            } catch (e) { /* SearXNG backend error: fallback stands alone */ }
            return;
        }

        // ── Google (Serper) backend ────────────────────────────────────
        if (engine === 'google' && googleApiKey) {
            try {
                const apiUrl = 'https://google.serper.dev/search';
                const body = JSON.stringify({ q: q, num: 5 });
                stage('http-start');
                // Serper uses POST with JSON body and API key header.
                // If injected httpPost is available, use it (for tests);
                // otherwise use a Soup-based POST with custom headers.
                if (httpPost) {
                    // Test mode: injected transport handles it
                    let ggDone = false;
                    let ggTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                        if (ggDone) return;
                        ggDone = true;
                        if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                        stage('http-done');
                        deliver([makeErrorFallback('Google search timeout', 'Periksa koneksi')]);
                    });
                    doPost(apiUrl, body, cancellable, (err, dataStr) => {
                        if (ggDone) return;
                        ggDone = true;
                        _cancelTimeout(ggTid);
                        if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                        stage('http-done');
                        if (err) {
                            deliver([makeErrorFallback('Google search tidak tersedia', 'Periksa koneksi atau API key')]);
                            return;
                        }
                        try {
                            const data = JSON.parse(dataStr);
                            const extra = parseGoogleJson(data, makeResult, scoreResult);
                            stage('parse-done');
                            if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                        } catch (e) { deliver([makeErrorFallback('Google: response tidak valid', 'Coba lagi')]); }
                    });
                } else {
                    // Production: Soup-based POST with Serper headers
                    try {
                        const s = ensureSession();
                        if (!s) return; // no Soup: fallback already delivered
                        const msg = Soup.Message.new('POST', apiUrl);
                        if (!msg) return;
                        // Set headers for Serper API
                        msg.request_headers.append('X-API-KEY', googleApiKey);
                        msg.request_headers.append('Content-Type', 'application/json');
                        if (GLib) {
                            try { msg.set_request_body_from_bytes('application/json', GLib.Bytes.new(String(body))); }
                            catch (e) { msg.set_request_body_from_bytes('application/json', new GLib.Bytes(String(body))); }
                        } else {
                            try { msg.set_request_body_from_bytes('application/json', new (require('gi.GLib').Bytes)(String(body))); }
                            catch (e) { }
                        }
                        let serperDone = false;
                        let serperTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                            if (serperDone) return;
                            serperDone = true;
                            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                            stage('http-done');
                            deliver([makeErrorFallback('Google search timeout', 'Periksa koneksi')]);
                        });
                        s.send_and_read_async(msg, (GLib ? GLib.PRIORITY_DEFAULT : 0), cancellable, (sess, res) => {
                            if (serperDone) return;
                            serperDone = true;
                            _cancelTimeout(serperTid);
                            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                            stage('http-done');
                            try {
                                const bytes = sess.send_and_read_finish(res);
                                const dataStr = new TextDecoder().decode(bytes.get_data());
                                // Check for Serper error responses
                                const status = msg.get_status();
                                if (status === 429) {
                                    deliver([makeErrorFallback('Google rate limited', 'Coba lagi nanti')]);
                                    return;
                                }
                                if (status >= 400) {
                                    deliver([makeErrorFallback('Google search error', 'Status ' + status)]);
                                    return;
                                }
                                const data = JSON.parse(dataStr);
                                const extra = parseGoogleJson(data, makeResult, scoreResult);
                                stage('parse-done');
                                if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                            } catch (e) { deliver([makeErrorFallback('Google: response tidak valid', 'Coba lagi')]); }
                        });
                    } catch (e) { /* Soup unavailable: fallback stands alone */ }
                }
            } catch (e) { /* Serper backend error: fallback stands alone */ }
            return;
        }

        // ── Bing backend ─────────────────────────────────────────────────
        // No API key required — fetch Bing HTML search results and parse
        // <li class="b_algo"> blocks. The fallback "Search on Bing" link
        // is already delivered above (instant, guaranteed). This upgrade
        // provides real results when the parse succeeds.
        if (engine === 'bing') {
            try {
                const htmlUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(q);
                stage('http-start');
                let bingDone = false;
                let bingTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                    if (bingDone) return;
                    bingDone = true;
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    deliver([makeErrorFallback('Bing search timeout', 'Periksa koneksi')]);
                });
                doGet(htmlUrl, cancellable, (err, dataStr) => {
                    if (bingDone) return;
                    bingDone = true;
                    _cancelTimeout(bingTid);
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    if (err) {
                        deliver([makeErrorFallback('Bing search tidak tersedia', 'Periksa koneksi')]);
                        return;
                    }
                    try {
                        const extra = parseBingHtml(dataStr, makeResult, scoreResult);
                        stage('parse-done');
                        if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                    } catch (e) { deliver([makeErrorFallback('Bing: response tidak valid', 'Coba lagi')]); }
                });
            } catch (e) { /* transport unavailable: fallback stands alone */ }
            return;
        }

        // ── DuckDuckGo backend (default) ───────────────────────────────
        // SEARCH mode: optional DDG instant-answer upgrade (engine-gated).
        const doInstant = useInstantAnswers && !isAgent;
        // AGENT mode: fetch REAL DuckDuckGo HTML results (works for ANY query).
        const doHtml = isAgent;

        if (doInstant) {
            try {
                ensureSession();
                const apiUrl = 'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' +
                    encodeURIComponent(q);
                stage('http-start');
                let ddgInstDone = false;
                let ddgInstTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                    if (ddgInstDone) return;
                    ddgInstDone = true;
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    deliver([makeErrorFallback('DDG search timeout', 'Periksa koneksi')]);
                });
                doGet(apiUrl, cancellable, (err, dataStr) => {
                    if (ddgInstDone) return;
                    ddgInstDone = true;
                    _cancelTimeout(ddgInstTid);
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    if (err) {
                        deliver([makeErrorFallback('DDG search tidak tersedia', 'Periksa koneksi')]);
                        return;
                    }
                    try {
                        const data = JSON.parse(dataStr);
                        if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;

                        const extra = [];
                        if (data.AbstractText && data.AbstractURL) {
                            extra.push(makeResult({
                                type: 'web',
                                title: String(data.AbstractText).slice(0, 120),
                                description: data.Heading || searchEngineLabel,
                                icon: 'web-browser',
                                score: scoreResult('web-instant'),
                                url: data.AbstractURL,
                                action: () => _openBrowser(data.AbstractURL)
                            }));
                        }
                        const topics = (data.RelatedTopics || []).filter(t => t.FirstURL && t.Text);
                        for (let i = 0; i < Math.min(topics.length, 4); i++) {
                            const t = topics[i];
                            extra.push(makeResult({
                                type: 'web',
                                title: String(t.Text).slice(0, 100),
                                description: t.FirstURL.replace(/^https?:\/\//, '').split('/')[0],
                                icon: 'web-browser',
                                score: scoreResult('web-instant'),
                                url: t.FirstURL,
                                action: () => _openBrowser(t.FirstURL)
                            }));
                        }
                        stage('parse-done');
                        if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                        else {
                            // DDG instant often has no web results for news queries – fall back to HTML path not available here
                            // Deliver fallback only is enough for SEARCH mode; for Agent this path is not used (doInstant false)
                            // Keep fallback only (already delivered) – no extra deliver to avoid duplicate
                        }
                    } catch (e) { deliver([makeErrorFallback('DDG: response tidak valid', 'Coba lagi')]); }
                });
            } catch (e) { /* Soup unavailable etc.: fallback stands alone */ }
        }

        if (doHtml) {
            try {
                ensureSession();
                const htmlUrl = 'https://html.duckduckgo.com/html/';
                const body = 'q=' + encodeURIComponent(q);
                stage('http-start');
                let ddgHtmlDone = false;
                let ddgHtmlTid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
                    if (ddgHtmlDone) return;
                    ddgHtmlDone = true;
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    deliver([makeErrorFallback('DDG search timeout', 'Periksa koneksi')]);
                });
                doPost(htmlUrl, body, cancellable, (err, dataStr) => {
                    if (ddgHtmlDone) return;
                    ddgHtmlDone = true;
                    _cancelTimeout(ddgHtmlTid);
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                    stage('http-done');
                    if (err) {
                        deliver([makeErrorFallback('DDG search tidak tersedia', 'Periksa koneksi')]);
                        return;
                    }
                    try {
                        const extra = parseDdgHtml(dataStr, makeResult, scoreResult);
                        stage('parse-done');
                        if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                    } catch (e) { deliver([makeErrorFallback('DDG: response tidak valid', 'Coba lagi')]); }
                });
            } catch (e) { /* Soup unavailable etc.: fallback stands alone */ }
        }
    }

    // fetch_page: reads ONE specific URL's text content back to the model —
    // no visible browser window (unlike open_url/_openBrowser). Reuses the
    // SAME timeout-safe session/doGet as search(), same _scheduleTimeout
    // idiom as the doHtml path above.
    function fetchPage(url, cancellable, cb) {
        cb = typeof cb === 'function' ? cb : () => {};
        if (!/^https?:\/\//i.test(String(url || ''))) { cb({ error: 'invalid-url' }); return; }
        try { ensureSession(); } catch (e) { cb({ error: 'session-unavailable' }); return; }
        let done = false;
        const tid = _scheduleTimeout(REQUEST_TIMEOUT_MS, () => {
            if (done) return;
            done = true;
            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
            cb({ error: 'timeout', message: 'Halaman tidak merespons' });
        });
        doGet(url, cancellable, (err, dataStr) => {
            if (done) return;
            done = true;
            _cancelTimeout(tid);
            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
            if (err) { cb({ error: 'fetch-failed', message: String(err) }); return; }
            try {
                const text = _htmlToText(String(dataStr || '').slice(0, 300000));
                cb(null, { url: url, text: text });
            } catch (e) { cb({ error: 'parse-failed' }); }
        });
    }

    function destroy() {
        session = null;
        searxngAvailable = null;
    }

    return { search, destroy, preflight, fetchPage };
}

function _openBrowser(url) {
    try {
        if (Gio) Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
    } catch (e) { /* never crash (spec 24-K) */ }
}

module.exports = { createWebProvider, REQUEST_TIMEOUT_MS, parseDdgHtml, parseGoogleJson, parseSearxngJson, parseBingHtml, WEB_ERRORS };
