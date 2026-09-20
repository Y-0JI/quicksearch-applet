// tests/ai-tradingview-routing.test.js — P1/P2: intent-correct routing, schema-aware
// price, multi-symbol, screener cache wiring
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketDataTool } = require('../ai/marketData/marketDataTool.js');
const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');

function symSchema() { return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }; }
function regWith(entries) { const r = createToolRegistry({}); r.update(entries); return r; }
function mockAdapter(registry, results) {
    const calls = [];
    return {
        registry: () => registry,
        callTool: async (name, args) => {
            calls.push({ name, args });
            const v = results[name];
            if (v instanceof Error) throw v;
            return typeof v === 'function' ? v(args) : v;
        },
        calls
    };
}
function ohlcvSchema() { return { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1m', '15m', '1h', '1D'] }, count: { type: 'integer' } }, required: ['symbol'] }; }

test('R1 each intent uses its own tool, never getPrice fallback', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() },
        { name: 'get_technicals_rating', description: 't', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1D'] } }, required: ['symbol'] } },
        { name: 'get_financials', description: 'f', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_forecasts', description: 'fc', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_news', description: 'n', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_news_story', description: 'ns', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
        { name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_screener_columns', description: 'scc', inputSchema: { type: 'object', properties: {} } },
        { name: 'get_economic_data', description: 'e', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'X:Y' }] },
        get_financials: { pe: 10 },
        get_forecasts: { rating: 'buy' },
        get_news: { news: [] },
        get_news_story: { text: 'story' },
        run_screener: { rows: [] },
        get_screener_columns: { columns: ['close', 'volume'] },
        get_economic_data: { values: [] },
        get_symbol_data: { close: 1 },
        get_ohlcv: { bars: [] },
        get_technicals_rating: { RSI: 1 }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const f = await tool.getFundamentals('X', false, null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'get_financials');
    assert.ok(!ad.calls.slice(1).some((c) => c.name === 'get_symbol_data'), 'fundamental must not touch price tool');
    const s = await tool.runScreener({ filters: {} }, null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'run_screener');
    const e = await tool.getEconomic('ECONOMICS:USIRYY', null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'get_economic_data');
});

test('R2 missing intent tool fails unsupported_tool, never price', async () => {
    const reg = regWith([{ name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'X:Y' }] }, get_symbol_data: { close: 1 } });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getFundamentals('X', false, null), (e) => e && e.code === 'unsupported_tool');
    await assert.rejects(tool.runScreener({}, null), (e) => e && e.code === 'unsupported_tool');
    await assert.rejects(tool.getEconomic('E', null), (e) => e && e.code === 'unsupported_tool');
    assert.ok(!ad.calls.some((c) => c.name === 'get_symbol_data'), 'no price fallback for wrong intents');
});

test('R3 price skips schema-incompatible first candidate', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1D'] } }, required: ['symbol', 'interval', 'extra_required'] } },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'X:Y' }] },
        get_ohlcv: { bars: [{ c: 5 }] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrice('X', null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'get_ohlcv');
    assert.equal(out.rows[0].c, 5);
});

test('R4 all price candidates incompatible fails unsupported_tool', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol', 'missing_field'] } }
    ]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'X:Y' }] } });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrice('X', null), (e) => e && e.code === 'unsupported_tool');
});

test('R5 multi-symbol preserved in order, labelled', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data_batch', description: 'qb', inputSchema: { type: 'object', properties: { symbols: { type: 'string' } }, required: ['symbols'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: (args) => ({ symbols: [{ symbol: 'E:' + args.query }] }),
        get_symbol_data_batch: { rows: [{ symbol: 'E:A', close: 1 }, { symbol: 'E:B', close: 2 }] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrices(['A', 'B'], null);
    assert.deepEqual(out.symbols, ['E:A', 'E:B']);
    assert.equal(out.kind, 'market_price');
});

