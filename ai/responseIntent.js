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
const _LIVE_RE = /(harga|jadwal|berita|terbaru|hari\s*ini|minggu\s*ini|besok|kemarin|sekarang|live|skor|hasil|klasemen|cuaca|kurs|saham|bitcoin|crypto|update|latest|today|tomorrow|schedule|price|news|score|weather|prediksi|perkiraan)/i;
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
    if (_LIVE_RE.test(normalized)) out.flags.live = true;

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