// ai/generativeUi.js — G1 consumer-side integration helper (AI Search only).
// Pure: wraps the G0 contract parser, returns renderable value or null.
// Call ONLY after the assistant response is complete — never from onDelta.
// msg.ui must hold only this value (or null); never {valid,reason}.

let contractMod = null;
let _contractPath = null;
// G1.1: GJS/Cinnamon resolves relative require from the applet root, while Node
// tests resolve from ai/. Try factory-style candidate paths, fail closed.
(function _loadContract() {
    const candidates = ['./ai/generativeUiContract.js', './generativeUiContract.js', 'ai/generativeUiContract.js'];
    for (const p of candidates) {
        try {
            const m = require(p);
            if (m && typeof m.parseGenerativeUIResponse === 'function') {
                contractMod = m;
                _contractPath = p;
                break;
            }
        } catch (e) {}
    }
})();

function resolveAssistantUi(text) {
    try {
        if (typeof text !== 'string') return null;
        if (!contractMod || typeof contractMod.parseGenerativeUIResponse !== 'function') return null;
        const r = contractMod.parseGenerativeUIResponse(text);
        if (!r || r.valid !== true || !r.value) return null;
        return r.value;
    } catch (e) {
        return null;
    }
}

function diagnoseAssistantUi(text) {
    try {
        const parserLoaded = !!(contractMod && typeof contractMod.parseGenerativeUIResponse === 'function');
        if (typeof text !== 'string') {
            return { hasUi: false, reason: 'not-string', parserLoaded: parserLoaded, valid: false, hasValue: false };
        }
        if (!parserLoaded) {
            return { hasUi: false, reason: 'no-parser', parserLoaded: false, valid: false, hasValue: false };
        }
        let r = null;
        try {
            r = contractMod.parseGenerativeUIResponse(text);
        } catch (eParse) {
            return { hasUi: false, reason: 'threw', parserLoaded: true, valid: false, hasValue: false,
                threw: String(eParse && eParse.message || eParse).slice(0, 120) };
        }
        const valid = !!(r && r.valid === true);
        const hasValue = !!(r && r.value);
        if (!valid || !hasValue) {
            return { hasUi: false, reason: String((r && r.reason) || 'invalid'),
                parserLoaded: true, valid: valid, hasValue: hasValue };
        }
        return { hasUi: true, reason: 'ok', parserLoaded: true, valid: true, hasValue: true, ui_type: r.value.ui_type };
    } catch (e) {
        return { hasUi: false, reason: 'threw', parserLoaded: false, valid: false, hasValue: false };
    }
}

module.exports = { resolveAssistantUi, diagnoseAssistantUi };