test('R6 single-symbol fallback loops without dropping', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: (args) => ({ symbols: [{ symbol: 'E:' + args.query }] }),
        get_symbol_data: (args) => ({ symbol: args.symbol, close: 100 + String(args.symbol).length })
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrices(['A', 'B', 'C'], null);
    assert.deepEqual(out.symbols, ['E:A', 'E:B', 'E:C']);
    assert.equal(out.rows.length, 3);
});

test('R7 ambiguous second symbol fails with info, no silent pick', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: (args) => args.query === 'B' ? { symbols: [{ symbol: 'X:B' }, { symbol: 'Y:B' }] } : { symbols: [{ symbol: 'E:' + args.query }] },
        get_symbol_data: { close: 1 }
    });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrices(['A', 'B'], null), (e) => e && e.code === 'ambiguous_symbol');
});

test('R8 screener cache: first fetches columns, second reuses, missing fails', async () => {
    const reg = regWith([
        { name: 'get_screener_columns', description: 'scc', inputSchema: { type: 'object', properties: {} } },
        { name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: { filters: { type: 'string' } } } }
    ]);
    const ad = mockAdapter(reg, {
        get_screener_columns: { columns: ['close', 'volume'] },
        run_screener: { rows: [{ close: 1 }] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    await tool.runScreener({ columns: ['close'] }, null);
    const firstCalls = ad.calls.filter((c) => c.name === 'get_screener_columns').length;
    assert.equal(firstCalls, 1);
    await tool.runScreener({ columns: ['close', 'volume'] }, null);
    assert.equal(ad.calls.filter((c) => c.name === 'get_screener_columns').length, 1, 'cache reused');
    await assert.rejects(tool.runScreener({ columns: ['rsi'] }, null), (e) => e && e.code === 'unsupported_tool');
});

test('R9 empty screener cache never counts as valid', async () => {
    const reg = regWith([
        { name: 'get_screener_columns', description: 'scc', inputSchema: { type: 'object', properties: {} } },
        { name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: {} } }
    ]);
    const ad = mockAdapter(reg, {
        get_screener_columns: { columns: [] },
        run_screener: { rows: [] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.runScreener({ columns: ['close'] }, null), (e) => e && e.code === 'unsupported_tool');
});

test('R10 batch array schema: array sent, CSV string rejected', async () => {
    const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');
    const reg = createToolRegistry({});
    reg.update([{ name: 'get_symbol_data_batch', description: 'qb', inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['symbols'] } }]);
    assert.equal(reg.validate('get_symbol_data_batch', { symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] }).ok, true);
    assert.equal(reg.validate('get_symbol_data_batch', { symbols: 'NASDAQ:AAPL,NASDAQ:MSFT' }).ok, false);
    assert.equal(reg.validate('get_symbol_data_batch', { symbols: ['A', 5] }).ok, false);
    assert.equal(reg.validate('get_symbol_data_batch', { symbols: [] }).ok, false);
});

test('R11 validator types: boolean/object/array/enum paths', async () => {    const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');
    const reg = createToolRegistry({});
    reg.update([{ name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: {
        columns: { type: 'array', items: { type: 'string' } },
        filters: { type: 'object' },
        limit: { type: 'integer' },
        extended: { type: 'boolean' },
        interval: { type: 'string', enum: ['1D', '1W'] }
    } } }]);
    assert.equal(reg.validate('run_screener', { columns: ['close'], filters: {}, limit: 10, extended: true, interval: '1D' }).ok, true);
    assert.equal(reg.validate('run_screener', { columns: 'close' }).ok, false);
    assert.equal(reg.validate('run_screener', { filters: [] }).ok, false);
    assert.equal(reg.validate('run_screener', { limit: 1.5 }).ok, false);
    assert.equal(reg.validate('run_screener', { extended: 'yes' }).ok, false);
    const tf = reg.validate('run_screener', { interval: '9z' });
    assert.equal(tf.ok, false);
    assert.equal(tf.code, 'unsupported_timeframe');
});

