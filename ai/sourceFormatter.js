// ai/sourceFormatter.js — pure, no I/O
function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:\/\/.+/i.test(u.trim());
}

function normalizeSource(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isHttpUrl(url)) return null;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) return null;
    const snippet = typeof entry.snippet === 'string' ? entry.snippet
        : typeof entry.content === 'string' ? entry.content
        : typeof entry.description === 'string' ? entry.description : '';
    return { title: title.slice(0, 200), url, snippet: String(snippet).slice(0, 500) };
}

function formatSources(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const e of raw) {
        const n = normalizeSource(e);
        if (n) out.push(n);
    }
    return out;
}

module.exports = { formatSources, normalizeSource, isHttpUrl };
