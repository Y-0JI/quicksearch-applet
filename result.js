// Result layer: classification, normalization, dedupe, scoring, pipeline.
// Pure module: works under Cinnamon CJS loader AND node --test.
const { detectUrl } = require('./providers/urlProvider.js');
const { tryCalculate } = require('./providers/calculatorProvider.js');

// ---- Query classification (spec §13): calc/url are exclusive, else generic ----
function classifyQuery(query) {
    if (detectUrl(query)) {
        return { calc: false, url: true, apps: false, files: false, web: false };
    }
    if (tryCalculate(query)) {
        return { calc: true, url: false, apps: false, files: false, web: false };
    }
    return { calc: false, url: false, apps: true, files: true, web: true };
}

// ---- Score tiers (spec §15) ----
const SCORES = {
    calc: 400,
    url: 400,
    'app-exact': 300,
    'app-prefix': 250,
    'app-contains': 200,
    keyword: 150,
    'file-exact': 180,
    'file-prefix': 160,
    'file-contains': 120,
    'web-instant': 90,
    'web-fallback': 50
};

function scoreResult(quality) {
    return SCORES[quality] || 0;
}

// ---- Normalization: uniform result shape (spec §14) ----
function makeResult(fields) {
    const r = {
        type: fields.type,          // 'app' | 'file' | 'web' | 'calc' | 'url'
        title: String(fields.title || ''),
        description: fields.description || '',
        icon: fields.icon || null,   // GIcon or icon name string; UI decides how to render
        score: fields.score || 0,
        action: fields.action || null
    };
    if (fields.url !== undefined) r.url = fields.url;
    if (fields.path !== undefined) r.path = fields.path;
    if (fields.appId !== undefined) r.appId = fields.appId;
    if (fields.value !== undefined) r.value = fields.value;
    r.id = _stableId(r);
    return r;
}

function _stableId(r) {
    switch (r.type) {
        case 'app': return '/a/' + (r.appId || r.title.toLowerCase());
        case 'file': return '/f/' + r.path;
        case 'web':
        case 'url': return '/' + (r.type === 'url' ? 'u' : 'w') + '/' + canonicalUrl(r.url);
        default: return '/c/' + r.title;
    }
}

function canonicalUrl(url) {
    try {
        // ponytail: string-level canonicalization only; full URL spec compliance not needed for dedup
        let u = url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        const hostSlash = u.indexOf('/');
        const host = (hostSlash === -1 ? u : u.slice(0, hostSlash)).toLowerCase();
        const rest = hostSlash === -1 ? '' : u.slice(hostSlash);
        return host + rest + (rest === '' ? '/' : '');
    } catch (e) {
        return url;
    }
}

// ---- Dedup by stable id (spec 24-D) ----
function dedupeResults(results) {
    const seen = new Set();
    const out = [];
    for (const r of results) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
    }
    return out;
}

// ---- Pipeline: merge → dedupe → sort → per-type limit (spec 24-J/E) ----
function processResults(lists, limits) {
    const merged = dedupeResults([].concat(...lists));
    merged.sort((a, b) => b.score - a.score);
    const counts = { app: 0, file: 0, web: 0, calc: 0, url: 0 };
    const out = [];
    for (const r of merged) {
        const lim = limits[r.type];
        if (lim !== undefined) {
            if ((counts[r.type] || 0) >= lim) continue;
            counts[r.type]++;
        }
        out.push(r);
    }
    return out;
}

module.exports = { classifyQuery, makeResult, dedupeResults, scoreResult, processResults, canonicalUrl, SCORES };