test('R12 economic generic resolution via get_economic_symbols', async () => {    const econSymSchema = { type: 'object', properties: { country: { type: 'string' }, search: { type: 'string' } } };
    const econDataSchema = { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] };
    const mk = (symbolsRes) => {
        const reg = regWith([
            { name: 'get_economic_symbols', description: 'es', inputSchema: econSymSchema },
            { name: 'get_economic_data', description: 'ed', inputSchema: econDataSchema }
        ]);
        const ad = mockAdapter(reg, { get_economic_symbols: symbolsRes, get_economic_data: { values: [{ date: '2026-01-01', value: 3.1 }] } });
        return { tool: createMarketDataTool({ adapter: ad }), ad };
    };
    const one = mk({ symbols: ['ECONOMICS:USIRYY'] });
    const out = await one.tool.resolveEconomic({ country: 'US', indicator: 'inflasi' }, null).then((s) => one.tool.getEconomic(s, null));
    assert.equal(out.symbols[0], 'ECONOMICS:USIRYY');
    assert.ok(!JSON.stringify(one.ad.calls).includes('"symbol":""'), 'never calls with empty symbol');
    const multi = mk({ symbols: ['ECONOMICS:USIRYY', 'ECONOMICS:USCPYY'] });
    await assert.rejects(multi.tool.resolveEconomic({ country: 'US', indicator: 'x' }, null), (e) => e && e.code === 'ambiguous_symbol');
    const none = mk({ symbols: [] });
    await assert.rejects(none.tool.resolveEconomic({ country: 'US', indicator: 'x' }, null), (e) => e && e.code === 'no_results');
    const reg2 = regWith([{ name: 'get_economic_data', description: 'ed', inputSchema: econDataSchema }]);
    const ad2 = mockAdapter(reg2, { get_economic_data: {} });
    await assert.rejects(createMarketDataTool({ adapter: ad2 }).resolveEconomic({ country: 'US' }, null), (e) => e && e.code === 'unsupported_tool');
});

test('R13 per-tool timeframe enums differ; no silent fallback', async () => {
    const { toToolInterval } = require('../ai/marketData/timeframeMap.js');
    const ohlcvEnum = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'];
    const techEnum = ['15m', '1h', '4h', '1D', '1W'];
    assert.equal(toToolInterval('M1', techEnum).ok, false, 'M1 absent from tech schema');
    assert.equal(toToolInterval('M1', ohlcvEnum).value, '1m');
    assert.equal(toToolInterval('MN', techEnum).ok, false, 'MN absent from tech schema');
    assert.equal(toToolInterval('MN', ohlcvEnum).value, '1M');
});

test('R14 multi-symbol partial failure keeps clear semantics', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: (args) => ({ symbols: [{ symbol: 'E:' + args.query }] }),
        get_symbol_data: (args) => args.symbol === 'E:B' ? Promise.reject(Object.assign(new Error('boom'), { code: 'network_error' })) : ({ close: 1 })
    });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrices(['A', 'B'], null), (e) => e && e.code === 'network_error');
});

test('R15 server-shape mock contract (§9): batch array, ohlcv, tech, screener', async () => {
    const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');
    const reg = createToolRegistry({});
    reg.update([
        { name: 'search_symbols', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
        { name: 'get_symbol_data_batch', description: 'qb', inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } }, required: ['symbols'] } },
        { name: 'get_ohlcv', description: 'o', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1m', '1D'] }, count: { type: 'integer' } }, required: ['symbol'] } },
        { name: 'get_technicals_rating', description: 't', inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1D'] } }, required: ['symbol'] } },
        { name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, filters: { type: 'object' }, limit: { type: 'integer' } } } }
    ]);
    assert.equal(reg.validate('get_symbol_data_batch', { symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] }).ok, true);
    assert.equal(reg.validate('get_ohlcv', { symbol: 'X', interval: '1D', count: 100 }).ok, true);
    assert.equal(reg.validate('get_technicals_rating', { symbol: 'X', interval: '1D' }).ok, true);
    assert.equal(reg.validate('run_screener', { columns: ['close'], filters: {}, limit: 50 }).ok, true);
    assert.equal(reg.validate('run_screener', { columns: 'close' }).ok, false);
});

