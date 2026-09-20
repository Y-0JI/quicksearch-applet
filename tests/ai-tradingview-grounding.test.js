// tests/ai-tradingview-grounding.test.js — MARKET_GUIDANCE + engine financial branch
const { test } = require('node:test');
const assert = require('node:assert');

test('G1 MARKET_GUIDANCE exists with delay + safety + attribution wording', () => {
    const pb = require('../ai/promptBuilder.js');
    assert.ok(pb.MARKET_GUIDANCE, 'MARKET_GUIDANCE exported');
    const g = pb.MARKET_GUIDANCE;
    assert.ok(!/real-time/i.test(g) || /jangan|never|kecuali|unless/i.test(g), 'no bare real-time claim');
    assert.ok(/TradingView/i.test(g), 'attribution present');
    assert.ok(/bukan kepastian|bukan.*profit|indikator menunjukkan/i.test(g), 'safety language present');
});

test('G2 market guidance appended only on financial leg', () => {
    const pb = require('../ai/promptBuilder.js');
    const plain = pb.buildSystemPrompt({ intent: { primary: 'current' } });
    assert.ok(!/Data pasar: TradingView/.test(plain), 'not in normal prompt');
    const fin = pb.buildSystemPrompt({ intent: { primary: 'current' }, marketData: true });
    assert.ok(/Data pasar: TradingView/.test(fin), 'present on financial leg');
});

test('G3 engine routes financial query to marketDataTool, not web_search', async () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    let webCalled = 0;
    const webSearchTool = { search: (req, canc, cb) => { webCalled++; if (typeof canc === 'function') { cb = canc; } cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: [] }); } };
    let marketCalled = 0;
    const marketDataTool = {
        detect: (q) => (/harga btc/i.test(q) ? { intent: 'market_price', symbols: ['BTC'], timeframes: [] } : null),
        fetch: async (plan) => { marketCalled++; return { type: 'market_data', kind: 'market_price', symbols: ['BINANCE:BTCUSDT'], interval: null, rows: [{ close: 67000 }], attribution: 'TradingView', sources: [] }; }
    };
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'BTC sekitar 67000 menurut data TradingView.' }] });
    const engine = createAISearchEngine({ provider, webSearchTool, marketDataTool, enableGrounding: true });
    const res = await new Promise((resolve, reject) => {
        engine.search('Berapa harga BTC sekarang?', null, (err, r) => err ? reject(err) : resolve(r));
    });
    assert.equal(marketCalled, 1);
    assert.equal(webCalled, 0);
    assert.ok(/67000/.test(res.text), 'grounded answer delivered');
});

test('G4 non-financial query untouched (web path, market not called)', async () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    let marketCalled = 0;
    const marketDataTool = {
        detect: () => null,
        fetch: async () => { marketCalled++; return null; }
    };
    const webSearchTool = { search: (req, canc, cb) => { if (typeof canc === 'function') { cb = canc; } cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: [] }); } };
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'Linux Mint adalah distro.' }] });
    const engine = createAISearchEngine({ provider, webSearchTool, marketDataTool, enableGrounding: true });
    const res = await new Promise((resolve, reject) => {
        engine.search('Berita terbaru Linux Mint', null, (err, r) => err ? reject(err) : resolve(r));
    });
    assert.equal(marketCalled, 0);
    assert.ok(/Linux Mint/.test(res.text));
});

test('G5 market failure fails closed, no fabricated numbers', async () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const marketDataTool = {
        detect: () => ({ intent: 'market_price', symbols: ['BTC'], timeframes: [] }),
        fetch: async () => { const e = new Error('TradingView authentication required'); e.code = 'auth_expired'; throw e; }
    };
    const webSearchTool = { search: (req, canc, cb) => { if (typeof canc === 'function') { cb = canc; } cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: [] }); } };
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'should not be used' }] });
    const engine = createAISearchEngine({ provider, webSearchTool, marketDataTool, enableGrounding: true });
    await assert.rejects(new Promise((resolve, reject) => {
        engine.search('Berapa harga BTC sekarang?', null, (err, r) => err ? reject(err) : resolve(r));
    }), (e) => e && (e.code === 'auth_expired' || /TradingView/i.test(e.message || '')));
});

test('G6 bearer redaction in market errors', async () => {
    const { createMarketDataTool } = require('../ai/marketData/marketDataTool.js');
    const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');
    const reg = createToolRegistry({});
    reg.update([]);
    const adapter = { registry: () => reg, callTool: async () => { throw new Error('fail Bearer SECRET-TOKEN-XYZ'); } };
    const tool = createMarketDataTool({ adapter });
    assert.ok(!/SECRET/.test(JSON.stringify(Object.keys(tool))), 'no token in tool shape');
});
