// ai/responseIntent.js — pure, deterministic query intent classifier (no AI call, no I/O).
//
// Purpose: pick which RESPONSE GUIDANCE block gets appended to the CORE system prompt, so a
// small/fast model only receives instructions relevant to the current question (less context
// competition, less template-y output). It classifies the QUERY, never the answer facts, and
// is a soft signal — it must never hard-restrict the model.
//
// Intents: simple | explanation | data | list | troubleshooting | comparison | howto | current
// Flags:   completeness (explicit "semua/lengkap/full list" request) and live (current/real-time).
// Depth:   concise | normal | detailed — how DEEP the user wants the explanation, kept separate
//          from completeness. completeness answers "give me ALL the items"; depth answers "how
//          deep should the explanation go". An explicit depth request (detail/rinci/mendalam/...)
//          overrides the default brevity guidance downstream. Both EN and ID keyword sets supported.

const _COMPLETENESS_RE = /(semua|seluruh|lengkap|lengkapnya|daftar\s*lengkap|skuad\s*lengkap|semua\s*pemain|seluruh\s*daftar|siapa\s*saja|full\s*(?:list|squad)|list\s*all|complete\s*list|all\s*players|\ball\b|\bevery\b)/i;
// Live intent precision (AI Pipeline V3 P1): split into STRONG live signals (time/recency
// markers and explicit live words, enough on their own) and LIVE SUBJECTS (things that
// inherently ask for an actual/current value: price, score, schedule, news, weather, ...).
// Ambiguous words like "prediksi/perkiraan/update" are NOT live keywords at all: they never
// trigger live on their own and only ever matter when a live subject is already present.
// This kills false positives like "Prediksi masa depan AI" or "Perkiraan ukuran file" while
// keeping real current queries ("harga bmri", "jadwal chelsea?") live.
// "live" counts as a temporal marker only when it is NOT part of a technology noun phrase
// (live streaming/chat/video/tv/…) — otherwise "Apa itu live streaming?" is vocabulary, not live.
const _STRONG_LIVE_RE = /(hari\s*ini|minggu\s*ini|sekarang|saat\s*ini|terbaru|terkini|\blive\b(?!\s+(?:streaming|stream|chat|video|tv|show|music|concert|event|webinar|session|broadcast|feed))|\blatest\b|\btoday\b|\bcurrent\b|right\s*now|real-?time|besok|kemarin)/i;
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

// LIVE SUBJECT CONTEXT PRECISION (AI Pipeline V3 P1 follow-up): a live subject alone is NOT
// enough. FINAL priority (strong temporal signal has the HIGHEST priority — it overrides both
// definition and conceptual intent, e.g. "Apa itu harga saham hari ini?" is live because the
// user explicitly ties the request to "hari ini"):
//   1. STRONG temporal/live signal      -> LIVE        ("Jelaskan harga saham hari ini",
//                                                      "Apa itu harga saham hari ini?",
//                                                      "Bagaimana cuaca bekerja hari ini?")
//   2. Definition/vocabulary question   -> NOT LIVE    ("Apa itu harga saham?")
//   3. Conceptual/explanation request   -> NOT LIVE    ("Bagaimana harga saham bekerja?",
//                                                      "Kenapa harga saham naik turun?",
//                                                      "Jelaskan sistem klasemen",
//                                                      "Fungsi prakiraan cuaca")
//   4. Live subject + implicit current-value ask -> LIVE ("Harga BBRI", "Cuaca Jakarta",
//                                                      "Jadwal Chelsea", "Skor Barcelona")
//   5. Otherwise                        -> NOT LIVE
// Conceptual check is deliberately NARROW (regex/helper based, no NLP): it only suppresses
// queries that clearly ask for an explanation of HOW/WHY a live subject works, never a bare
// subject that naturally reads as a current-value request.

// Narrow definition-style check: "Apa itu …, definisi …, pengertian …, what is …, define …,
// jelaskan apa …". Only reached when no strong temporal signal matched.
function _isDefinitionQuery(s) {
    return /(apa\s*itu|apa\s*yang\s*dimaksud|definisi\s|pengertian\s|what\s+is|define\s+|explain\s+what|jelaskan\s+apa)/i.test(s);
}

