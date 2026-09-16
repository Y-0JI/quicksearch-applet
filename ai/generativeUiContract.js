// ai/generativeUiContract.js — G0 structured-response contract for AI Search only.
// Pure: no St/Clutter/Gio/Soup/Cinnamon, no network/fs/UI side effects.
// Fail-closed: invalid input returns { valid:false, reason, value:null } so the
// caller keeps existing AI text/Markdown rendering. Never executes AI data.

const CONTRACT_VERSION = 1;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SUMMARY_CHARS = 500;
const UI_TYPES = ['text_only', 'weather_card', 'stock_chart', 'sports_card'];

function _bytes(s) {
    try { return Buffer.byteLength(s, 'utf8'); } catch (e) { return s.length; }
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
