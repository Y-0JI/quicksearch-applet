// ai/marketData/sseParser.js — pure SSE frame parser for MCP Streamable HTTP.
// No I/O, no UI. Parses text/event-stream bodies into JSON-RPC frames.
// ponytail: data-frame parser only. Upgrade when multi-event types needed.
function parseSseFrames(bodyText) {
    const out = [];
    const raw = String(bodyText || '');
    if (!raw) return out;
    const blocks = raw.split(/\r?\n\r?\n/);
    for (const block of blocks) {
        const lines = String(block).split(/\r?\n/);
        const dataLines = [];
        for (const ln of lines) {
            if (/^\s*:/.test(ln)) continue;
            const m = /^\s*data\s*:\s?(.*)$/.exec(ln);
            if (m) dataLines.push(m[1]);
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n').trim();
        if (!payload) continue;
        let obj = null;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        if (!obj || typeof obj !== 'object') continue;
        if (typeof obj.method === 'string' && obj.id == null) {
            out.push({ notification: true, method: obj.method, params: obj.params || {} });
            continue;
        }
        const frame = {};
        if (obj.id != null) frame.id = obj.id;
        if (obj.result !== undefined) frame.result = obj.result;
        if (obj.error !== undefined) frame.error = obj.error;
        if (obj.method) frame.method = obj.method;
        out.push(frame);
    }
    return out;
}

module.exports = { parseSseFrames };
