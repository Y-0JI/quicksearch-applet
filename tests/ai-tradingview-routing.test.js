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
        get_symbol_data: (args) => ({ close: args.symbol })
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
