// ai/generativeUiRenderer.js — G2 pure presentation descriptor (AI-only).
// Pure: no St/Clutter/Gio/Soup/Cinnamon, no network/fs, no JSON.parse of AI text.
// Input must already be a validated G0 value (via G1 resolveAssistantUi).
// G2 supports text_only only; weather_card/stock_chart/sports_card → null fallback.
// Never throws; never mutates input; never stores {valid,reason}.

function describeGenerativeUi(ui) {
    try {
        if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
        if (ui.ui_type !== 'text_only') return null;
        if (ui.version !== 1) return null;
        if (typeof ui.summary !== 'string') return null;
        if (ui.summary.length > 500) return null;
        if (!ui.data || typeof ui.data !== 'object' || Array.isArray(ui.data)) return null;
        return { kind: 'text_only', summary: ui.summary };
    } catch (e) {
        return null;
    }
}

module.exports = { describeGenerativeUi };
