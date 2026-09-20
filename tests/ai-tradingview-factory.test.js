// tests/ai-tradingview-factory.test.js — factory wiring: default off, injectable on
const { test } = require('node:test');
const assert = require('node:assert');
const { createMarketDataFromConfig } = require('../ai/marketData/marketDataFactory.js');
const { createAiEngine } = require('../ai/aiFactory.js');
const { createMockAiProvider } = require('../ai/aiProvider.js');

test('W1 factory returns null tool when disabled (default)', () => {
    const out = createMarketDataFromConfig({});
    assert.equal(out.marketDataTool, null);
    assert.equal(out.disabled, true);
});

test('W2 factory builds tool when httpRequest injected + enabled', () => {
    const httpRequest = async () => ({ status: 200, headers: {}, bodyText: '{}', contentType: 'application/json' });
    const out = createMarketDataFromConfig({ enabled: true, httpRequest });
    assert.ok(out.marketDataTool && typeof out.marketDataTool.fetch === 'function' && typeof out.marketDataTool.detect === 'function');
    assert.ok(out.adapter && typeof out.adapter.setup === 'function');
    assert.ok(out.auth && typeof out.auth.getAccessToken === 'function');
});

test('W3 factory without httpRequest stays disabled even when enabled', () => {
    const out = createMarketDataFromConfig({ enabled: true });
    assert.equal(out.marketDataTool, null);
    assert.equal(out.disabled, true);
});

test('W4 engine accepts injected marketDataTool, engine without it unchanged', async () => {
    let marketCalled = 0;
    const marketDataTool = {
        detect: () => ({ intent: 'market_price', symbols: ['BTC'], timeframes: [] }),
        fetch: async () => { marketCalled++; return { type: 'market_data', kind: 'market_price', symbols: ['X'], interval: null, rows: [{ close: 1 }], attribution: 'TradingView', sources: [] }; }
    };
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'ok' }] });
    const engine = createAiEngine({ provider, marketDataTool, enableGrounding: false });
    assert.ok(engine && typeof engine.search === 'function');
    assert.equal(marketCalled, 0);
});
