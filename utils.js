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

// Settings classification (presentation-only).
// PRIMARY: dynamic discovery — membership in the LOCAL Cinnamon System Settings
// registry. The authoritative local signals, read at runtime from each app's
// desktop entry on the machine where the applet runs:
//   - Exec starts with "cinnamon-settings" (every native settings module), or
//   - X-Cinnamon-Settings-Panel key present (hardware panels)
// No module names are listed: a different machine with different modules gets
// a different membership automatically.
// FALLBACK (only when the desktop-entry signals above are unavailable, e.g.
// legacy hand-written tests): title+description match settings/pengaturan/
// preferensi. Generic Categories=Settings alone NEVER qualifies — it would
// promote unrelated third-party apps. Type must be 'app'; never files.
function isSettingsApp(r) {
    if (!r || r.type !== 'app') return false;
    try {
        const execTokens = String(r.execLine || r.executable || '').toLowerCase().trim().split(/\s+/);
        const execBase = (execTokens[0] || '').split('/').pop();
        if (execBase === 'cinnamon-settings' || execBase === 'cinnamon-settings-users') return true;
        if (String(r.settingsPanel || '').trim()) return true;
        if (String(r.gnomePanel || '').trim()) return true;
        if (String(r.gnomeSystem || '').trim()) return true;
        const catSet = {};
        try {
            const parts = String(r.categories || '').split(';');
            for (let i = 0; i < parts.length; i++) { const c = parts[i].trim(); if (c) catSet[c] = true; }
        } catch (e2) {}
        if (catSet['Settings'] && (catSet['HardwareSettings'] || catSet['Security']) &&
            !catSet['Utility'] && !catSet['X-GNOME-Utilities']) return true;
    } catch (e) {}
    const hay = String(r.title || '').toLowerCase() + ' ' + String(r.description || '').toLowerCase();
    return hay.indexOf('settings') !== -1 || hay.indexOf('pengaturan') !== -1 || hay.indexOf('preferensi') !== -1;
}

module.exports = { pickFileBackend, sanitizeGlob, buildLocalRows, normalizeSearchEngine, isSettingsApp };