test('R16 nested object schema validation', async () => {
    const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');
    const reg = createToolRegistry({});
    reg.update([{ name: 'run_screener', description: 'sc', inputSchema: { type: 'object', properties: {
        filters: { type: 'object', required: ['rsi'], properties: { rsi: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } } }
    } } }]);
    assert.equal(reg.validate('run_screener', { filters: { rsi: [null, 30] } }).ok, false, 'null element fails number check');
    assert.equal(reg.validate('run_screener', { filters: { rsi: [20, 30] } }).ok, true);
    assert.equal(reg.validate('run_screener', { filters: {} }).ok, false, 'nested required enforced');
    assert.equal(reg.validate('run_screener', { filters: { rsi: [20] } }).ok, false, 'minItems enforced');
    assert.equal(reg.validate('run_screener', { filters: 'x' }).ok, false, 'object type enforced');
});

test('R17 empty symbol never reaches market tools', async () => {
    const { createMarketDataFromConfig } = require('../ai/marketData/marketDataFactory.js');
    const httpRequest = async () => ({ status: 200, headers: {}, bodyText: '{}', contentType: 'application/json' });
    const { marketDataTool } = createMarketDataFromConfig({ enabled: true, httpRequest });
    for (const plan of [
        { intent: 'market_price', symbols: [], timeframes: [] },
        { intent: 'market_ohlcv', symbols: [], timeframes: [] },
        { intent: 'technical_analysis', symbols: [], timeframes: [] },
        { intent: 'fundamental_analysis', symbols: [], timeframes: [] },
        { intent: 'market_news', symbols: [], timeframes: [] },
        { intent: 'economic_data', symbols: [], timeframes: [] }
    ]) {
        await assert.rejects(marketDataTool.fetch(plan, null), (e) => e && (e.code === 'symbol_required' || e.code === 'no_results' || e.code === 'unsupported_tool'), plan.intent);
    }
});

test('R18 entity fallback resolves via search_symbols, no empty call', async () => {
    const { createMarketDataFromConfig } = require('../ai/marketData/marketDataFactory.js');
    const calls = [];
    const httpRequest = async (req) => {
        calls.push(req);
        const body = JSON.parse(req.body);
        if (body.method === 'initialize') return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }), contentType: 'application/json' };
        if (body.method === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '', contentType: 'application/json' };
        if (body.method === 'tools/list') return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [
            { name: 'search_symbols', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
            { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
        ] } }), contentType: 'application/json' };
        if (body.method === 'tools/call' && body.params.name === 'search_symbols') {
            return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { symbols: [{ symbol: 'NASDAQ:NVDA' }] } }), contentType: 'application/json' };
        }
        return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { close: 180 } }), contentType: 'application/json' };
    };
    const { marketDataTool, adapter } = createMarketDataFromConfig({ enabled: true, httpRequest, mode: 'legacy' });
    await adapter.setup(null);
    const out = await marketDataTool.fetch({ intent: 'market_price', symbols: [], timeframes: [], entity: 'Nvidia' }, null);
    assert.equal(out.symbols[0], 'NASDAQ:NVDA');
    const searchCalls = calls.filter((c) => { try { const b = JSON.parse(c.body); return b.method === 'tools/call' && b.params.name === 'search_symbols'; } catch (e) { return false; } });
    assert.ok(searchCalls.length >= 1, 'entity resolved via search_symbols');
    assert.ok(!JSON.stringify(calls).includes('"query":""'), 'no empty search query');
});

test('R19 non-price-shaped tool skipped as price source', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'X:Y' }] },
        get_symbol_data: { description: 'no numbers here' },
        get_ohlcv: { bars: [{ c: 42 }] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrice('X', null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'get_ohlcv', 'price-shape-less tool skipped');
    assert.equal(out.rows[0].c, 42);
});

