// tests/ai-live-data-fallback.test.js — 2026-09-13: when the general web search backend
// is unavailable (upstream outage / zero results), structured live-data questions
// (weather / stocks / news) are grounded from keyless direct APIs instead of failing.
// Network is mocked; only the engine orchestration is under test.
const { test } = require('node:test');
const assert = require('node:assert');
const Gt = require('../ai/groundingTypes.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');

function failingTool() {
    return {
        search(req, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            const e = new Error('no healthy upstream (engines: brave, google cse)');
            e.code = 'upstream_unavailable';
            e.stage = 'web_search_upstream';
            e._stage = 'web_search_upstream';
            setTimeout(() => cb(e), 1);
        },
        _calls: () => 1
    };
}

function stockHttpProvider() {
    // canned Yahoo Finance chart response
    const yahooBody = JSON.stringify({
        chart: { result: [{ meta: { symbol: 'BTC-USD', regularMarketPrice: 77105.91, chartPreviousClose: 78259.52, currency: 'USD', shortName: 'Bitcoin', regularMarketTime: 1789270380 } }] }
    });
    return (url, canc, cb) => setTimeout(() => cb(null, yahooBody, { status: 200, contentType: 'application/json' }), 1);
}

function groundedAnswerProvider() {
    // for live queries the engine goes straight to web search (pre-search leg) with NO
    // provider call first — so the single provider call is the grounded leg.
    let calls = 0;
    const payloads = [];
    const provider = {
        request(payload, cancellable, cb) {
            calls++;
            payloads.push(payload);
            return cb(null, { type: 'answer', text: 'BTC sekarang 77105.91 USD' });
        },
        _calls: () => calls,
        _payloads: () => payloads
    };
    return provider;
}

test('live-data fallback: stock outage + live stock query -> grounded from direct API (non-streaming)', async () => {
    const provider = groundedAnswerProvider();
    const engine = createAISearchEngine({
        provider,
        webSearchTool: failingTool(),
        enableGrounding: true,
        liveDataFallback: true,
        liveDataHttpGet: stockHttpProvider()
    });
    const out = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: (d) => resolve({ got: d }), onError: (e) => resolve({ err: e }) });
    });
    assert.ok(out.got, 'answer delivered via live-data fallback, got: ' + JSON.stringify(out.err || {}));
    assert.equal(out.got.text, 'BTC sekarang 77105.91 USD');
    assert.equal(out.got.grounded, true, 'live-data sources count as grounding');
    assert.equal(out.got.sources.length, 1);
    assert.ok(/yahoo/i.test(out.got.sources[0].url), 'source is the direct API');
    assert.equal(provider._calls(), 1, 'single grounded provider call (pre-search leg runs before any generation)');
    const groundedPayload = provider._payloads()[0];
    assert.ok(groundedPayload.groundingContext, 'API data injected as grounding context');
    assert.ok(/77105/.test(groundedPayload.groundingContext), 'real price inside the grounding context');
});

test('live-data fallback: streaming outage + live stock query -> grounded stream from direct API', async () => {
    const yahooBody = JSON.stringify({ chart: { result: [{ meta: { symbol: 'BTC-USD', regularMarketPrice: 77105.91, chartPreviousClose: 78259.52, currency: 'USD' } }] } });
    let groundedStream = null;
    const provider = {
        request() { throw new Error('non-streaming must not be used'); },
        streamRequest(payload, cancellable, onEvent) {
            if (!payload.groundingContext) {
                // first leg: emit a tool_call, engine should run web search (fails) then live-data API
                setTimeout(() => onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'harga bitcoin terbaru' } }), 1);
                return;
            }
            groundedStream = onEvent;
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'BTC sekarang 77105.91 USD' });
            onEvent({ type: 'complete', result: { text: 'BTC sekarang 77105.91 USD', sources: [] } });
        }
    };
    const engine = createAISearchEngine({
        provider,
        webSearchTool: failingTool(),
        enableGrounding: true,
        liveDataFallback: true,
        liveDataHttpGet: (url, canc, cb) => setTimeout(() => cb(null, yahooBody, { status: 200, contentType: 'application/json' }), 1)
    });
    const out = await new Promise((resolve) => {
        engine.searchStream('q', null, {
            onStart: () => {},
            onDelta: () => {},
            onComplete: (d) => resolve({ got: d }),
            onError: (e) => resolve({ err: e })
        });
    });
    assert.ok(out.got, 'grounded stream via live-data fallback, got: ' + JSON.stringify(out.err || {}));
    assert.equal(out.got.text, 'BTC sekarang 77105.91 USD');
    assert.ok(out.got.sources && out.got.sources.length === 1, 'sources attached');
    assert.ok(groundedStream, 'grounded (second) stream ran');
});

