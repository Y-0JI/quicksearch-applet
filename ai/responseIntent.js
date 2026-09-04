// ai/responseIntent.js — pure, deterministic query intent classifier (no AI call, no I/O).
//
// Purpose: pick which RESPONSE GUIDANCE block gets appended to the CORE system prompt, so a
// small/fast model only receives instructions relevant to the current question (less context
// competition, less template-y output). It classifies the QUERY, never the answer facts, and
// is a soft signal — it must never hard-restrict the model.
//
// Intents: simple | explanation | data | list | troubleshooting | comparison | howto | current
// Flags:   completeness (explicit "semua/lengkap/full list" request) and live (current/real-time).
//          Both EN and ID keyword sets are supported.

const _COMPLETENESS_RE = /(semua|seluruh|lengkap|lengkapnya|daftar\s*lengkap|skuad\s*lengkap|semua\s*pemain|seluruh\s*daftar|siapa\s*saja|full\s*(?:list|squad)|list\s*all|complete\s*list|all\s*players|\ball\b|\bevery\b)/i;
// Live intent precision (AI Pipeline V3 P1): split into STRONG live signals (time/recency
// markers and explicit live words, enough on their own) and LIVE SUBJECTS (things that
// inherently ask for an actual/current value: price, score, schedule, news, weather, ...).
// Ambiguous words like "prediksi/perkiraan/update" are NOT live keywords at all: they never
// trigger live on their own and only ever matter when a live subject is already present.
// This kills false positives like "Prediksi masa depan AI" or "Perkiraan ukuran file" while
// keeping real current queries ("harga bmri", "jadwal chelsea?") live.
const _STRONG_LIVE_RE = /(hari\s*ini|minggu\s*ini|sekarang|saat\s*ini|terbaru|terkini|\blive\b|\blatest\b|\btoday\b|\bcurrent\b|right\s*now|real-?time|besok|kemarin)/i;
const _LIVE_SUBJECT_RE = /(harga|saham|kurs|cuaca|skor|klasemen|jadwal|berita|hasil\s*pertandingan|schedule|price|score|weather|news|stock|forex)/i;
const _DATA_RE = /(berapa|statistik|spesifikasi|angka|jumlah|total|ukuran|data|persentase|rate|specs|specification|statistics)/i;
const _LIST_RE = /(daftar|list|pemain|skuad|anggota|items|checklist|semua\s*pemain|nama\s*[-–]|menu)/i;

// Comparison: "A vs B", "A versus B", "bandingkan", "mana yang lebih baik", "lebih bagus A atau B".
function _isComparison(s) {
    if (/(\s|^)(vs|versus)(\s|$)/i.test(s)) return true;
    if (/\b(compare|comparison|perbandingan|bandingkan|banding)\b/i.test(s)) return true;
    if (/mana\s+yang\s+lebih/i.test(s)) return true;
    if (/lebih\s+(baik|bagus|unggul|cepat|murah).*\batau\b/i.test(s)) return true;
    if (/difference\s+between|perbedaan\s+antara/i.test(s)) return true;
    return false;
}

