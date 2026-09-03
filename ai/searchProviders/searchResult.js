// ai/searchProviders/searchResult.js — canonical SearchResult[] contract.
// Single shape shared by every boundary after a parser:
//   { title: string, url: string, snippet: string }
// Parsers emit SearchResult[]; WebSearchTool/grounding never see raw parser objects.
// Pure module: no I/O, no UI, no AI logic.

// URL validation must NOT depend on a global `URL` API: Cinnamon/GJS applet sandboxes are not
// guaranteed to provide it, and a throwing `new URL()` inside try/catch would discard EVERY valid
// parser-produced http(s) URL (runtime symptom: parsed_results > 0 but normalized_results = 0).
// Structural validation only, per the SearchResult contract:
//   string, trimmed, http:// or https:// scheme, host present, no whitespace/control chars,
//   no javascript:/data:/fragment-only URLs.
function isHttpUrl(u) {
    if (typeof u !== 'string') return false;
    const s = u.trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) return false;
    // scheme matched -> slice after "://"
    const rest = s.slice(s.indexOf('://') + 3);
    if (!rest) return false;
    // reject whitespace/control characters anywhere
    if (/[\s\u0000-\u001f]/.test(s)) return false;
    // host must not start with a structural separator (./ ? # : quote)
    if (/^[./?#:"]/.test(rest)) return false;
    return true;
}

function _dropReason(entry) {
    if (!entry || typeof entry !== 'object') return 'not_an_object';
    if (typeof entry.url !== 'string' || !isHttpUrl(entry.url)) return 'url_validation_failed';
    if (typeof entry.title !== 'string' || !entry.title.trim()) return 'missing_title';
    return null;
}

// Convert one parser/raw entry into a canonical SearchResult, or null when invalid.
// Only invalid items are dropped (bad URL, missing title); no silent mutation of valid items.
function normalizeSearchResult(entry) {
    if (_dropReason(entry)) return null;
    const url = String(entry.url).trim();
    const title = String(entry.title).trim();
    let snippet = '';
    if (typeof entry.snippet === 'string') snippet = entry.snippet;
    else if (typeof entry.content === 'string') snippet = entry.content;
    else if (typeof entry.description === 'string') snippet = entry.description;
    return {
        title: title.slice(0, 200),
        url,
        snippet: String(snippet || '').slice(0, 500)
    };
}

// Idempotent filter pass over raw results — same shape in, same shape out.
// When input > 0 but everything is dropped, log a compact reason (never a silent empty result),
// naming the first drop reason and whether a global URL API is present on this runtime.
function normalizeSearchResults(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let firstRawUrl = '-';
    let firstDrop = null;
    for (const entry of raw) {
        if (out.length === 0 && entry && typeof entry.url === 'string' && firstRawUrl === '-') {
            firstRawUrl = entry.url.trim().slice(0, 200) || '-';
        }
        const reason = _dropReason(entry);
        if (reason) {
            if (firstDrop === null) firstDrop = reason;
            continue;
        }
        const n = normalizeSearchResult(entry);
        if (n) out.push(n);
    }
    if (raw.length > 0 && out.length === 0 && firstDrop) {
        try {
            if (typeof global !== 'undefined' && typeof global.log === 'function') {
                const hasUrl = typeof globalThis !== 'undefined' && typeof globalThis.URL === 'function';
                global.log('[WebSearch] normalize raw_count=' + raw.length + ' normalized_count=0 first_raw_url=' + firstRawUrl + ' first_drop_reason=' + firstDrop + ' runtime=' + (hasUrl ? 'URL-available' : 'no-URL-API'));
            }
        } catch (e) {}
    }
    return out;
}

module.exports = { isHttpUrl, normalizeSearchResult, normalizeSearchResults };
