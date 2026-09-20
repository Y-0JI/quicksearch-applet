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
function _requiredOf(registry, tool) {
    try {
        const t = registry.get(tool);
        const r = t && t.inputSchema && t.inputSchema.required;
        return Array.isArray(r) ? r.slice() : [];
    } catch (e) { return []; }
}
function _propsOf(registry, tool) {
    try {
        const t = registry.get(tool);
        const p = t && t.inputSchema && t.inputSchema.properties;
        return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
}
// Price-candidate compatibility: required `symbol` satisfiable; every other
// required field must be satisfiable from {symbol} + known optionals
// (interval via D1 mapping, count=1, symbols batch). Unknown required → skip.
function _priceArgsFor(registry, name, symbol) {
    const required = _requiredOf(registry, name);
    const props = _propsOf(registry, name);
    const args = {};
    const haveInterval = _enumOf(registry, name, 'interval');
    for (const k of required) {
        if (k === 'symbol' || k === 'symbols') continue;
        if (k === 'interval' || k === 'timeframe') continue;
        if (k === 'count' || k === 'limit') continue;
        if (k === 'columns') continue;
        return null;
    }
    // Price-candidate compatibility for single-symbol batch use:
    // get_symbol_data_batch with array schema accepts per-symbol calls too.
    if (name === 'get_symbol_data_batch') {
        const symSpec = props.symbols || {};
        if (symSpec.type === 'string') return { symbols: symbol };
        return { symbols: [symbol] };
    }
    if (props.symbol || required.indexOf('symbol') >= 0) args.symbol = symbol;
    else if (props.symbols || required.indexOf('symbols') >= 0) args.symbols = symbol;
    else return null;
    if (haveInterval) {
        const m = tfMod && typeof tfMod.toToolInterval === 'function' ? tfMod.toToolInterval('D1', haveInterval) : null;
        if (!m || !m.ok) return null;
        args.interval = m.value;
    } else if (props.interval && required.indexOf('interval') >= 0) {
        return null;
    }
    if (props.count && required.indexOf('count') < 0) args.count = 1;
    else if (required.indexOf('count') >= 0) args.count = 1;
    return args;
}
// P2: price-bearing check — at least one row carries a numeric price-like
// field (close/price/last/c or OHLC set). Verbatim server fields kept;
// a tool whose response has none is skipped as incompatible price source.
const _PRICE_KEYS = ['close', 'price', 'last', 'lastprice', 'last_price', 'c', 'open', 'high', 'low'];
function _priceBearing(rows) {
    if (!Array.isArray(rows)) return false;
    for (const r of rows) {
        if (r == null) continue;
        if (typeof r === 'number' && isFinite(r)) return true;
        if (typeof r === 'object') {
            for (const k of _PRICE_KEYS) {
                if (typeof r[k] === 'number' && isFinite(r[k])) return true;
            }
        }
    }
    return false;
}
function _asRows(res) {    if (!res || typeof res !== 'object') return [];
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
        const q = String(raw == null ? '' : raw).trim();
        if (!q) throw _makeError('symbol_required', 'No instrument symbol or entity in market query');
        if (!registry.isCallable('search_symbols')) {
            if (/:/.test(q)) return q;
            throw _makeError('unsupported_tool', 'Symbol search unavailable');
        }
        const res = await adapter.callTool('search_symbols', { query: q }, cancellable);
        const cands = _symbolsOf(res).map((s) => (s && (s.symbol || s.ticker)) || '').filter(Boolean);
        if (!cands.length) throw _makeError('no_results', 'Symbol not found: ' + q);
        const exact = cands.filter((c) => c.toUpperCase() === q.toUpperCase() || c.toUpperCase().endsWith(':' + q.toUpperCase()));
        if (exact.length === 1) return exact[0];
        if (cands.length === 1) return cands[0];
        throw _makeError('ambiguous_symbol', 'Ambiguous symbol: ' + q, { candidates: cands });
    }
    function _marketData(kind, symbols, interval, rows, sources) {
        // Market-native result keeps server fields verbatim. snapshot:true
        // marks retrieved/delayed data — never "live tick".
        return { type: 'market_data', kind, symbols: symbols || [], interval: interval || null, rows: rows || [], attribution: 'TradingView', snapshot: true, sources: sources || [] };
    }
    async function getPrice(rawSymbol, cancellable) {
        const symbol = await resolveSymbol(rawSymbol, cancellable);
        const order = ['get_symbol_data', 'get_symbol_data_batch', 'get_ohlcv'];
        for (const name of order) {
            if (!registry.isCallable(name)) continue;
            const args = _priceArgsFor(registry, name, symbol);
            if (!args) continue;
            // P2: get_symbol_data is NOT assumed to be a quote API. When the
            // schema exposes a `columns` selector, request explicit price
            // columns; otherwise accept the fixed shape but mark snapshot
            // semantics (never "live tick").
            const props = _propsOf(registry, name);
            if (props.columns && args.columns == null) {
                const cols = _quoteColumnsFor(name);
                if (cols) args.columns = cols;
            }
            const v = registry.validate(name, args);
            if (!v.ok) continue;
            const res = await adapter.callTool(name, args, cancellable);
            const out = _marketData('market_price', [symbol], args.interval || null, _asRows(res));
            out.snapshot = true;
            // P2 data-shape awareness: a market-price result must carry at
            // least one price-bearing field; otherwise the tool is not a
            // compatible price source for this call (try next candidate).
            if (!_priceBearing(out.rows)) continue;
            return out;
        }
        throw _makeError('unsupported_tool', 'No compatible market-price tool available');
    }
    function _quoteColumnsFor(name) {
        // Only when the schema declares a columns-like selector; values are
        // validated against get_screener_columns-style discovery when available.
        try {
            if (registry.screenerColumnsCached()) {
                const want = ['close', 'change'];
                if (registry.screenerColumnsCover(want)) return want;
                if (registry.screenerColumnsCover(['close'])) return ['close'];
                return null;
            }
        } catch (e) {}
        return ['close'];
    }
    // Multi-symbol market-price: batch tool when schema-compatible, else bounded
    // single calls in order. Any ambiguous symbol fails the whole request.
    async function getPrices(rawSymbols, cancellable) {
        const list = Array.isArray(rawSymbols) ? rawSymbols.map((s) => String(s || '').trim()).filter(Boolean) : [];
        if (!list.length) throw _makeError('no_results', 'No symbols requested');
        const resolved = [];
        for (const raw of list) resolved.push(await resolveSymbol(raw, cancellable));
        if (registry.isCallable('get_symbol_data_batch')) {
            const props = _propsOf(registry, 'get_symbol_data_batch');
            const symSpec = props.symbols || {};
            // Schema truth: ARRAY when the schema says array (default when
            // untyped-but-required); CSV string ONLY when declared string.
            const asArray = symSpec.type !== 'string';
            const args = asArray ? { symbols: resolved.slice() } : { symbols: resolved.join(',') };
            const v = registry.validate('get_symbol_data_batch', args);
            if (v.ok) {
                const res = await adapter.callTool('get_symbol_data_batch', args, cancellable);
                const rows = _asRows(res);
                return _marketData('market_price', resolved, null, rows.length ? rows : resolved.map((s) => ({ symbol: s })));
            }
        }
        const rows = [];
        for (const symbol of resolved) {
            const single = await getPriceBySymbol(symbol, cancellable);
            rows.push(single);
        }
        return _marketData('market_price', resolved, null, rows);
    }
    async function getPriceBySymbol(symbol, cancellable) {
        const order = ['get_symbol_data', 'get_ohlcv'];
        for (const name of order) {
            if (!registry.isCallable(name)) continue;
            const args = _priceArgsFor(registry, name, symbol);
            if (!args) continue;
            const v = registry.validate(name, args);
            if (!v.ok) continue;
            const res = await adapter.callTool(name, args, cancellable);
            const rows = _asRows(res);
            return Object.assign({ symbol }, rows[0] && typeof rows[0] === 'object' ? rows[0] : { value: rows[0] });
        }
        throw _makeError('unsupported_tool', 'No compatible market-price tool available');
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
    // Intent-correct endpoints: each fails unsupported_tool when its tool is
    // absent — NEVER falls back to price.
    async function getFundamentals(rawSymbol, wantsConsensus, cancellable) {
        const symbol = await resolveSymbol(rawSymbol, cancellable);
        if (!registry.isCallable('get_financials')) throw _makeError('unsupported_tool', 'Fundamentals tool unavailable');
        const res = await adapter.callTool('get_financials', { symbol }, cancellable);
        const out = _marketData('financials', [symbol], null, _asRows(res));
        if (wantsConsensus) {
            if (!registry.isCallable('get_forecasts')) throw _makeError('unsupported_tool', 'Forecasts tool unavailable');
            const fc = await adapter.callTool('get_forecasts', { symbol }, cancellable);
            out.rows = [{ fundamentals: out.rows, forecasts: _asRows(fc) }];
        }
        return out;
    }
    async function getStory(storyId, cancellable) {
        if (!registry.isCallable('get_news_story')) throw _makeError('unsupported_tool', 'News story tool unavailable');
        const res = await adapter.callTool('get_news_story', { id: String(storyId) }, cancellable);
        return _marketData('news_story', [], null, _asRows(res));
    }
    async function getEconomic(symbol, cancellable) {
        const sym = String(symbol || '').trim();
        if (!sym) throw _makeError('no_results', 'No economic symbol resolved from query');
        if (!registry.isCallable('get_economic_data')) throw _makeError('unsupported_tool', 'Economic data tool unavailable');
        const res = await adapter.callTool('get_economic_data', { symbol: sym }, cancellable);
        return _marketData('economic', [sym], null, _asRows(res));
    }
    // Generic economic resolution via get_economic_symbols (source of truth).
    // entity: { country, indicator } — no hardcoded ticker map. 0 → no_results,
    // 1 → use, >1 → ambiguous_symbol.
    async function resolveEconomic(entity, cancellable) {
        entity = entity || {};
        if (!registry.isCallable('get_economic_symbols')) throw _makeError('unsupported_tool', 'Economic symbol discovery unavailable');
        const args = {};
        try {
            const schema = registry.get('get_economic_symbols').inputSchema || {};
            const props = (schema && schema.properties) || {};
            if (entity.country && props.country) args.country = entity.country;
            if (entity.indicator && props.search) args.search = entity.indicator;
            else if (entity.indicator && props.query) args.query = entity.indicator;
            else if (entity.indicator && props.indicator) args.indicator = entity.indicator;
        } catch (e) {}
        const v = registry.validate('get_economic_symbols', args);
        if (!v.ok) throw _makeError(v.code || 'invalid_response', v.error || 'Economic discovery rejected');
        const res = await adapter.callTool('get_economic_symbols', args, cancellable);
        const cands = _econSymbolsOf(res, entity);
        if (!cands.length) throw _makeError('no_results', 'No economic indicator found');
        if (cands.length > 1) throw _makeError('ambiguous_symbol', 'Ambiguous economic indicator', { candidates: cands });
        return cands[0];
    }
    function _econSymbolsOf(res, entity) {
        try {
            const arr = res && (res.symbols || res.tickers || res.results || res.items);
            if (Array.isArray(arr)) {
                const out = arr.map((s) => (typeof s === 'string' ? s : (s && (s.symbol || s.ticker)) || '')).filter(Boolean);
                return _filterEcon(out, entity);
            }
            if (res && typeof res === 'object') {
                const keys = Object.keys(res).filter((k) => /^ECONOMICS:/i.test(k));
                if (keys.length) return _filterEcon(keys, entity);
            }
        } catch (e) {}
        return [];
    }
    function _filterEcon(cands, entity) {
        if (!entity || !entity.country) return cands;
        const cc = String(entity.country).toUpperCase();
        const hit = cands.filter((c) => String(c).toUpperCase().indexOf(cc) >= 0);
        return hit.length ? hit : cands;
    }
    // Screener with real cache wiring: get_screener_columns fetched once,
    // cached, reused. Unknown columns fail closed. Empty cache never valid.
    async function runScreener(req, cancellable) {
        req = req || {};
        if (!registry.isCallable('run_screener')) throw _makeError('unsupported_tool', 'Screener tool unavailable');
        const wantCols = Array.isArray(req.columns) ? req.columns.slice() : [];
        if (wantCols.length) {
            if (!registry.screenerColumnsCached()) {
                if (!registry.isCallable('get_screener_columns')) throw _makeError('unsupported_tool', 'Screener columns unavailable');
                const res = await adapter.callTool('get_screener_columns', {}, cancellable);
                const cols = res && (res.columns || res.names || res.rows);
                registry.setScreenerColumns(Array.isArray(cols) ? cols.map((c) => (c && (c.name || c.column)) || c).filter((c) => typeof c === 'string') : []);
            }
            if (!registry.screenerColumnsCover(wantCols)) {
                throw _makeError('unsupported_tool', 'Unknown screener columns: ' + wantCols.filter((c) => !registry.screenerColumnsCover([c])).join(', '));
            }
        }
        const args = {};
        if (wantCols.length) args.columns = wantCols;
        if (req.filters && typeof req.filters === 'object') args.filters = req.filters;
        if (req.limit != null) args.limit = req.limit;
        const v = registry.validate('run_screener', args);
        if (!v.ok) throw _makeError(v.code || 'invalid_response', v.error || 'Screener call rejected');
        const res = await adapter.callTool('run_screener', args, cancellable);
        return _marketData('screener', [], null, _asRows(res));
    }

    return { resolveSymbol, resolveEconomic, getPrice, getPrices, getOhlcv, getTechnicals, getNews, getFundamentals, getStory, getEconomic, runScreener };
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
