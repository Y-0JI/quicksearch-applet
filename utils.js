// Pure helpers (node-testable).

function pickFileBackend(avail) {
    if (avail.hasPlocate) return 'plocate';
    if (avail.hasLocate) return 'locate';
    if (avail.hasFind) return 'find';
    return null;
}

// strip glob metachars so user query can't alter find pattern semantics
function sanitizeGlob(query) {
    return String(query).replace(/[\\*?\[\]]/g, '');
}

// local history/suggestion rows for the typed query.
// history: stored queries with case-insensitive prefix match, excluding the
// exact active query. suggestions: app-name completions not already shown
// as history. Empty query -> nothing (empty state must stay strict).
function buildLocalRows(query, recent, appNames, caps) {
    caps = caps || { history: 3, suggestion: 3 };
    const q = String(query || '').toLowerCase().trim();
    const out = { history: [], suggestion: [] };
    if (!q) return out;

    const seen = {};
    for (const h of (recent || [])) {
        const hl = String(h).toLowerCase().trim();
        if (!hl || hl === q || seen[hl]) continue;
        if (!hl.startsWith(q)) continue;
        out.history.push(String(h));
        seen[hl] = true;
        if (out.history.length >= caps.history) break;
    }
    for (const a of (appNames || [])) {
        const al = String(a).toLowerCase().trim();
        if (!al || seen[al] || !al.startsWith(q)) continue;
        out.suggestion.push(String(a));
        seen[al] = true;
        if (out.suggestion.length >= caps.suggestion) break;
    }
    return out;
}

// normalize a raw search-engine setting into a valid engine id.
// accepts ids and legacy/human labels (case-insensitive); returns null for
// anything unrecognized so the caller can log and apply its default.
const ENGINE_IDS = ['ddgo', 'google', 'bing'];
const ENGINE_ALIASES = {
    'ddgo': 'ddgo', 'duckduckgo': 'ddgo', 'duck duck go': 'ddgo',
    'google': 'google',
    'bing': 'bing'
};
function normalizeSearchEngine(raw) {
    const k = String(raw == null ? '' : raw).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(ENGINE_ALIASES, k) ? ENGINE_ALIASES[k] : null;
}

module.exports = { pickFileBackend, sanitizeGlob, buildLocalRows, normalizeSearchEngine, ENGINE_IDS };
