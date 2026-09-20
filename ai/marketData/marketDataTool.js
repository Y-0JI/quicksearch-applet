// ai/marketData/marketDataTool.js — market-native adapter over MCP tools.
// Never flows through web normalizeSources. No fabricated URLs.
let tfMod = null;
try { tfMod = require('./timeframeMap.js'); } catch (e) {}
try { if (!tfMod) tfMod = require('./marketData/timeframeMap.js'); } catch (e) {}
try { if (!tfMod) tfMod = require('ai/marketData/timeframeMap.js'); } catch (e) {}

function _makeError(code, message, extra) {
    const e = new Error(String(message || code));
    e.code = code;
    if (extra) for (const k of Object.keys(extra)) e[k] = extra[k];
    return e;
}
function _enumOf(registry, tool, field) {
    try {
        const t = registry.get(tool);
        const p = t && t.inputSchema && t.inputSchema.properties && t.inputSchema.properties[field];
        if (p && Array.isArray(p.enum)) return p.enum.slice();
    } catch (e) {}
    return null;
}
function _asRows(res) {
    if (!res || typeof res !== 'object') return [];
    for (const k of ['bars', 'rows', 'data', 'results', 'items', 'news']) {
        if (Array.isArray(res[k])) return res[k].slice();
    }
    return [res];
}

function createMarketDataTool(opts) {
    opts = opts || {};
    const adapter = opts.adapter;
    if (!adapter || typeof adapter.callTool !== 'function' || typeof adapter.registry !== 'function') {
        throw new Error('MarketDataTool: adapter {callTool, registry} required');
    }
    const registry = adapter.registry();

    function _symbolsOf(res) {
        try {
            const arr = res && (res.symbols || res.results || res.items);
            if (Array.isArray(arr)) return arr;
        } catch (e) {}
        return [];
    }
    async function resolveSymbol(raw, cancellable) {
        if (!registry.isCallable('search_symbols')) {
            if (/:/.test(String(raw || ''))) return String(raw).trim();
            throw _makeError('unsupported_tool', 'Symbol search unavailable');
        }
        const res = await adapter.callTool('search_symbols', { query: String(raw || '').trim() }, cancellable);
        const cands = _symbolsOf(res).map((s) => (s && (s.symbol || s.ticker)) || '').filter(Boolean);
        if (!cands.length) throw _makeError('no_results', 'Symbol not found: ' + raw);
        const exact = cands.filter((c) => c.toUpperCase() === String(raw).toUpperCase() || c.toUpperCase().endsWith(':' + String(raw).toUpperCase()));
        if (exact.length === 1) return exact[0];
        if (cands.length === 1) return cands[0];
        throw _makeError('ambiguous_symbol', 'Ambiguous symbol: ' + raw, { candidates: cands });
    }
    function _marketData(kind, symbols, interval, rows, sources) {
        return { type: 'market_data', kind, symbols: symbols || [], interval: interval || null, rows: rows || [], attribution: 'TradingView', sources: sources || [] };
    }
    async function getPrice(rawSymbol, cancellable) {
        const symbol = await resolveSymbol(rawSymbol, cancellable);
        const order = ['get_symbol_data', 'get_symbol_data_batch', 'get_ohlcv'];
        let picked = null;
        for (const name of order) {
            if (registry.isCallable(name)) { picked = name; break; }
        }
        if (!picked) throw _makeError('unsupported_tool', 'No market-price tool available');
        if (picked === 'get_ohlcv') {
            const acc = _enumOf(registry, picked, 'interval');
            const args = { symbol };
            if (acc) {
                const m = tfMod && typeof tfMod.toToolInterval === 'function' ? tfMod.toToolInterval('D1', acc) : null;
                if (m && m.ok) args.interval = m.value;
            }
            try {
                const schema = registry.get(picked).inputSchema;
                const props = (schema && schema.properties) || {};
                if (props.count) args.count = 1;
            } catch (e) {}
            const res = await adapter.callTool(picked, args, cancellable);
            return _marketData('market_price', [symbol], args.interval || null, _asRows(res));
        }
        const res = await adapter.callTool(picked, { symbol }, cancellable);
        return _marketData('market_price', [symbol], null, _asRows(res));
    }
    async function getOhlcv(symbol, canonTf, count, cancellable) {
        const acc = _enumOf(registry, 'get_ohlcv', 'interval') || [];
        const m = tfMod && typeof tfMod.toToolInterval === 'function' ? tfMod.toToolInterval(canonTf || 'D1', acc) : { ok: true, value: canonTf };
        if (!m.ok) throw _makeError(m.code, m.error, { accepted: m.accepted });
        const args = { symbol, interval: m.value };
        if (count != null) args.count = count;
        const res = await adapter.callTool('get_ohlcv', args, cancellable);
        return _marketData('market_ohlcv', [symbol], m.value, _asRows(res));
    }
    async function getTechnicals(symbol, canonTf, cancellable) {
        const acc = _enumOf(registry, 'get_technicals_rating', 'interval') || [];
        const m = tfMod && typeof tfMod.toToolInterval === 'function' ? tfMod.toToolInterval(canonTf || 'D1', acc) : { ok: true, value: canonTf };
        if (!m.ok) throw _makeError(m.code, m.error, { accepted: m.accepted });
        const res = await adapter.callTool('get_technicals_rating', { symbol, interval: m.value }, cancellable);
        return _marketData('technicals', [symbol], m.value, _asRows(res));
    }
    async function getNews(symbol, cancellable) {
        const res = await adapter.callTool('get_news', { symbol }, cancellable);
        const rows = _asRows(res);
        const sources = [];
        for (const r of rows) {
            const url = r && (r.link || r.url);
            if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
                sources.push({ title: String(r.title || url).slice(0, 200), url, snippet: String(r.title || '').slice(0, 500) });
            }
        }
        return _marketData('news', [symbol], null, rows, sources);
    }

    return { resolveSymbol, getPrice, getOhlcv, getTechnicals, getNews };
}

// formatMarketContext(marketData) -> text grounding context for the LLM leg.
// Human-readable lines, never raw JSON dump. Stateless multi-symbol/timeframe
// sections stay labelled. Pure.
function formatMarketContext(md) {
    if (!md || typeof md !== 'object') return '';
    const lines = [];
    lines.push('Market data (TradingView, retrieved — not live ticks):');
    const syms = Array.isArray(md.symbols) ? md.symbols : [];
    if (syms.length) lines.push('Symbols: ' + syms.join(', '));
    if (md.interval) lines.push('Interval: ' + md.interval);
    lines.push('Kind: ' + String(md.kind || '?'));
    const rows = Array.isArray(md.rows) ? md.rows.slice(0, 20) : [];
    for (const r of rows) {
        if (r && typeof r === 'object' && !Array.isArray(r)) {
            const kv = Object.keys(r).slice(0, 12).map((k) => k + '=' + String(r[k]).slice(0, 60)).join(' ');
            lines.push('- ' + kv);
        } else {
            lines.push('- ' + String(r).slice(0, 200));
        }
    }
    return lines.join('\n');
}

module.exports = { createMarketDataTool, formatMarketContext, sanitizeMarketError: _sanitizeMarketError };

function _sanitizeMarketError(msg) {
    try {
        return String(msg || '').replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]').slice(0, 400);
    } catch (e) { return String(msg || '').slice(0, 400); }
}
