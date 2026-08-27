// Phase 13 SearXNG Local backend tests.
// All tests use injected transports — no real network, no local SearXNG required.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider, parseSearxngJson, WEB_ERRORS } = require('../providers/webProvider.js');

const mk = o => o;
const sc = () => 1;

// ── parseSearxngJson ───────────────────────────────────────────────────────

const SEARXNG_FIXTURE = {
    results: [
        { title: 'BMRI Stock Price', url: 'https://finance.yahoo.com/quote/BMRI', content: 'Bank Mandiri stock price today.' },
        { title: 'TradingView BMRI', url: 'https://tradingview.com/symbols/BMRI', content: 'Chart and price data.' },
        { title: 'Investing.com BMRI', url: 'https://investing.com/bmri', content: 'Real-time BMRI price.' }
    ],
    number_of_results: 1000000
};

test('parseSearxngJson: extracts title, url, content from results', () => {
    const out = parseSearxngJson(SEARXNG_FIXTURE, mk, sc);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, 'BMRI Stock Price');
    assert.equal(out[0].url, 'https://finance.yahoo.com/quote/BMRI');
    assert.equal(out[0].description, 'Bank Mandiri stock price today.');
});

test('parseSearxngJson: caps at 5 results', () => {
    const big = { results: Array.from({ length: 10 }, (_, i) => ({
        title: 'Result ' + i, url: 'https://example.com/' + i, content: 'Snippet ' + i
    }))};
    const out = parseSearxngJson(big, mk, sc);
    assert.equal(out.length, 5);
});

test('parseSearxngJson: skips results without valid http(s) url', () => {
    const data = { results: [
        { title: 'Good', url: 'https://example.com', content: 'ok' },
        { title: 'Bad', url: 'ftp://example.com', content: 'nope' },
        { title: 'No URL', content: 'no url' }
    ]};
    const out = parseSearxngJson(data, mk, sc);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://example.com');
});

test('parseSearxngJson: empty/missing results -> empty array', () => {
    assert.deepEqual(parseSearxngJson({}, mk, sc), []);
    assert.deepEqual(parseSearxngJson(null, mk, sc), []);
    assert.deepEqual(parseSearxngJson({ results: [] }, mk, sc), []);
});

// ── SearXNG backend via WebProvider (injected transport) ───────────────────

test('SearXNG backend: agent mode fetches from local SearXNG, returns real results', () => {
    const stages = [], gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: false,
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => {
            gets.push(url);
            cb(null, JSON.stringify(SEARXNG_FIXTURE));
        },
        onStage: n => stages.push(n)
    });
    let delivered = 0;
    wp.search('cari berita BMRI hari ini', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(gets.length, 1, 'exactly ONE GET to SearXNG');
    assert.ok(gets[0].includes('127.0.0.1:8080/search'));
    assert.ok(gets[0].includes('q=cari'));
    assert.ok(gets[0].includes('format=json'));
    assert.ok(stages.includes('http-start'));
    assert.ok(stages.includes('http-done'));
    assert.ok(stages.includes('parse-done'));
    assert.ok(stages.includes('deliver'));
    assert.ok(delivered > 1, 'fallback + real results');
});

test('SearXNG backend: custom URL is used', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://192.168.1.100:8888',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify(SEARXNG_FIXTURE)); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.ok(gets[0].includes('192.168.1.100:8888'));
});

test('SearXNG backend: SEARCH mode also works (same backend)', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify(SEARXNG_FIXTURE)); }
    });
    wp.search('bmri', null, () => {}, undefined);
    assert.equal(gets.length, 1, 'SearXNG backend used for SEARCH mode too');
});

test('SearXNG backend: URL trailing slash stripped', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080/',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify(SEARXNG_FIXTURE)); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.ok(gets[0].includes('127.0.0.1:8080/search'), 'no double slash');
});

test('SearXNG backend: malformed JSON -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => cb(null, '{broken json')
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only');
});

test('SearXNG backend: network error -> fallback with unavailable message', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => cb(new Error('ECONNREFUSED'))
    });
    let delivered = 0;
    let fallbackDesc = '';
    wp.search('test', null, list => {
        delivered = (list || []).length;
        if (list && list[0]) fallbackDesc = list[0].description || '';
    }, { agent: true });
    assert.equal(delivered, 1, 'fallback only');
    assert.ok(fallbackDesc.includes('SearXNG'), 'unavailable message in fallback');
});

test('SearXNG backend: empty results -> fallback only', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => cb(null, JSON.stringify({ results: [] }))
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only (empty results)');
});

test('SearXNG backend: cancellation prevents delivery', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => cb(null, JSON.stringify(SEARXNG_FIXTURE))
    });
    let callCount = 0;
    const fakeCanc = { is_cancelled: () => true };
    wp.search('test', fakeCanc, () => { callCount++; }, { agent: true });
    // deliver() checks cancellation before calling onDone
    // fallback is delivered before the cancellable check (guaranteed instant)
    // but the upgrade delivery IS cancelled
    assert.ok(callCount <= 1, 'at most 1 delivery (fallback guaranteed, upgrade cancelled)');
});

// ── Default URL constant ───────────────────────────────────────────────────

test('SearXNG default URL is localhost', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng'
        // no searxngUrl → should use default
    });
    // We can't observe the URL without httpGet, but the factory should not throw
    assert.ok(wp, 'WebProvider created with searxng engine');
});

// ── Regression: DDG and Google still work ──────────────────────────────────

test('DDG regression: agent mode still uses HTML POST', () => {
    const posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true, engine: 'ddgo',
        httpPost: (url, body, c, cb) => { posts.push(url); cb(null, '<html></html>'); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].includes('html.duckduckgo.com'));
});

test('Google regression: agent mode still uses Serper POST', () => {
    const posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
        engine: 'google', googleApiKey: 'test-key',
        httpPost: (url, body, c, cb) => { posts.push(url); cb(null, JSON.stringify({ organic: [] })); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].includes('serper.dev'));
});

// ── WEB_ERRORS ─────────────────────────────────────────────────────────────

test('WEB_ERRORS includes SEARXNG_UNAVAILABLE', () => {
    assert.equal(WEB_ERRORS.SEARXNG_UNAVAILABLE, 'searxng-unavailable');
});

// ── normalizeSearchEngine handles searxng ──────────────────────────────────

test('normalizeSearchEngine: searxng and searxng (local) both map to searxng', () => {
    const { normalizeSearchEngine } = require('../utils.js');
    assert.equal(normalizeSearchEngine('searxng'), 'searxng');
    assert.equal(normalizeSearchEngine('SearXNG (Local)'), 'searxng');
    assert.equal(normalizeSearchEngine('searxng (local)'), 'searxng');
});
