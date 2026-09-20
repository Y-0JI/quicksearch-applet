// tests/ai-tradingview-intent.test.js — financial intent gate + timeframe + min-call planner
const { test } = require('node:test');
const assert = require('node:assert');
const { detectFinancialIntent } = require('../ai/marketData/financialIntent.js');
const { toToolInterval } = require('../ai/marketData/timeframeMap.js');
const { planMarketCalls } = require('../ai/marketData/minCallPlanner.js');

test('F1 false positives stay non-financial', () => {
    for (const q of ['Berita terbaru Linux Mint', 'harga laptop', 'filter file PDF', 'data cuaca Jakarta']) {
        assert.equal(detectFinancialIntent(q), null, q);
    }
});

test('F2 financial queries route with intent', () => {
    assert.equal(detectFinancialIntent('Berapa harga BTC sekarang?').intent, 'market_price');
    assert.equal(detectFinancialIntent('Cek RSI EURUSD 1 jam').intent, 'technical_analysis');
    assert.equal(detectFinancialIntent('Analisis XAUUSD M15').intent, 'technical_analysis');
    assert.equal(detectFinancialIntent('Berikan fundamental BBCA').intent, 'fundamental_analysis');
    assert.equal(detectFinancialIntent('Ada berita terbaru tentang NVIDIA?').intent, 'market_news');
    assert.equal(detectFinancialIntent('Cari saham US dengan RSI oversold').intent, 'financial_screener');
    assert.equal(detectFinancialIntent('inflasi US').intent, 'economic_data');
    assert.equal(detectFinancialIntent('Cari simbol BTCUSDT di TradingView').intent, 'symbol_lookup');
});

test('F3 timeframe extracted canonically', () => {
    assert.equal(detectFinancialIntent('Analisis XAUUSD M15').timeframes[0], 'M15');
    assert.equal(detectFinancialIntent('Cek RSI EURUSD 1 jam').timeframes[0], 'H1');
    assert.equal(detectFinancialIntent('XAUUSD H1, M15 dan M1').timeframes.join(','), 'H1,M15,M1');
});

test('F4 multi-symbol split without guessing exchange', () => {
    const r = detectFinancialIntent('Bandingkan BTC ETH SOL');
    assert.ok(r.symbols.length >= 3, JSON.stringify(r));
    assert.equal(r.intent, 'market_price');
});

test('F5 timeframe validated per-tool schema, not global map', () => {
    assert.equal(toToolInterval('M15', ['1m', '15m', '1D']).ok, true);
    assert.equal(toToolInterval('M15', ['1m', '15m', '1D']).value, '15m');
    const bad = toToolInterval('MN', ['1m', '15m']);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'unsupported_timeframe');
    assert.ok(bad.accepted.length === 2, 'accepted values reported');
});

test('F6 planner minimum calls per intent', () => {
    assert.deepEqual(planMarketCalls({ intent: 'market_price', symbols: ['BTC'] }).steps, ['resolve:BTC', 'market_price']);
    const ta = planMarketCalls({ intent: 'technical_analysis', symbols: ['X'], wantsBars: false });
    assert.ok(ta.steps.indexOf('technicals') >= 0 && ta.steps.indexOf('ohlcv') < 0, JSON.stringify(ta));
    const taBars = planMarketCalls({ intent: 'technical_analysis', symbols: ['X'], wantsBars: true });
    assert.ok(taBars.steps.indexOf('ohlcv') >= 0, JSON.stringify(taBars));
    const f = planMarketCalls({ intent: 'fundamental_analysis', symbols: ['N'], wantsConsensus: false });
    assert.ok(f.steps.indexOf('financials') >= 0 && f.steps.indexOf('forecasts') < 0);
    const n = planMarketCalls({ intent: 'market_news', symbols: ['N'], wantsStory: false });
    assert.ok(n.steps.indexOf('news') >= 0 && n.steps.indexOf('news_story') < 0);
    const s = planMarketCalls({ intent: 'financial_screener', symbols: [] });
    assert.ok(s.steps.indexOf('screener_columns_cached') >= 0 && s.steps.indexOf('run_screener') >= 0);
});
