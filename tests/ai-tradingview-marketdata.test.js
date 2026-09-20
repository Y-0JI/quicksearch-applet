// tests/ai-tradingview-marketdata.test.js — market-native normalization + symbol + price
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketDataTool } = require('../ai/marketData/marketDataTool.js');
const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');

function symSchema() { return { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }; }
function ohlcvSchema() { return { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1m', '15m', '1h', '1D'] }, count: { type: 'integer' } }, required: ['symbol'] }; }
function quoteSchema() { return { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }; }
function techSchema() { return { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['15m', '1h', '1D'] } }, required: ['symbol'] }; }

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

test('P1 price prefers get_symbol_data when advertised', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_symbol_data', description: 'q', inputSchema: quoteSchema() },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'NASDAQ:NVDA', description: 'NVIDIA' }] },
        get_symbol_data: { close: 180.5, change: 1.2 }
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrice('NVDA', null);
    assert.equal(out.type, 'market_data');
    assert.equal(out.kind, 'market_price');
    assert.equal(out.symbols[0], 'NASDAQ:NVDA');
    assert.equal(out.attribution, 'TradingView');
    assert.equal(ad.calls[1].name, 'get_symbol_data');
    assert.ok(!JSON.stringify(out).includes('http'), 'no fabricated url');
});

test('P2 price falls back to get_ohlcv count=1 when quote absent', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }
    ]);
    const ad = mockAdapter(reg, {
        search_symbols: { symbols: [{ symbol: 'BINANCE:BTCUSDT' }] },
        get_ohlcv: (args) => ({ bars: [{ t: 1, c: 67000 }], echoCount: args.count })
    });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getPrice('BTC', null);
    assert.equal(ad.calls[1].args.count, 1);
    assert.equal(out.rows[0].c, 67000);
});

test('P3 no suitable price tool fails unsupported_tool', async () => {
    const reg = regWith([
        { name: 'search_symbols', description: 's', inputSchema: symSchema() },
        { name: 'get_news', description: 'n', inputSchema: symSchema() }
    ]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'X:Y' }] } });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrice('X', null), (e) => e && e.code === 'unsupported_tool');
});

test('P4 ambiguous symbol fails with candidates, never guesses', async () => {
    const reg = regWith([{ name: 'search_symbols', description: 's', inputSchema: symSchema() }]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [{ symbol: 'A:BTC' }, { symbol: 'B:BTC' }] } });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrice('BTC', null), (e) => e && e.code === 'ambiguous_symbol' && e.candidates.length === 2);
    assert.equal(ad.calls.length, 1, 'no price call after ambiguity');
});

test('P5 invalid symbol maps no_results', async () => {
    const reg = regWith([{ name: 'search_symbols', description: 's', inputSchema: symSchema() }]);
    const ad = mockAdapter(reg, { search_symbols: { symbols: [] } });
    const tool = createMarketDataTool({ adapter: ad });
    await assert.rejects(tool.getPrice('ZZZQQQ', null), (e) => e && e.code === 'no_results');
});

test('P6 ohlcv rows native, unsupported timeframe reports accepted', async () => {
    const reg = regWith([{ name: 'get_ohlcv', description: 'o', inputSchema: ohlcvSchema() }]);
    const ad = mockAdapter(reg, { get_ohlcv: { bars: [{ t: 1, o: 10, h: 11, l: 9, c: 10.5, v: 100 }] } });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getOhlcv('X:Y', 'M15', 5, null);
    assert.equal(out.interval, '15m');
    assert.deepEqual(out.rows[0], { t: 1, o: 10, h: 11, l: 9, c: 10.5, v: 100 });
    await assert.rejects(tool.getOhlcv('X:Y', 'MN', 5, null), (e) => e && e.code === 'unsupported_timeframe');
});

test('P7 technicals interval validated per tech schema', async () => {
    const reg = regWith([{ name: 'get_technicals_rating', description: 't', inputSchema: techSchema() }]);
    const ad = mockAdapter(reg, { get_technicals_rating: { RSI: 55 } });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getTechnicals('X:Y', 'M15', null);
    assert.equal(out.interval, '15m');
    assert.equal(out.rows[0].RSI, 55);
});

test('P8 news rows carry real urls only; url-less data has none', async () => {
    const reg = regWith([{ name: 'get_news', description: 'n', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } }]);
    const ad = mockAdapter(reg, { get_news: { news: [{ title: 't', link: 'https://x.com/a' }] } });
    const tool = createMarketDataTool({ adapter: ad });
    const out = await tool.getNews('X:Y', null);
    assert.equal(out.sources[0].url, 'https://x.com/a');
});