test('R20 price matrix: quote fields pass, bare OHLC rejected', async () => {
    const mk = (quoteRes) => {
        const reg = regWith([
            { name: 'search_symbols', description: 's', inputSchema: symSchema() },
            { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
        ]);
        const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'X:Y' }] }, get_symbol_data: quoteRes });
        return createMarketDataTool({ adapter: ad });
    };
    assert.equal((await mk({ price: 123 }).getPrice('X', null)).rows[0].price, 123);
    assert.equal((await mk({ last: 123 }).getPrice('X', null)).rows[0].last, 123);
    assert.equal((await mk({ close: 123 }).getPrice('X', null)).rows[0].close, 123);
    await assert.rejects(mk({ open: 123, high: 125, low: 120 }).getPrice('X', null), (e) => e && e.code === 'unsupported_tool');
});

test('R21 getPriceBySymbol: valid passes, priceless rejects', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const okAd = mockAdapter(reg, { get_symbol_data: { last: 9 } });
    const okTool = createMarketDataTool({ adapter: okAd });
    assert.equal((await okTool.getPriceBySymbol('X:Y', null)).last, 9);
    const badAd = mockAdapter(reg, { get_symbol_data: { note: 'no price' } });
    await assert.rejects(createMarketDataTool({ adapter: badAd }).getPriceBySymbol('X:Y', null), (e) => e && e.code === 'unsupported_tool');
});

test('R22 batch priceless rows fall back to singles', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_symbol_data_batch', description: 'qb', inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] } }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: (args) => ({ symbols: [{ symbol: 'E:' + args.query }] }),
        get_symbol_data: (args) => ({ symbol: args.symbol, close: 50 }),
        get_symbol_data_batch: { rows: [{ symbol: 'E:A', note: 'x' }] },
        get_ohlcv: { bars: [{ c: 42 }] }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrices(['A', 'B'], null);
    assert.deepEqual(out.symbols, ['E:A', 'E:B']);
    assert.ok(out.rows.every((r) => typeof r.close === 'number'), 'single-call fallback rows carry price');
});

test('R23 first candidate priceless, second valid wins', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'X:Y' }] },
        get_symbol_data: { description: 'shapeless' },
        get_ohlcv: { bars: [{ c: 77 }] }
    });
    const out = await createMarketDataTool({ adapter: ad }).getPrice('X', null);
    assert.equal(ad.calls[ad.calls.length - 1].name, 'get_ohlcv');
    assert.equal(out.rows[0].c, 77);
});

test('R24 all candidates priceless fails existing behavior', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }
    ]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'X:Y' }] }, get_symbol_data: { open: 1, high: 2, low: 3 } });
    await assert.rejects(createMarketDataTool({ adapter: ad }).getPrice('X', null), (e) => e && e.code === 'unsupported_tool');
});

test('R25 metadataUrl propagation factory to transport', async () => {
    const { createMarketDataFromConfig } = require('../ai/marketData/marketDataFactory.js');
    const seen = [];
    const httpRequest = async (req) => {
        seen.push(req);
        if (String(req.method || 'POST') === 'GET') {
            return { status: 200, headers: {}, bodyText: JSON.stringify({ protocolVersions: ['2026-07-28'] }), contentType: 'application/json' };
        }
        const body = JSON.parse(req.body);
        return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), contentType: 'application/json' };
    };
    const { adapter } = createMarketDataFromConfig({ enabled: true, httpRequest, mode: 'modern', metadataUrl: 'https://meta.test/mcp' });
    const info = await adapter.setup(null);
    assert.equal(info.version, '2026-07-28');
    assert.ok(seen.some((r) => String(r.method || '') === 'GET' && r.url === 'https://meta.test/mcp'), 'metadata GET reached transport');
    const { adapter: adapter2 } = createMarketDataFromConfig({ enabled: true, httpRequest, mode: 'modern' });
    const seen2 = [];
    const http2 = async (req) => { seen2.push(req); const body = JSON.parse(req.body); return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), contentType: 'application/json' }; };
    const f2 = createMarketDataFromConfig({ enabled: true, httpRequest: http2, mode: 'modern' });
    await f2.adapter.setup(null);
    assert.ok(!seen2.some((r) => String(r.method || '') === 'GET'), 'no metadata fetch when unconfigured (backward compatible)');
    void adapter2;
});
