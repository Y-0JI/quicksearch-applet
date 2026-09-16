// ai/generativeUiContract.js — G0 structured-response contract for AI Search only.
// Pure: no St/Clutter/Gio/Soup/Cinnamon, no network/fs/UI side effects.
// Fail-closed: invalid input returns { valid:false, reason, value:null } so the
// caller keeps existing AI text/Markdown rendering. Never executes AI data.

const CONTRACT_VERSION = 1;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARS = 500;
const UI_TYPES = ['text_only', 'weather_card', 'stock_chart', 'sports_card', 'info_card'];
const MAX_INFO_ITEMS = 6;
const MAX_STOCK_POINTS = 50;
const MIN_STOCK_POINTS = 2;

function _bytes(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xD800 && c <= 0xDBFF) {
            const lo = s.charCodeAt(i + 1);
            if (lo >= 0xDC00 && lo <= 0xDFFF) { n += 4; i++; }
            else n += 3;
        }
        else n += 3;
    }
    return n;
}

function _fail(reason) {
    return { valid: false, reason: reason, value: null };
}

function validateGenerativeUI(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return _fail('not-object');
    if (UI_TYPES.indexOf(value.ui_type) === -1) return _fail('bad-ui_type');
    if (value.version !== CONTRACT_VERSION) return _fail('bad-version');
    if (typeof value.summary !== 'string') return _fail('bad-summary');
    if (value.summary.length > MAX_SUMMARY_CHARS) return _fail('summary-too-long');
    if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return _fail('bad-data');
    if (value.ui_type === 'info_card') {
        const d = value.data;
        if (typeof d.title !== 'string' || !d.title) return _fail('bad-info-title');
        if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > MAX_INFO_ITEMS) return _fail('bad-info-items');
        for (const it of d.items) {
            if (!it || typeof it !== 'object' || Array.isArray(it)) return _fail('bad-info-item');
            if (typeof it.label !== 'string' || !it.label) return _fail('bad-info-label');
            if (typeof it.value !== 'string' || !it.value) return _fail('bad-info-value');
        }
    }
    if (value.ui_type === 'stock_chart') {
        const d = value.data;
        if (typeof d.symbol !== 'string' || !d.symbol) return _fail('bad-stock-symbol');
        if (typeof d.title !== 'string' || !d.title) return _fail('bad-stock-title');
        if (!Array.isArray(d.points) || d.points.length < MIN_STOCK_POINTS || d.points.length > MAX_STOCK_POINTS) return _fail('bad-stock-points');
        for (const p of d.points) {
            if (!p || typeof p !== 'object' || Array.isArray(p)) return _fail('bad-stock-point');
            if (typeof p.label !== 'string' || !p.label) return _fail('bad-stock-label');
            if (typeof p.value !== 'number' || !isFinite(p.value)) return _fail('bad-stock-value');
        }
    }
    return {
        valid: true,
        value: { ui_type: value.ui_type, version: value.version, summary: value.summary, data: value.data }
    };
}

function parseGenerativeUIResponse(raw) {
    if (typeof raw !== 'string') return _fail('not-string');
    if (!raw.trim()) return _fail('empty');
    if (_bytes(raw) > MAX_PAYLOAD_BYTES) return _fail('too-large');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return _fail('bad-json'); }
    return validateGenerativeUI(parsed);
}

function parseAndValidateGenerativeUI(raw) {
    return parseGenerativeUIResponse(raw);
}

function normalizeGenerativeUI(value) {
    const r = validateGenerativeUI(value);
    return r.valid ? r.value : null;
}

module.exports = {
    parseGenerativeUIResponse,
    validateGenerativeUI,
    parseAndValidateGenerativeUI,
    normalizeGenerativeUI,
    CONTRACT_VERSION,
    MAX_PAYLOAD_BYTES,
    MAX_SUMMARY_CHARS,
    UI_TYPES
};
