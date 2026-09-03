// ai/searchProviders/searchResult.js — canonical SearchResult[] contract.
// Single shape shared by every boundary after a parser:
//   { title: string, url: string, snippet: string }
// Parsers emit SearchResult[]; WebSearchTool/grounding never see raw parser objects.
// Pure module: no I/O, no UI, no AI logic.

function isHttpUrl(u) {
    if (typeof u !== 'string') return false;
    const s = u.trim();
    if (!s) return false;
    if (!/^https?:\/\//i.test(s)) return false;
    try {
        const parsed = new URL(s);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

// Convert one parser/raw entry into a canonical SearchResult, or null when invalid.
// Only invalid items are dropped (bad URL, missing title); no silent mutation of valid items.
function normalizeSearchResult(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isHttpUrl(url)) return null;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) return null;
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
function normalizeSearchResults(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const entry of raw) {
        const n = normalizeSearchResult(entry);
        if (n) out.push(n);
    }
    return out;
}

module.exports = { isHttpUrl, normalizeSearchResult, normalizeSearchResults };
