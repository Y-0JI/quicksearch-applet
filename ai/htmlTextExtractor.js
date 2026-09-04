// ai/htmlTextExtractor.js — pure HTML -> main-content text extraction (no DOM, no I/O).
// Safe for Cinnamon/GJS and node tests: regex/string only, no browser APIs.
// Goal: turn a fetched page into clean, readable text evidence — strip scripts/styles/
// navigation/footer/cookie noise, keep headings/lists/data, normalize whitespace — then
// pick the most query-relevant window (normal queries) or multi-window coverage (queries
// asking for complete data: "semua / lengkap / full list / all players").
const MIN_MAIN_CONTENT_CHARS = 160;
// Loose fallback extraction is accepted only when the strict extractor yielded almost nothing
// from a large page AND the loose pass still produces a real body of text.
const MIN_LOOSE_CONTENT_CHARS = 160;
// Below this raw size a page is "small" — a small extracted result is trusted as-is (no
// quality fallback needed); only big pages with tiny extraction trigger the loose retry.
const LOOSE_FALLBACK_RAW_MIN = 4000;

const _NOISE_LINES = new Set([
    'home', 'news', 'menu', 'login', 'log in', 'sign in', 'sign up', 'register', 'subscribe',
    'subscribe now', 'cookie', 'cookie policy', 'privacy', 'privacy policy', 'terms',
    'terms of service', 'terms & conditions', 'about us', 'about', 'contact', 'contact us',
    'advertisement', 'advertise', 'advertising', 'ad', 'follow us', 'share', 'search',
    'skip to content', 'skip navigation', 'all rights reserved', 'back to top', 'read more',
    'related articles', 'related posts', 'popular posts', 'you might also like', 'latest news',
    'more news', 'top stories', 'breaking news', 'newsletter', 'sign up for our newsletter',
    'accept cookies', 'accept all cookies', 'reject', 'close', 'close dialog', 'got it', 'ok',
    'facebook', 'twitter', 'x', 'instagram', 'youtube', 'linkedin', 'whatsapp', 'telegram',
    'tiktok', 'email', 'print', 'download', 'share this article', 'recommended', 'most read',
    'most popular', 'trending', 'load more', 'show more', 'view all', 'see all', 'next', 'previous'
]);

// Longer boilerplate phrases inside an otherwise real line (e.g. "Advertisement & banner here",
// "Home | News | Login | Subscribe | Cookie Policy") — matched case-insensitively as substrings.
const _NOISE_PHRASES = [
    'advertisement', 'advertise', 'subscribe', 'cookie policy', 'accept cookies', 'all cookies',
    'privacy policy', 'terms of service', 'terms & conditions', 'terms and conditions', 'terms of use',
    'all rights reserved', 'related articles', 'related posts', 'popular posts', 'you might also like',
    'latest news', 'breaking news', 'sign up for our newsletter', 'newsletter', 'follow us',
    'read more', 'back to top', 'skip to content', 'share this article', 'load more', 'show more',
    'see all', 'view all', 'home |', '| home', 'most read', 'most popular', 'trending now'
];

function _decodeEntities(s) {
    return String(s)
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return m; } })
        .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return m; } })
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&hellip;/g, '...')
        .replace(/&mdash;/g, '\u2014')
        .replace(/&ndash;/g, '\u2013')
        .replace(/&copy;/g, '\u00a9')
        .replace(/&reg;/g, '\u00ae')
        .replace(/&trade;/g, '\u2122')
        .replace(/&[a-z]+;/gi, ' ');
}

// Block-level tags become line breaks so headings/list items/paragraphs survive as lines.
const _BLOCK_TAG_RE = /<\s*\/(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|blockquote|pre|form|fieldset|details|summary|dl|dt|dd)\s*>|<\s*(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|blockquote|pre|form|fieldset|details|summary|dl|dt|dd|br|hr)\b[^>]*>/gi;

// Containers whose entire subtree is boilerplate (scripts/styles/ads/tracking…).
// nav/header/footer are NOT dropped wholesale (article titles often live in a <header>);
// they become line boundaries and their nav-like text is filtered by the noise rules.
const _DROP_BLOCK_RE = /<\s*(?:script|style|noscript|template|svg|head|iframe|canvas|object|embed|applet)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style|noscript|template|svg|head|iframe|canvas|object|embed|applet)\s*>/gi;

