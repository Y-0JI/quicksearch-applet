// ai/marketData/timeframeMap.js — canonical tokens validated per-tool schema. No global trust.
const CANON_TO_CANDIDATES = {
    M1: ['1m'], M5: ['5m'], M15: ['15m'], M30: ['30m'],
    H1: ['1h', '60'], H4: ['4h', '240'], D1: ['1D', '1d', 'D'],
    W1: ['1W', '1w', 'W'], MN: ['1M', 'M', '1mo', 'month']
};
function toToolInterval(canon, accepted) {
    const c = String(canon || '').toUpperCase();
    const acc = Array.isArray(accepted) ? accepted.slice() : [];
    const cands = CANON_TO_CANDIDATES[c] || [];
    for (const cand of cands.concat([c])) {
        if (acc.indexOf(cand) >= 0) return { ok: true, value: cand };
    }
    return { ok: false, code: 'unsupported_timeframe', error: 'Unsupported timeframe ' + c + '. Accepted: ' + acc.join(', '), accepted: acc };
}
module.exports = { toToolInterval, CANON_TO_CANDIDATES };
