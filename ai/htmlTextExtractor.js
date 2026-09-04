// ai/htmlTextExtractor.js — pure HTML -> main-content text extraction (no DOM, no I/O).
// Safe for Cinnamon/GJS and node tests: regex/string only, no browser APIs.
// Goal: turn a fetched page into clean, readable text evidence — strip scripts/styles/
// navigation/footer/cookie noise, keep headings/lists/data, normalize whitespace —
// then pick the most query-relevant window when a per-source character cap applies.

const MIN_MAIN_CONTENT_CHARS = 160;

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
const _BLOCK_TAG_RE = /<\s*\/(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|blockquote|pre|form|fieldset|details|summary|dl|dt|dd)\s*>|<\s*(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|blockquote|pre|form|fieldset|details|summary|dl|dt|dd|br|hr|li)\b[^>]*>/gi;

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

function extractMainText(html) {
    if (html == null) return '';
    let s = String(html);
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
    // 3. block tags -> newlines
    s = s.replace(_BLOCK_TAG_RE, '\n');
    // 4. remaining tags stripped
    s = s.replace(/<[^>]+>/g, '');
    // 5. entities + whitespace normalize
    s = _decodeEntities(s);
    const rawLines = s.split('\n').map(line => line.replace(/\s+/g, ' ').trim());
    const lines = [];
    for (const line of rawLines) {
        if (!line) continue;
        if (line.length < 2) continue;
        if (/^[\s\-–—•*·|:=~_#]+$/.test(line)) continue; // decorative rule / bullets only
        if (_looksLikeNavLine(line)) continue;
        if (/^(https?:\/\/|www\.)/i.test(line) && !/\s/.test(line)) continue; // bare link rows
        const prevLine = lines[lines.length - 1];
        if (prevLine && prevLine === line) continue; // consecutive duplicate
        lines.push(line);
    }
    // 6. non-consecutive duplicates of long template paragraphs
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
    return out.join('\n');
}

// ── query-aware window selection ─────────────────────────────────────────────────────────
// Instead of blindly taking the first `maxChars` of a page, locate the region that best
// matches the user query (ranked lines), then expand around it to the budget. Falls back to
// the page head when no query token matches (no signal available).
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

// P5: content window selection. maxChars applies to the returned string length.
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
    function spanLen(a, b) {
        let n = 0;
        for (let k = a; k <= b; k++) n += lines[k].length + 1;
        return n;
    }
    if (spanLen(lo, hi) <= max) {
        // pad equally around the matched span while budget allows
        let a = lo, b = hi;
        let grew = true;
        while (grew) {
            grew = false;
            if (a > 0 && spanLen(a - 1, b) <= max) { a--; grew = true; }
            if (b < lines.length - 1 && spanLen(a, b + 1) <= max) { b++; grew = true; }
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

module.exports = { extractMainText, selectRelevantWindow, queryTokens, MIN_MAIN_CONTENT_CHARS };