function _looksLikeNavLine(line) {
    const low = line.toLowerCase();
    // pipe-separated nav bars: "Home | News | Login | Subscribe | Cookie Policy"
    const parts = line.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 3 && parts.every(p => _NOISE_LINES.has(p.toLowerCase()))) return true;
    if (_NOISE_LINES.has(low)) return true;
    for (const phrase of _NOISE_PHRASES) {
        if (low.indexOf(phrase) !== -1) return true;
    }
    return false;
}

// Shared text-assembly from raw html (entities decoded). `filterNoise` toggles aggressive
// nav/footer/cookie filtering — strict extraction enables it, the loose fallback disables it
// so real content is never lost just because it sat next to boilerplate words.
function _htmlToLines(html, filterNoise) {
    let s = String(html == null ? '' : html);
    // 1. comments
    s = s.replace(/<!--[\s\S]*?-->/g, '');
    // 2. drop boilerplate containers (repeat until stable to handle nesting)
    let prev = null;
    let guard = 0;
    while (prev !== s && guard < 10) {
        prev = s;
        s = s.replace(_DROP_BLOCK_RE, '\n');
        guard++;
    }
    // 3. list items become bullet lines so list structure survives as lines
    s = s.replace(/<\s*li\b[^>]*>/gi, '\n- ');
    s = s.replace(/<\s*\/\s*li\s*>/gi, '\n');
    // 4. block tags -> newlines
    s = s.replace(_BLOCK_TAG_RE, '\n');
    // 5. remaining tags stripped
    s = s.replace(/<[^>]+>/g, '');
    // 6. entities + whitespace normalize
    s = _decodeEntities(s);
    const rawLines = s.split('\n').map(line => line.replace(/\s+/g, ' ').trim());
    const lines = [];
    for (const line of rawLines) {
        if (!line) continue;
        if (line.length < 2) continue;
        if (/^[\s\-–—•*·|:=~_#]+$/.test(line)) continue; // decorative rule / bullets only
        if (filterNoise && _looksLikeNavLine(line)) continue;
        if (/^(https?:\/\/|www\.)/i.test(line) && !/\s/.test(line)) continue; // bare link rows
        const prevLine = lines[lines.length - 1];
        if (prevLine && prevLine === line) continue; // consecutive duplicate
        lines.push(line);
    }
    // 7. non-consecutive duplicates of long template paragraphs
    const seen = new Set();
    const out = [];
    for (const line of lines) {
        if (line.length > 40) {
            const key = line.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(line);
    }
    return out;
}

function extractMainText(html) {
    return _htmlToLines(html, true).join('\n');
}

// P2-2 fallback strategy: keep everything the aggressive pass would have filtered (nav words
// inside real lines etc.) — used only when strict extraction on a large page returned very
// little, to avoid sending near-empty "content" to the AI.
function extractMainTextLoose(html) {
    return _htmlToLines(html, false).join('\n');
}

// ── full-data intent detection ────────────────────────────────────────────────────────────
// Queries asking for the COMPLETE data of a page (all players, full squad, complete list)
// must not collapse to a single relevance window — they need broad coverage instead.
const _FULL_INTENT_PHRASES = [
    // Indonesian
    'semua', 'seluruh', 'lengkap', 'lengkapnya', 'daftar lengkap', 'seluruh daftar',
    'semua pemain', 'seluruh pemain', 'skuad lengkap', 'full squad', 'semua daftar',
    'siapa saja', 'apa saja', 'list semua', 'semua anggota', 'semua peserta', 'semua tim',
    // English
    'all ', 'full list', 'list all', 'all players', 'full squad', 'complete list',
    'full roster', 'every player', 'every member', 'whole list', 'the entire', 'entire list',
    'all members', 'all teams', 'who are all', 'list everyone', 'everyone'
];
function _hasFullIntentPhrase(low) {
    for (const p of _FULL_INTENT_PHRASES) {
        if (low.indexOf(p) !== -1) return true;
    }
    return false;
}
function isFullContentIntent(query) {
    const low = String(query || '').toLowerCase();
    if (_hasFullIntentPhrase(low)) return true;
    const tokens = queryTokens(low);
    // "tulis semua pemainnya" — the phrase list covers 'semua'; token-only heuristic:
    // queries containing a completeness token plus a content noun (players/members/etc.)
    const completeness = ['semua', 'seluruh', 'lengkap', 'daftar', 'all', 'list', 'full', 'every'];
    const nouns = ['pemain', 'player', 'anggota', 'member', 'peserta', 'tim', 'team', 'skuad', 'squad', 'roster', 'peserta', 'pemenang', 'pemainnya', 'klub'];
    const hasComp = tokens.some(t => completeness.indexOf(t) !== -1);
    const hasNoun = tokens.some(t => nouns.indexOf(t) !== -1);
    return hasComp && hasNoun;
}

// ── query-aware window selection (normal queries) ─────────────────────────────────────────
const _STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'what', 'when', 'where', 'which', 'who', 'how', 'are', 'was', 'were', 'all', 'any', 'bisa', 'yang', 'dan', 'untuk', 'dengan', 'dari', 'tidak', 'ini', 'itu', 'atau', 'pada', 'hari', 'ada', 'ke', 'di', 'saat', 'semua', 'para', 'tentang', 'akan', 'sudah', 'belum']);

function queryTokens(query) {
    const q = String(query || '').toLowerCase();
    const toks = q.match(/[^\s,.:;!?"'()[\]]+/g) || [];
    const out = [];
    const seen = new Set();
    for (const t of toks) {
        if (t.length < 3) continue;
        if (_STOPWORDS.has(t)) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function _scoreLine(line, tokens) {
    const l = String(line || '').toLowerCase();
    let score = 0;
    for (const t of tokens) {
        // token as whole-ish word (word boundary via spaces/punct — avoids "man" in "manager")
        if (new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(l)) score++;
    }
    return score;
}

function _lineLen(lines, from, to) {
    let n = 0;
    for (let k = from; k <= to; k++) n += lines[k].length + 1;
    return n;
}

// P5: single relevance window for normal queries. maxChars applies to the returned length.
function selectRelevantWindow(text, query, maxChars) {
    const t = text == null ? '' : String(text);
    if (!t) return '';
    const max = (typeof maxChars === 'number' && maxChars > 0) ? Math.floor(maxChars) : t.length;
    if (t.length <= max) return t;
    const tokens = queryTokens(query);
    if (!tokens.length) return t.slice(0, max);
    const lines = t.split('\n');
    const scores = lines.map(line => _scoreLine(line, tokens));
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] > bestScore) { bestScore = scores[i]; best = i; }
    }
    if (bestScore === 0) return t.slice(0, max); // no signal -> head of content
    // Tightest span covering all matched lines
    let lo = best;
    let hi = best;
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] > 0) { if (i < lo) lo = i; if (i > hi) hi = i; }
    }
    if (_lineLen(lines, lo, hi) <= max) {
        // pad equally around the matched span while budget allows
        let a = lo, b = hi;
        let grew = true;
        while (grew) {
            grew = false;
            if (a > 0 && _lineLen(lines, a - 1, b) <= max) { a--; grew = true; }
            if (b < lines.length - 1 && _lineLen(lines, a, b + 1) <= max) { b++; grew = true; }
        }
        return lines.slice(a, b + 1).join('\n');
    }
    // matched span itself exceeds budget -> keep a window centered on the best-scoring line,
    // biasing to earlier matched lines first (they usually carry the core data).
    let a = best, b = best;
    const need = max;
    let cur = lines[best].length + 1;
    let dir = 'left';
    while (cur < need) {
        if (dir === 'left') {
            if (a > 0) { a--; cur += lines[a].length + 1; } else dir = 'right';
        } else {
            if (b < lines.length - 1) { b++; cur += lines[b].length + 1; } else dir = 'left';
        }
        if (a === 0 && b === lines.length - 1) break;
    }
    return lines.slice(a, b + 1).join('\n').slice(0, max);
}

