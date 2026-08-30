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
// matching: case-insensitive substring anywhere (exact > prefix > substring,
// earlier match position wins); ranking preserves source order within a tier.
// history: stored queries, excluding the exact active query.
// suggestions: app-name completions not already shown as history.
// Empty query -> nothing (empty state must stay strict).
function buildLocalRows(query, recent, appNames, caps) {
    caps = caps || { history: 3, suggestion: 3 };
    const q = String(query || '').toLowerCase().trim();
    const out = { history: [], suggestion: [] };
    if (!q) return out;

    const seen = {};
    // rank candidates once: [tier, matchIndex, sourceOrder] ascending wins;
    // tiers: -1 = exact, 0 = prefix, 1 = substring
    const collect = (items, isHistory) => {
        const scored = [];
        (items || []).forEach((item, order) => {
            const raw = String(item);
            const v = raw.toLowerCase().trim();
            if (!v || seen[v]) return;
            const i = v.indexOf(q);
            if (i < 0) return;
            if (isHistory && i === 0 && v.length === q.length) return; // active query hidden
            const tier = i === 0 ? (v.length === q.length ? -1 : 0) : 1;
            scored.push({ value: raw.trim(), tier: tier, i: i, order: order });
        });
        scored.sort((a, b) => a.tier - b.tier || a.i - b.i || a.order - b.order);
        return scored;
    };

    for (const s of collect(recent, true)) {
        if (out.history.length >= caps.history) break;
        out.history.push(s.value);
        seen[s.value.toLowerCase()] = true;
    }
    for (const s of collect(appNames, false)) {
        const k = s.value.toLowerCase();
        if (seen[k]) continue;
        if (out.suggestion.length >= caps.suggestion) break;
        out.suggestion.push(s.value);
        seen[k] = true;
    }
    return out;
}

// normalize a raw search-engine setting into a valid engine id.
// accepts ids and legacy/human labels (case-insensitive); returns null for
// anything unrecognized so the caller can log and apply its default.
const ENGINE_ALIASES = {
    'ddgo': 'ddgo', 'duckduckgo': 'ddgo', 'duck duck go': 'ddgo',
    'google': 'google', 'google (serper api)': 'google', 'bing': 'bing',
    'searxng': 'searxng', 'searxng (local)': 'searxng'
};
function normalizeSearchEngine(raw) {
    const k = String(raw == null ? '' : raw).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(ENGINE_ALIASES, k) ? ENGINE_ALIASES[k] : null;
}

module.exports = { pickFileBackend, sanitizeGlob, buildLocalRows, normalizeSearchEngine };
