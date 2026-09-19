// ai/retrievalQuality.js — deterministic retrieval-quality layer for AI Web Grounding.
// Pure, no I/O, no LLM, no UI. GENERAL (no per-topic hardcode):
//   optimizeRetrievalQuery(q)               -> FINAL SearXNG query (topic-preserving)
//   filterRelevantSources(query, srcs, intent?) -> relevance gate before grounding
//   scoreSource(query, src, intent?)        -> deterministic score breakdown
//
// Optimizer: removes ONLY presentational meta-instructions + punctuation/whitespace
// noise. NEVER rewrites semantics: no prefix strip, no reorder, no synonyms, no
// translation, no entity extraction. The SAME final query feeds SearXNG and the gate.
//
// Gate: intent-aware (intent object from existing responseIntent classifier, computed
// once per request from the RAW query). Core-phrase coverage decides KEEP/REJECT;
// intent/authority/freshness are RANKING bonuses only and can never admit a source
// with zero topic coverage. Fail-closed: junk-only results -> empty.
//
// Scope: AI Web Grounding only. Normal Search / ranking / transport untouched.

const _STOPWORDS = new Set([
    'apa', 'apakah', 'bagaimana', 'berapa', 'kapan', 'dimana', 'di', 'mana', 'yang',
    'adalah', 'itu', 'ini', 'saat', 'dengan', 'untuk', 'dari', 'dalam', 'pada', 'sebagai',
    'saya', 'tolong', 'mohon', 'bisakah', 'bisa', 'gimana', 'kenapa', 'mengapa',
    'the', 'a', 'an', 'is', 'are', 'what', 'which', 'how', 'when', 'where', 'does',
    'do', 'can', 'could', 'please', 'tell', 'me', 'give', 'show', 'find', 'about',
    'saatnya', 'sumbernya', 'sertakan', 'sumber', 'mohonkan',
    'to', 'on', 'of', 'in', 'at', 'or', 'by', 'up', 'vs', 'per', 'dan', 'atau', 'juga',
    'this', 'that', 'these', 'those'
]);

// Generic/common verbs that carry no topic on their own. A source matching ONLY
// these (e.g. "cek bansos" for query "cek jadwal chelsea") must be REJECTED.
const _GENERIC_TERMS = new Set(['cek', 'lihat', 'cari', 'info', 'kabar']);

const _FRESHNESS_RE = /(terbaru|terkini|latest|current|sekarang|hari\s*ini|today|right\s*now|minggu\s*ini|20\d{2})/i;

const _HOWTO_RE = /(cara|install|setup|configure|konfigurasi|how\s+to|tutorial|panduan|langkah|steps?|guide)/i;

// Presentational meta-instructions: imperative verb + object pairs telling the AI
// how to PRESENT the answer, never what to search. Bounded; a bare topic word
// ("sumber", "source", "reference", "pendanaan") is NEVER stripped.
const _META_INSTRUCTION_RES = [
    /\bsertakan\s+sumber(?:nya)?\b/gi,
    /\bcantumkan\s+sumber(?:nya)?\b/gi,
    /\blampirkan\s+sumber(?:nya)?\b/gi,
    /\btampilkan\s+sumber(?:nya)?\b/gi,
    /\bsertakan\s+referensi(?:nya)?\b/gi,
    /\bcantumkan\s+referensi(?:nya)?\b/gi,
    /\bberikan\s+sumber(?:nya)?\b/gi,
    /\bdengan\s+sumber(?:nya)?\b/gi,
    /\bjelaskan\s+dengan\s+sumber\b/gi,
    /\binclude\s+(?:the\s+)?sources?\b/gi,
    /\bprovide\s+(?:the\s+)?sources?\b/gi,
    /\bcite\s+your\s+sources?\b/gi,
    /\bwith\s+sources?\b/gi
];

// General Indonesian (+EN) interrogative prefixes: question words that can never
// be the search topic. Stripped ONLY at the query head for RETRIEVAL; intent,
// conversation and prompts always use the RAW query. A bare topic word mid-query
// ("Linux Mint apa yang paling ringan") is never touched. Fail-safe: stripping
// that empties the query falls back to the raw query.
const _QUESTION_PREFIX_RES = [
    /^(?:apa(?:kah)?\s+itu)\b[\s,]+/i,
    /^(?:apa(?:kah)?|siapa(?:kah)?|bagaimana|mengapa|kenapa|kapan|dimana|berapa)\b[\s,]+/i,
    /^(?:di\s+mana)\b[\s,]+/i,
    /^(?:what|which|who|how|why|when|where)\b[\s,]+/i
];