// ── P1-1 multi-window coverage for FULL-DATA queries ──────────────────────────────────────
// A single relevance window can cut whole sections of a long list page (Kiper/Bek/Gelandang/
// Penyerang…), so for full-content intent we force three anchors that must always survive — the
// page head, the best query-matched line (or the document centre when nothing matches), and the
// page tail (where list continuations usually live) — then fill whatever budget remains with
// whole lines in document order. Because the anchors are reserved BEFORE filling, an oversized
// head paragraph can never starve the tail, and an oversized gap never drops the match. The
// result is a best-effort view of the whole page capped at `maxChars`.
function buildFullContentWindows(text, query, maxChars) {
    const t = text == null ? '' : String(text);
    if (!t) return '';
    const max = (typeof maxChars === 'number' && maxChars > 0) ? Math.floor(maxChars) : t.length;
    if (t.length <= max) return t;
    const lines = t.split('\n');
    const n = lines.length;
    const tokens = queryTokens(query);
    const scores = lines.map(line => _scoreLine(line, tokens));

    // anchor = index of the best query-matched line, or the document centre
    let centre = -1;
    let bestScore = 0;
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] > bestScore) { bestScore = scores[i]; centre = i; }
    }
    if (centre === -1 || bestScore === 0) centre = Math.floor(n / 2);

    // unique anchors in document order: head (0), match/centre, tail (n-1)
    const anchorIdx = [];
    for (const i of [0, centre, n - 1]) {
        if (i >= 0 && i < n && anchorIdx.indexOf(i) === -1) anchorIdx.push(i);
    }
    anchorIdx.sort((a, b) => a - b);

    // reserve the anchors first so a giant head/tail paragraph cannot starve the others
    const chosen = new Map();
    let forced = 0;
    for (const i of anchorIdx) {
        chosen.set(i, lines[i]);
        forced += lines[i].length + 1; // + newline accounting
    }
    if (forced > max) {
        // Budget is smaller than the anchor lines themselves, so whole lines cannot fit.
        // Keep every anchor represented by slicing each to an equal share of the budget
        // (reservation pool: an anchor shorter than its share returns the difference, which
        // is re-granted first to the query-matched anchor, then to the others). This way the
        // query-relevant list region is never dropped just because head/tail paragraphs are
        // enormous.
        const k = anchorIdx.length;
        const base = Math.max(1, Math.floor(max / k));
        const slices = new Map();
        let pool = 0;
        for (const i of anchorIdx) {
            if (lines[i].length <= base) {
                slices.set(i, lines[i]);
                pool += base - lines[i].length;
            } else {
                slices.set(i, null); // pending long anchor
            }
        }
        const order = anchorIdx.slice().sort((a, b) => ((b === centre) ? 1 : 0) - ((a === centre) ? 1 : 0));
        for (const i of order) {
            if (slices.get(i) !== null || pool <= 0) continue;
            const take = Math.min(lines[i].length, base + pool);
            slices.set(i, lines[i].slice(0, take));
            pool -= take - base;
        }
        for (const i of anchorIdx) {
            if (slices.get(i) === null) slices.set(i, lines[i].slice(0, base));
        }
        const parts = anchorIdx.map(i => slices.get(i)).filter(s => s.length > 0);
        const joined = parts.join('\n');
        return joined.length > max ? joined.slice(0, max) : joined;
    }

    // fill remaining budget with whole lines in document order (skip anchors, skip lines that
    // do not fit; a later shorter line may still fit in the leftover)
    let remaining = max - forced;
    for (let i = 0; i < n && remaining > 0; i++) {
        if (chosen.has(i)) continue;
        const need = lines[i].length + 1;
        if (need > remaining) continue;
        chosen.set(i, lines[i]);
        remaining -= need;
    }

    // merge in document order; join adds one \n per gap, so the result is <= accounted budget
    const idxs = Array.from(chosen.keys()).sort((a, b) => a - b);
    return idxs.map(i => chosen.get(i)).join('\n');
}

module.exports = {
    extractMainText,
    extractMainTextLoose,
    selectRelevantWindow,
    buildFullContentWindows,
    isFullContentIntent,
    queryTokens,
    MIN_MAIN_CONTENT_CHARS,
    MIN_LOOSE_CONTENT_CHARS,
    LOOSE_FALLBACK_RAW_MIN
};