// Troubleshooting needs an actual problem signal: error words, negation + failure verbs,
// "why ... not ...". Plain "kenapa langit biru?" stays an explanation.
function _isTroubleshooting(s) {
    if (/\b(error|bug|crash|broken|fault|issue|problem|masalah)\b/i.test(s)) return true;
    if (/\b(gagal|gagalkan|fails?|failed|failure)\b/i.test(s)) return true;
    if (/tidak\s+(bisa|dapat|boleh|muncul|connect|terhubung|berfungsi|berjalan|jalan|terbaca|terdeteksi|muncul)/i.test(s)) return true;
    if (/gak\s+bisa|ga\s+bisa|nggak\s+bisa|tidak\s+berhasil/i.test(s)) return true;
    if (/why\s+.*\bnot\b|kenapa\s+.*\btidak\b|kenapa\s+.*\bgak\b|why\s+.*(won'?t|doesn'?t|can'?t)/i.test(s)) return true;
    if (/fix\b|perbaiki|atasi|solved?|solusi|do'?snt\s+work|doesn'?t\s+work/i.test(s)) return true;
    return false;
}

function _isHowTo(s) {
    if (/\bcara\s+kerja\b/i.test(s) || /how\s+.*\bwork(s|ing)?\b/i.test(s)) return false; // explanation, not steps
    if (/\bcara\b/i.test(s) || /cara\s+install|install|setup|configure|configurasi|how\s+do|how\s+to|tutorial|panduan|langkah|steps?\b|petunjuk|guide/i.test(s)) return true;
    if (/cara\s+membuat|cara\s+memperbaiki|cara\s+install/i.test(s)) return true;
    return false;
}

function _isExplanation(s) {
    if (/(apa\s+itu|apa\s+yang\s+dimaksud|jelaskan|definisi|pengertian|penjelasan|cara\s+kerja|bagaimana\s+cara\s+kerja|konsep|what\s+is|define|explain|concept)/i.test(s)) return true;
    if (/kenapa|mengapa|why\b|kapan\b|where\b|how\s+does/i.test(s)) return true;
    return false;
}

// Narrow definition-style check used ONLY to suppress live for vocabulary questions such as
// "Apa itu harga pokok penjualan?" (asks what a term means, not for a current value). This is
// deliberately much narrower than _isExplanation so real current queries like "Kapan jadwal
// chelsea?" (kapan + jadwal) still count as live.
function _isDefinitionQuery(s) {
    return /(apa\s*itu|apa\s*yang\s*dimaksud|definisi\s|pengertian\s|what\s+is|define\s+|explain\s+what|jelaskan\s+apa)/i.test(s);
}

// STRONG signal alone (or a live subject) -> live; prediction/estimate/update words NEVER
// trigger live on their own. Definition queries mentioning a subject ("apa itu harga …") are
// vocabulary, not live.
function _isIntentLive(s) {
    if (_isDefinitionQuery(s)) return false;
    if (_STRONG_LIVE_RE.test(s)) return true;
    return _LIVE_SUBJECT_RE.test(s);
}

// detectResponseIntent(query) -> { primary, flags:{completeness,live}, secondary:[] }
function detectResponseIntent(query) {
    const s = String(query || '').trim();
    const normalized = s.toLowerCase().replace(/[.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
    const out = {
        primary: 'simple',
        flags: { completeness: false, live: false },
        secondary: []
    };
    if (!normalized) return out;

    if (_COMPLETENESS_RE.test(normalized)) out.flags.completeness = true;
    out.flags.live = _isIntentLive(normalized);

    if (_isComparison(normalized)) {
        out.primary = 'comparison';
    } else if (_isTroubleshooting(normalized)) {
        out.primary = 'troubleshooting';
    } else if (_isHowTo(normalized)) {
        out.primary = 'howto';
    } else if (_isExplanation(normalized)) {
        out.primary = 'explanation';
    } else if ((out.flags.completeness && _LIST_RE.test(normalized)) || /(daftar\s*(lengkap|semua|seluruh)|semua\s+pemain|skuad\s+lengkap|full\s+(list|squad)|list\s+all|complete\s+list)/i.test(normalized)) {
        out.primary = 'list';
    } else if (out.flags.live && /(harga|saham|kurs|cuaca|skor|hasil|klasemen|berita|jadwal|schedule|price|score|weather|news|hasil\s+pertandingan)/i.test(normalized)) {
        out.primary = 'current';
        out.flags.completeness = out.flags.completeness; // keep flag as-is
    } else if (_DATA_RE.test(normalized) || _LIST_RE.test(normalized)) {
        out.primary = 'data';
    }
    // secondary signal: current queries often carry data
    if (out.primary === 'current' && _DATA_RE.test(normalized)) out.secondary.push('data');
    if (out.primary === 'list' && out.flags.live) out.secondary.push('current');
    return out;
}

module.exports = { detectResponseIntent };