test('live-data fallback: API also fails -> honest outage error remains', async () => {
    const provider = groundedAnswerProvider();
    const engine = createAISearchEngine({
        provider,
        webSearchTool: failingTool(),
        enableGrounding: true,
        liveDataFallback: true,
        liveDataHttpGet: (url, canc, cb) => setTimeout(() => cb(new Error('network down')), 1)
    });
    const out = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: (d) => resolve({ got: d }), onError: (e) => resolve({ err: e }) });
    });
    assert.ok(out.err, 'error when both web search and direct API fail');
    assert.equal(out.err.code, 'upstream_unavailable');
    assert.equal(out.got, undefined);
});

test('live-data fallback: disabled -> previous behavior (outage error)', async () => {
    const provider = groundedAnswerProvider();
    const engine = createAISearchEngine({
        provider,
        webSearchTool: failingTool(),
        enableGrounding: true,
        liveDataFallback: false
    });
    const out = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: (d) => resolve({ got: d }), onError: (e) => resolve({ err: e }) });
    });
    assert.ok(out.err, 'outage error preserved when fallback disabled');
    assert.equal(out.err.code, 'upstream_unavailable');
});

test('live-data fallback module: detection + weather/news fetch (mocked httpGet)', async () => {
    const { createLiveDataFallback } = require('../ai/liveDataFallback.js');
    const geo = JSON.stringify({ results: [{ name: 'Jakarta', country: 'Indonesia', latitude: -6.2, longitude: 106.8 }] });
    const forecast = JSON.stringify({ current: { temperature_2m: 30.1, relative_humidity_2m: 70, weather_code: 61, wind_speed_10m: 9.1 }, daily: { time: ['2026-09-13'], weather_code: [61], temperature_2m_max: [33], temperature_2m_min: [25] } });
    const rss = '<rss><channel><item><title>Berita satu</title><link>https://contoh.id/a</link><description><![CDATA[isi berita]]></description></item></channel></rss>';
    const responses = [
        ['geocoding-api.open-meteo.com', geo],
        ['api.open-meteo.com', forecast],
        ['cnnindonesia.com', rss]
    ];
    const ldf = createLiveDataFallback({
        timeoutMs: 500,
        httpGet: (url, canc, cb) => {
            const hit = responses.find(([host]) => url.indexOf(host) >= 0);
            if (hit) return setTimeout(() => cb(null, hit[1], { status: 200, contentType: 'application/json' }), 1);
            return setTimeout(() => cb(new Error('unexpected url: ' + url)), 1);
        }
    });
    assert.equal(ldf.detectDomain('cuaca jakarta'), 'weather');
    assert.equal(ldf.detectDomain('harga bitcoin'), 'stock');
    assert.equal(ldf.detectDomain('berita terkini'), 'news');
    assert.equal(ldf.detectDomain('cara reset password'), null);

    const w = await ldf.fetch('cuaca di jakarta hari ini', null);
    assert.equal(w.domain, 'weather');
    assert.ok(/30\.1/.test(w.sources[0].snippet), 'temperature in snippet');

    const n = await ldf.fetch('berita terkini', null);
    assert.equal(n.domain, 'news');
    assert.equal(n.sources.length, 1);
    assert.equal(n.sources[0].title, 'Berita satu');
});
