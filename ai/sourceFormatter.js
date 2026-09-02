// ai/sourceFormatter.js — pure, no I/O
// Normalization boundary for AI-5 sources. Validated HTTP/HTTPS only, title fallback, dedup.
function isHttpUrl(u) {
    if (typeof u !== 'string') return false;
    const s = u.trim();
    if (!s) return false;
    if (!/^https?:\/\/.+/i.test(s)) return false;
    try {
        const parsed = new URL(s);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) { return false; }
}

function normalizeSource(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isHttpUrl(url)) return null;
    let title = typeof entry.title === 'string' ? entry.title.trim() : '';
    let domain = '';
    try {
        const parsed = new URL(url);
        domain = parsed.hostname || '';
    } catch (e) { domain = ''; }
    // title fallback: provider title → domain → URL (AI-5 §4)
    if (!title) {
        if (domain) title = domain;
        else title = url;
        title = String(title).trim();
        if (!title) return null;
    }
    const snippet = typeof entry.snippet === 'string' ? entry.snippet
        : typeof entry.content === 'string' ? entry.content
        : typeof entry.description === 'string' ? entry.description : '';
    return { title: title.slice(0, 200), url, domain, snippet: String(snippet).slice(0, 500) };
}

function normalizeDedupeKey(url) {
    const raw = String(url || '').trim();
    try {
        const u = new URL(raw);
        const protocol = u.protocol.toLowerCase();
        const hostname = u.hostname.toLowerCase();
        const port = u.port ? ':' + u.port : '';
        let pathname = u.pathname || '/';
        if (pathname === '/') pathname = '/';
        return protocol + '//' + hostname + port + pathname + u.search + u.hash;
    } catch (e) {
        return raw.toLowerCase();
    }
}

function formatSources(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const e of raw) {
        const n = normalizeSource(e);
        if (!n) continue;
        const key = normalizeDedupeKey(n.url);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
    }
    return out;
}

module.exports = { formatSources, normalizeSource, isHttpUrl, normalizeDedupeKey };
