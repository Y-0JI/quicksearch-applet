// ai/generativeUi.js — G1 consumer-side integration helper (AI Search only).
// Pure: wraps the G0 contract parser, returns renderable value or null.
// Call ONLY after the assistant response is complete — never from onDelta.
// msg.ui must hold only this value (or null); never {valid,reason}.

let contractMod = null;
try { contractMod = require('./generativeUiContract.js'); } catch (e) { contractMod = null; }

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

module.exports = { resolveAssistantUi };
