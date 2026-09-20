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

function _unwrapSingleFencedBlock(text) {
    const t = String(text).trim();
    if (t.length < 7) return null;
    if (t.slice(0, 3) !== '```') return null;
    if (t.slice(-3) !== '```') return null;
    const firstLineEnd = t.indexOf('\n');
    let innerStart = 3;
    if (firstLineEnd !== -1) {
        const fenceTag = t.slice(3, firstLineEnd).trim().toLowerCase();
        if (fenceTag !== '' && fenceTag !== 'json') return null;
        innerStart = firstLineEnd + 1;
    } else {
        const fenceTag = t.slice(3, -3).trim().toLowerCase();
        if (fenceTag !== '' && fenceTag !== 'json') return null;
        return null;
    }
    const inner = t.slice(innerStart, -3).trim();
    if (!inner) return null;
    return inner;
}

function _parseWithFenceTolerance(text) {
    const direct = contractMod.parseGenerativeUIResponse(text);
    if (direct && direct.valid === true && direct.value) return direct;
    const inner = _unwrapSingleFencedBlock(text);
    if (inner === null) return direct;
    try {
        return contractMod.parseGenerativeUIResponse(inner);
    } catch (e) {
        return direct;
    }
}

function resolveAssistantUi(text) {
    try {
        if (typeof text !== 'string') return null;
        if (!contractMod || typeof contractMod.parseGenerativeUIResponse !== 'function') return null;
        const r = _parseWithFenceTolerance(text);
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
            r = _parseWithFenceTolerance(text);
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
