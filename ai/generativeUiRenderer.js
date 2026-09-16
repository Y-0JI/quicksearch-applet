// ai/generativeUiRenderer.js — G2/G5.2/G6.2 pure presentation descriptor (AI-only).
// Pure: no UI toolkit, no I/O, no JSON.parse of AI text.
// Input must already be a validated G0 value (via G1 resolveAssistantUi).
// Supports text_only + info_card + stock_chart; weather_card/sports_card → null.
// Never throws; never mutates input; never stores {valid,reason}.

const MAX_INFO_ITEMS = 6;
const MAX_STOCK_POINTS = 50;
const MIN_STOCK_POINTS = 2;

function _base(ui) {
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
    if (ui.version !== 1) return null;
    if (typeof ui.summary !== 'string' || ui.summary.length > 500) return null;
    if (!ui.data || typeof ui.data !== 'object' || Array.isArray(ui.data)) return null;
    return true;
}

function _describeInfo(ui) {
    const d = ui.data;
    if (typeof d.title !== 'string' || !d.title) return null;
    if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > MAX_INFO_ITEMS) return null;
    const items = [];
    for (const it of d.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
        if (typeof it.label !== 'string' || !it.label) return null;
        if (typeof it.value !== 'string' || !it.value) return null;
        items.push({ label: it.label, value: it.value });
    }
    return { kind: 'info_card', title: d.title, items: items };
}

function describeGenerativeUi(ui) {
    try {
        if (!_base(ui)) return null;
        if (ui.ui_type === 'text_only') return { kind: 'text_only', summary: ui.summary };
        if (ui.ui_type === 'info_card') return _describeInfo(ui);
        if (ui.ui_type === 'stock_chart') return _describeStock(ui);
        return null;
    } catch (e) {
        return null;
    }
}

function _describeStock(ui) {
    const d = ui.data;
    if (typeof d.symbol !== 'string' || !d.symbol) return null;
    if (typeof d.title !== 'string' || !d.title) return null;
    if (!Array.isArray(d.points) || d.points.length < MIN_STOCK_POINTS || d.points.length > MAX_STOCK_POINTS) return null;
    const points = [];
    for (const p of d.points) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
        if (typeof p.label !== 'string' || !p.label) return null;
        if (typeof p.value !== 'number' || !isFinite(p.value)) return null;
        points.push({ label: p.label, value: p.value });
    }
    return { kind: 'stock_chart', symbol: d.symbol, title: d.title, points: points };
}

module.exports = { describeGenerativeUi };