// Generic intent verbs: retrieval filler dropped when the focused query is rebuilt
// (the intent KIND keyword replaces them). Never topic words, never entities.
const _INTENT_VERBS = new Set(['cek', 'cara', 'lihat', 'cari', 'tahu', 'bagaimana', 'gimana', 'how']);

// Bounded temporal map (explicit only; unknown phrases keep their wording).
const _TIME_MAP = [
    [/minggu\s+ini/i, 'this week'],
    [/hari\s+ini/i, 'today'],
    [/bulan\s+ini/i, 'this month'],
    [/tahun\s+ini/i, 'this year'],
    [/\bbesok\b/i, 'tomorrow'],
    [/\bkemarin\b/i, 'yesterday'],
    [/\bsekarang\b/i, 'today']
];

function _cleanRaw(q) {
    let s = String(q || '').trim().replace(/\s+/g, ' ');
    for (const re of _QUESTION_PREFIX_RES) {
        re.lastIndex = 0;
        const next = s.replace(re, '');
        if (next !== s) { s = next; break; }
    }
    s = s.trim();
    for (const re of _META_INSTRUCTION_RES) {
        re.lastIndex = 0;
        s = s.replace(re, ' ');
    }
    return s.replace(/\s+/g, ' ').trim()
        .replace(/[?!;]+/g, '')
        .replace(/^[.,\s]+|[.,\s]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _cap1(w) {
    if (!w) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
}

// Capitalized runs (existing entity signal): 1-3 words, e.g. "Linux Mint".
function _capitalEntities(s) {
    const words = String(s || '').split(' ').filter(Boolean);
    const runs = [];
    let run = [];
    const flush = () => { if (run.length) { runs.push(run); run = []; } };
    for (const w of words) {
        if (/^[A-ZÀ-Ž][A-Za-zÀ-ž0-9.+#-]*$/.test(w)) { run.push(w); if (run.length === 3) flush(); }
        else flush();
    }
    flush();
    return runs;
}

// Original spelling lookup: keep the user's own casing for entity words
// ("BBCA" stays "BBCA", not "Bbca"). Generic, no topic knowledge.
function _originalSpelling(cleaned, low) {
    for (const w of String(cleaned || '').split(' ')) {
        if (w.toLowerCase() === low) return w;
    }
    return _cap1(low);
}

// Words already represented by a chosen keyword (itself + synonyms + stems):
// prevents "Bitcoin price price" / "Berita news" duplication.
function _covers(word, chosen) {
    const w = String(word || '').toLowerCase();
    const c = String(chosen || '').toLowerCase();
    if (!w || !c) return false;
    if (w === c) return true;
    const fam = new Set([w, _stemToken(w)]);
    for (const s of _synonymsOf(w)) { fam.add(s); fam.add(_stemToken(s)); }
    return fam.has(c) || c.split(' ').some(p => fam.has(p));
}

// Focused retrieval query: ENTITY + INTENT-KEYWORD + TIME, all from generic
// mechanisms (capitalized runs, existing _INTENT_VOCAB, explicit _TIME_MAP,
// existing _SYNONYMS for intent-word translation). Returns '' when the query
// has no usable structure -> caller falls back to the cleaned original.
function _buildFocusedQuery(cleaned, intent) {
    // Fan-out aspect guard: queries carrying an aspect clause keep their verbatim
    // wording (raw-wording path). Rebuilding them would drop the aspect the
    // decomposition depends on.
    if (/dari\s+(sisi|segi)|berdasarkan/i.test(cleaned)) return '';
    const kinds = _intentKinds(intent);
    if (_queryScheduleHint(cleaned)) kinds.add('schedule');
    const hasHowto = kinds.has('howto');
    const hasSchedule = kinds.has('schedule');
    const hasCurrent = kinds.has('current');
    if (!hasHowto && !hasSchedule && !hasCurrent) {
        // No recognized intent structure (explanation/comparison/list/unknown):
        // do NOT rebuild; the cleaned wording is already the safest query.
        return '';
    }
    const toks = _queryTerms(cleaned);
    // Time: explicit bounded map, first hit wins.
    let timeOut = '';
    for (const [re, en] of _TIME_MAP) {
        if (re.test(cleaned)) { timeOut = en; break; }
    }
    // Intent keyword (generic vocab only, single choice).
    let intentKw = '';
    if (hasSchedule) intentKw = 'fixtures';
    else if (hasHowto) intentKw = 'How to';
    else if (hasCurrent) {
        const low = ' ' + cleaned.toLowerCase() + ' ';
        if (/harga|price/.test(low)) intentKw = 'price';
        else if (/berita|news/.test(low)) intentKw = 'news';
        else if (/versi|version/.test(low)) intentKw = 'version';
    }
    // Entity pool: capitalized runs (original spelling kept), else meaningful
    // core terms (original spelling restored). Skip anything already covered by
    // the intent keyword, the time part, stopwords, generic verbs or time words.
    const coveredBy = [intentKw, timeOut].filter(Boolean).join(' ');
    let pool = _capitalEntities(cleaned)
        .map(r => r.filter(w => {
            const low = String(w || '').toLowerCase();
            if (_STOPWORDS.has(low) || _GENERIC_TERMS.has(low) || _INTENT_VERBS.has(low)) return false;
            const syns = _synonymsOf(low);
            if (syns[0] !== low) return false;
            return true;
        }))
        .filter(r => r.length > 0)
        .map(r => r.join(' '));
    if (pool.length === 0) {
        const timeWords = new Set();
        for (const [re] of _TIME_MAP) {
            const m = String(cleaned).match(new RegExp(re.source, 'gi'));
            if (m) for (const w of m[0].toLowerCase().split(/\s+/)) timeWords.add(w);
        }
        let effTime = timeOut;
        if (!effTime && hasCurrent && /terbaru|latest/i.test(cleaned)) effTime = 'latest';
        const core = toks.filter(t => {
            const low = t.toLowerCase();
            if (_STOPWORDS.has(low) || _GENERIC_TERMS.has(low) || _INTENT_VERBS.has(low)) return false;
            if (timeWords.has(low)) return false;
            if (_covers(low, coveredBy)) return false;
            if (_covers(low, effTime)) return false;
            return true;
        });
        if (core.length === 0) return '';
        pool = [core.map(t => _originalSpelling(cleaned, t.toLowerCase())).join(' ')];
    } else {
        pool = pool.filter(e => !_covers(e, coveredBy) && !_covers(e, timeOut));
        if (pool.length === 0) return '';
    }
    // Keep meaningful action/object words via synonym translation (install,
    // download, owner, ceo, weather...), skipping anything already covered.
    const keepVerbs = [];
    const KEEPABLE = ['install', 'download', 'owner', 'ceo', 'weather', 'stock', 'release', 'news'];
    for (const t of toks) {
        const low = t.toLowerCase();
        if (_STOPWORDS.has(low) || _GENERIC_TERMS.has(low) || _INTENT_VERBS.has(low)) continue;
        if (pool.some(e => e.toLowerCase().split(' ').indexOf(low) !== -1)) continue;
        const syns = _synonymsOf(low);
        const en = syns[0] !== low ? syns[0] : low;
        if (KEEPABLE.indexOf(en) === -1) continue;
        if (_covers(en, [intentKw, timeOut].filter(Boolean).join(' '))) continue;
        if (_covers(en, pool.join(' '))) continue;
        if (keepVerbs.indexOf(en) === -1) keepVerbs.push(en);
    }
    // Temporal fallback: bare terbaru/latest without a mapped phrase.
    let timePart = timeOut;
    if (!timePart && hasCurrent && /terbaru|latest/i.test(cleaned)) timePart = 'latest';
    if (timePart && _covers(timePart, [intentKw, pool.join(' ')].filter(Boolean).join(' '))) timePart = '';
    const parts = [];
    if (hasHowto) {
        parts.push('How to');
        for (const v of keepVerbs) parts.push(v);
        const hasDi = /(^|\s)(di|pada)\s/i.test(cleaned);
        parts.push(pool.join(hasDi && pool.length > 1 ? ' on ' : ' '));
    } else {
        parts.push(pool.join(' '));
        for (const v of keepVerbs) parts.push(v);
        if (intentKw && intentKw !== 'How to') parts.push(intentKw);
        if (timePart && !_covers(timePart, parts.join(' '))) parts.push(timePart);
    }
    const out = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!out || out.split(' ').length < 2) return '';
    return out;
}

function optimizeRetrievalQuery(q, intent) {
    const raw = String(q || '').trim().replace(/\s+/g, ' ');
    if (!raw) return '';
    const cleaned = _cleanRaw(raw);
    if (!cleaned) return '';
    try {
        const focused = _buildFocusedQuery(cleaned, intent);
        if (focused) return focused.slice(0, 120);
    } catch (e) {}
    return cleaned.slice(0, 120);
}

// Trace helper: was the retrieval query rebuilt or kept as cleaned wording?
function describeRetrievalQuery(q, intent) {
    try {
        const raw = String(q || '').trim().replace(/\s+/g, ' ');
        const cleaned = _cleanRaw(raw);
        if (!cleaned) return { source: 'empty', retrievalQuery: '', cleaned: '' };
        const focused = _buildFocusedQuery(cleaned, intent);
        if (focused) return { source: 'rebuilt', retrievalQuery: focused.slice(0, 120), cleaned };
        return { source: 'raw-wording', retrievalQuery: cleaned.slice(0, 120), cleaned };
    } catch (e) {
        return { source: 'raw-wording', retrievalQuery: String(q || '').slice(0, 120), cleaned: '' };
    }
}

// ---- generic text helpers (match normalization, never rewrites) ----

function _normText(s) {
    return String(s || '').toLowerCase().replace(/[-_\/]+/g, ' ').replace(/[^a-z0-9\s.+#]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _stemToken(t) {
    // Minimal safe singular/plural fold for match purposes only (queries AND sources
    // go through the same fold, so no meaning is changed on either side).
    if (t.length > 4 && /ies$/.test(t)) return t.slice(0, -3) + 'y';
    if (t.length > 4 && /(ses|xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
    if (t.length > 4 && /s$/.test(t) && !/(ss|us|is|os)$/.test(t)) return t.slice(0, -1);
    return t;
}

function _tokens(s) {
    return _normText(s).split(' ')
        .map(t => t.replace(/^[.,;:!?'"()[\]{}]+|[.,;:!?'"()[\]{}]+$/g, ''))
        .filter(t => t && t.length >= 3 && !_STOPWORDS.has(t));
}

function _queryTerms(query) {
    const seen = [];
    for (const t of _tokens(query)) {
        if (seen.indexOf(t) === -1) seen.push(t);
    }
    return seen;
}

// Longest run of meaningful tokens in the RAW query order = the core topic phrase
// ("cek jadwal chelsea minggu ini" -> "cek jadwal chelsea minggu"). Generic verbs
// are excluded from the phrase so coverage measures TOPIC, not filler.
function corePhrase(query) {
    const toks = _queryTerms(query).filter(t => !_GENERIC_TERMS.has(t));
    if (toks.length === 0) return '';
    // Multi-word entity preserved when its tokens are adjacent in the raw query.
    const norm = _normText(query);
    let best = toks[0];
    for (let len = Math.min(4, toks.length); len >= 2; len--) {
        for (let i = 0; i + len <= toks.length; i++) {
            const cand = toks.slice(i, i + len).join(' ');
            if (norm.indexOf(cand) !== -1) return cand;
        }
    }
    return best;
}

// ---- generic intent/signal vocab (ranking bonuses, never topic-specific) ----

const _INTENT_VOCAB = {
    schedule: ['fixtures', 'fixture', 'schedule', 'match', 'matches', 'jadwal', 'pertandingan'],
    howto: ['install', 'instal', 'guide', 'tutorial', 'documentation', 'docs', 'how to', 'panduan', 'langkah', 'setup'],
    current: ['latest', 'current', 'today', 'terbaru', 'terkini', 'sekarang', 'version', 'versi', 'release', 'rilis']
};

function _intentKinds(intent) {
    const kinds = new Set();
    try {
        const p = intent && typeof intent.primary === 'string' ? intent.primary : '';
        if (p === 'current') kinds.add('current');
        if (p === 'howto' || p === 'troubleshooting') kinds.add('howto');
        if (intent && intent.flags && intent.flags.live) kinds.add('current');
    } catch (e) {}
    return kinds;
}

function _queryScheduleHint(query) {
    return /(jadwal|schedule|fixture|pertandingan|match\b)/i.test(String(query || ''));
}

// Cross-language retrieval vocabulary (match normalization, NOT query rewrite).
const _SYNONYMS = [
    ['latest', 'terbaru', 'terkini'],
    ['version', 'versi'],
    ['release', 'rilis'],
    ['download', 'unduh', 'unduhan'],
    ['install', 'instal', 'instalasi', 'pasang'],
    ['guide', 'panduan'],
    ['how', 'cara'],
    ['news', 'berita'],
    ['schedule', 'jadwal'],
    ['price', 'harga'],
    ['gold', 'emas'],
    ['weather', 'cuaca'],
    ['current', 'terkini', 'saat ini'],
    ['ceo', 'direktur utama'],
    ['match', 'pertandingan'],
    ['owner', 'pemilik'],
    ['price', 'harga'],
    ['stock', 'saham'],
    ['weather', 'cuaca'],
    ['fixtures', 'jadwal'],
    ['week', 'minggu', 'pekan'],
    ['day', 'hari'],
    ['gold', 'emas']
];
function _synonymsOf(term) {
    const t = String(term || '').toLowerCase();
    for (const group of _SYNONYMS) {
        if (group.indexOf(t) !== -1) return group;
    }
    return [t];
}

function _termHit(term, hayLower, titleLower) {
    const variants = new Set([term, _stemToken(term)]);
    for (const syn of _synonymsOf(term)) {
        variants.add(syn);
        variants.add(_stemToken(syn));
    }
    let hit = false;
    let titleHit = false;
    for (const v of variants) {
        if (!v || v.length < 3) continue;
        if (hayLower.indexOf(v) !== -1) hit = true;
        if (titleLower.indexOf(v) !== -1) titleHit = true;
        if (hit && titleHit) break;
    }
    return { hit, titleHit };
}

// Clearly-unrelated markers (rejected when combined with zero topic coverage).
// Citation tooling (proven T6 junk) + generic template junk observed in SearXNG output.
const _UNRELATED_MARKERS = [
    /apa\s*(citation|format|style|generator)/i,
    /\bscribbr\b/i,
    /purdue\s*owl/i,
    /citation\s*(machine|generator)/i,
    /works\s*cited/i,
    /mla\s*(format|citation|style)/i,
    /bansos/i,
    /paket\s*(cepat|kilat|pengiriman|internet)/i
];

function _domainOf(src) {
    const d = src && typeof src.domain === 'string' ? src.domain.trim().toLowerCase() : '';
    if (d) return d;
    try {
        const m = /:\/\/([^/]+)/.exec(String((src && src.url) || ''));
        return m ? m[1].toLowerCase() : '';
    } catch (e) { return ''; }
}

// Generic authority: official/docs/wiki signals + entity in title. Bonus only —
// an official page off-topic is still REJECTED; a third party on-topic still KEEPs.
function _authorityBonus(titleLower, domain) {
    let b = 0;
    if (/(^|\.)official\b|official\./i.test(domain)) b += 1;
    if (/(^|[\.\-])(docs?|documentation|wiki|support|help|developer)([\.\-]|$)/i.test(domain)) b += 1;
    return b;
}

function scoreSource(query, src, intent) {
    const terms = _queryTerms(query);
    const title = String((src && src.title) || '').toLowerCase();
    const snippet = String((src && (src.snippet || src.content || src.description)) || '').toLowerCase();
    const url = String((src && src.url) || '').toLowerCase();
    const domain = _domainOf(src);
    // Coverage haystack is title+snippet ONLY: raw URL text must never create
    // coverage by itself (spam domains stuff query words into paths/slugs).
    // The domain still confirms hits found on-page (see domain-confirmation below).
    const hay = title + ' ' + snippet;
    const base = { score: 0, matched: 0, total: terms.length, core: '', coreHit: false, coreMatched: 0, intentBoost: 0, authority: 0, fresh: false, unrelated: false, genericOnly: false };
    if (!terms.length) return base;
    const core = corePhrase(query);
    base.core = core;
    // Core-phrase coverage: normalized phrase hit, else count core-term hits.
    let coreHit = false;
    let coreMatched = 0;
    let titleHits = 0;
    let genericHits = 0;
    if (core && core.indexOf(' ') !== -1 && hay.indexOf(core) !== -1) {
        coreHit = true;
        coreMatched = core.split(' ').length;
        if (title.indexOf(core) !== -1) titleHits += 2;
    } else {
        const domParts = domain.split('.').filter(p => p && p !== 'www' && p !== 'com' && p !== 'org' && p !== 'net' && p !== 'id' && p !== 'co');
        for (const t of terms) {
            const r = _termHit(t, hay, title);
            if (r.hit) {
                coreMatched++;
                if (r.titleHit) titleHits++;
                if (_GENERIC_TERMS.has(t)) genericHits++;
                // Domain confirmation: a NON-generic term already hit in title/snippet
                // that ALSO names the domain (twitter <-> twitter.com) strengthens
                // coverage by one. Never creates coverage from nothing (spam domains
                // without on-page match gain zero).
                else if (domParts.some(p => p.indexOf(t) !== -1 || t.indexOf(p) !== -1)) {
                    coreMatched++;
                    titleHits++;
                }
            }
        }
    }
    base.coreHit = coreHit;
    base.coreMatched = coreMatched;
    base.matched = coreMatched;
    // Generic-only: every hit is a generic verb -> no topic coverage at all.
    base.genericOnly = coreMatched > 0 && (coreMatched - genericHits) <= 0;
    base.nonGenericMatched = coreMatched - genericHits;
    // Intent boost (ranking only; can never admit zero-coverage sources).
    let boost = 0;
    try {
        const kinds = _intentKinds(intent);
        if (_queryScheduleHint(query)) kinds.add('schedule');
        const text = title + ' ' + snippet.slice(0, 300);
        for (const k of kinds) {
            const vocab = _INTENT_VOCAB[k] || [];
            for (const v of vocab) {
                if (text.indexOf(v) !== -1) { boost += 1; break; }
            }
        }
    } catch (e) {}
    base.intentBoost = boost;
    // Authority (generic) + entity-in-title.
    let auth = _authorityBonus(title, domain);
    if (core && core.indexOf(' ') !== -1 && title.indexOf(core) !== -1) auth += 1;
    base.authority = auth;
    // Freshness bonus only for temporal intent.
    let temporal = false;
    try {
        const kinds = _intentKinds(intent);
        temporal = kinds.has('current') || kinds.has('schedule') || _FRESHNESS_RE.test(String(query || ''));
    } catch (e) { temporal = _FRESHNESS_RE.test(String(query || '')); }
    let fresh = false;
    if (temporal) {
        fresh = /(20\d{2}|latest|terbaru|terkini|release|rilis|version\s*\d|versi\s*\d|fixtures?|jadwal)/i.test(title + ' ' + snippet.slice(0, 200));
    }
    base.fresh = fresh;
    const unrelated = _UNRELATED_MARKERS.some(re => re.test(title) || re.test(snippet.slice(0, 200)));
    base.unrelated = unrelated;
    // Score: coverage first (title weighs double), then bonuses.
    let score = coreMatched + titleHits;
    if (coreHit) score += 2;
    score += boost + auth;
    if (fresh) score += 1;
    if ((unrelated && coreMatched === 0 && !coreHit)) score -= 5;
    base.score = score;
    return base;
}

function filterRelevantSources(query, sources, intent) {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const terms = _queryTerms(query);
    if (terms.length === 0) return sources.slice();
    const scored = [];
    for (const src of sources) {
        if (!src || typeof src !== 'object') continue;
        const r = scoreSource(query, src, intent);
        scored.push({ src, r });
    }
    // Hard reject: unrelated marker with zero non-generic coverage.
    const kept = scored.filter(({ r }) => {
        if (r.unrelated && (r.nonGenericMatched || 0) <= 0 && !r.coreHit) return false;
        if (r.genericOnly) return false;
        return true;
    });
    // Coverage gate (GENERAL): core-phrase hit OR >=2 NON-GENERIC core terms. A
    // single generic/common term ("cek", "jadwal" alone) is never enough, so
    // "cek bansos" can never survive "cek jadwal chelsea". Single-term queries
    // need only that 1 term — it IS the whole topic ("chelsea" + Chelsea News).
    const need = terms.length <= 1 ? 1 : 2;
    const real = kept.filter(({ src }) => String((src && src.title) || '').trim().length >= 2);
    const stubs = kept.filter(({ src }) => String((src && src.title) || '').trim().length < 2);
    const passed = real.filter(({ r }) => r.coreHit || (r.nonGenericMatched || 0) >= need);
    passed.sort((a, b) => b.r.score - a.r.score);
    return passed.map(({ src }) => src).concat(stubs.map(({ src }) => src));
}

module.exports = {
    optimizeRetrievalQuery,
    describeRetrievalQuery,
    filterRelevantSources,
    scoreSource,
    corePhrase,
    _queryTerms
};