// Conceptual / explanatory request markers: why/kenapa, jelaskan, fungsi, cara kerja, sistem,
// konsep, mekanisme, proses, and "bagaimana … bekerja/dibuat/berjalan/…" (process questions).
// DOES NOT include kapan (time question) so "Kapan jadwal chelsea?" stays live.
const _CONCEPTUAL_RE = /(kenapa\b|mengapa\b|jelaskan\b|definisi\b|pengertian\b|fungsi\b|konsep\b|mekanisme\b|\bsistem\b|cara\s+kerja\b|proses\b|bagaimana\s+\S+.*\b(?:bekerja|dibuat|berjalan|berfungsi|terbentuk|terjadi|berlangsung)\b)/i;
function _hasConceptualIntent(s) {
    return _CONCEPTUAL_RE.test(s);
}

// FINAL PRIORITY RULE: strong temporal/live signal is checked FIRST and always wins. Then
// vocabulary, then conceptual; then a live subject with an implicit current-value request.
// prediction/perkiraan/update never matter.
function _isIntentLive(s) {
    if (_STRONG_LIVE_RE.test(s)) return true;
    if (_isDefinitionQuery(s)) return false;
    if (_hasConceptualIntent(s)) return false;
    return _LIVE_SUBJECT_RE.test(s);
}

// ── ANSWER DEPTH (detail level) ──────────────────────────────────────────────
// Depth detection is deliberately separate from completeness. "daftar lengkap pemain" means
// completeness (all items) and stays depth normal; "jelaskan Docker secara mendalam" is a
// depth request. Bare "lengkap"/"complete" is therefore NOT a depth signal on its own — it
// only counts when it clearly asks for thoroughness (secara lengkap, lebih lengkap, tutorial
// lengkap, complete explanation). Strong depth words (detail/rinci/mendalam/detailed/...) are
// unambiguous and always count.
const _DEPTH_DETAILED_RE = /(\bmendalam\b|\bmendetail\b|\brinci\b|\bdetil\b|\bdetail\b|detailed|thorough(?:ly)?|comprehensive|in[- ]depth|exhaustive|elaborate|extensive|more\s+detail|(?:secara|lebih|sangat)\s+(?:detail|detil|rinci|lengkap|mendalam)|(?:penjelasan|pembahasan|tutorial|panduan|uraian)\s+(?:yang\s+)?(?:lengkap|mendalam|detail|rinci)|jangan\s+(?:terlalu\s+)?(?:singkat|pendek)|tidak\s+(?:terlalu\s+)?singkat|do\s+not\s+be\s+brief|don'?t\s+be\s+brief|not\s+too\s+brief|explain\s+(?:it\s+)?fully|full\s+explanation|complete\s+explanation|step\s*[- ]by\s*[- ]step.{0,25}(?:lengkap|detail|rinci|mendalam)|deep\s+dive)/i;
// Explicit brevity request (user wants a SHORT answer). Checked only after the detailed
// markers, so "detail" always wins over "singkat" when both appear.
const _DEPTH_CONCISE_RE = /(secara\s+singkat|singkat\s+saja|jawab(?:lah)?\s+(?:secara\s+)?singkat|jawaban\s+(?:yang\s+)?singkat|jelaskan\s+secara\s+singkat|secara\s+ringkas|ringkas\s+saja|jawab\s+ringkas|tolong\s+(?:singkat|ringkas)|pendek\s+saja|jangan\s+panjang|answer\s+briefly|be\s+brief|keep\s+it\s+short|short\s+answer|\bbriefly\b|concise(?:ly)?|in\s+short)/i;

function _detectDepth(s) {
    if (_DEPTH_DETAILED_RE.test(s)) return 'detailed';
    if (_DEPTH_CONCISE_RE.test(s)) return 'concise';
    return 'normal';
}

// detectResponseIntent(query) -> { primary, flags:{completeness,live}, depth, secondary:[] }
function detectResponseIntent(query) {
    const s = String(query || '').trim();
    const normalized = s.toLowerCase().replace(/[.!?]+/g, ' ').replace(/\s+/g, ' ').trim();
    const out = {
        primary: 'simple',
        flags: { completeness: false, live: false },
        depth: 'normal',
        secondary: []
    };
    if (!normalized) return out;

    if (_COMPLETENESS_RE.test(normalized)) out.flags.completeness = true;
    out.flags.live = _isIntentLive(normalized);
    out.depth = _detectDepth(normalized);

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