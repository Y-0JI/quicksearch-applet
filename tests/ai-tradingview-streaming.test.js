// tests/ai-tradingview-streaming.test.js — financial leg on searchStream
const { test } = require('node:test');
const assert = require('node:assert');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');

test('S1 searchStream routes financial query to marketDataTool with deltas', async () => {
    let marketCalled = 0;
    const marketDataTool = {
        detect: (q) => (/harga btc/i.test(q) ? { intent: 'market_price', symbols: ['BTC'], timeframes: [] } : null),
        fetch: async () => { marketCalled++; return { type: 'market_data', kind: 'market_price', symbols: ['BINANCE:BTCUSDT'], interval: null, rows: [{ close: 67000 }], attribution: 'TradingView', sources: [] }; }
    };
    const provider = createMockStreamingAiProvider({ chunks: ['BTC ', '67000.'] });
    const engine = createAISearchEngine({ provider, marketDataTool, enableGrounding: true });
    const deltas = [];
    const final = await new Promise((resolve, reject) => {
        engine.searchStream('Berapa harga BTC sekarang?', null, {
            onDelta: (c) => deltas.push(c),
            onComplete: (p) => resolve(p),
            onError: (e) => reject(e)
        });
    });
    assert.equal(marketCalled, 1);
    assert.ok(deltas.length > 0, 'deltas streamed');
    assert.ok(/67000/.test(final.text), 'grounded text delivered');
});

test('S2 searchStream non-financial untouched', async () => {
    let marketCalled = 0;
    const marketDataTool = { detect: () => null, fetch: async () => { marketCalled++; return null; } };
    const provider = createMockStreamingAiProvider({ chunks: ['Halo.'] });
    const engine = createAISearchEngine({ provider, marketDataTool, enableGrounding: true });
    const final = await new Promise((resolve, reject) => {
        engine.searchStream('Apa itu Linux?', null, { onComplete: (p) => resolve(p), onError: (e) => reject(e) });
    });
    assert.equal(marketCalled, 0);
    assert.ok(/Halo/.test(final.text));
});
