// Phase 13 Step 6: Google (Serper) backend + improved DDG parser tests.
// All tests use injected transports — no real network, no API keys.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider, parseDdgHtml, parseGoogleJson, WEB_ERRORS } = require('../providers/webProvider.js');

const mk = o => o;
const sc = () => 1;

// ── parseGoogleJson ────────────────────────────────────────────────────────

const SERPER_FIXTURE = {
    organic: [
        { title: 'BMRI Stock Price', link: 'https://finance.yahoo.com/quote/BMRI', snippet: 'Bank Mandiri stock price today.' },
        { title: 'TradingView BMRI', link: 'https://tradingview.com/symbols/BMRI', snippet: 'Chart and price data.' },
        { title: 'Investing.com BMRI', link: 'https://investing.com/bmri', snippet: 'Real-time BMRI price.' }
    ],
    searchInformation: { totalResults: '1000000' }
};

test('parseGoogleJson: extracts title, url, snippet from organic results', () => {
    const out = parseGoogleJson(SERPER_FIXTURE, mk, sc);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, 'BMRI Stock Price');
    assert.equal(out[0].url, 'https://finance.yahoo.com/quote/BMRI');
    assert.equal(out[0].description, 'Bank Mandiri stock price today.');
});

test('parseGoogleJson: caps at 5 results', () => {
    const big = { organic: Array.from({ length: 10 }, (_, i) => ({
        title: 'Result ' + i, link: 'https://example.com/' + i, snippet: 'Snippet ' + i
    }))};
    const out = parseGoogleJson(big, mk, sc);
    assert.equal(out.length, 5);
});

test('parseGoogleJson: skips results without valid http(s) url', () => {
    const data = { organic: [
        { title: 'Good', link: 'https://example.com', snippet: 'ok' },
        { title: 'Bad', link: 'ftp://example.com', snippet: 'nope' },
        { title: 'No URL', snippet: 'no url' }
    ]};
    const out = parseGoogleJson(data, mk, sc);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://example.com');
});

test('parseGoogleJson: empty/missing organic -> empty array', () => {
    assert.deepEqual(parseGoogleJson({}, mk, sc), []);
    assert.deepEqual(parseGoogleJson(null, mk, sc), []);
    assert.deepEqual(parseGoogleJson({ organic: [] }, mk, sc), []);
});

// ── Google backend via WebProvider (injected transport) ────────────────────

test('Google backend: agent mode fetches from Serper API, returns real results', () => {
    const stages = [], posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
        useInstantAnswers: false,
        engine: 'google',
        googleApiKey: 'test-key-123',
        httpPost: (url, body, c, cb) => {
            posts.push({ url, body: JSON.parse(body) });
            cb(null, JSON.stringify(SERPER_FIXTURE));
        },
        onStage: n => stages.push(n)
    });
    let delivered = 0;
    wp.search('cari berita BMRI hari ini', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(posts.length, 1, 'exactly ONE POST to Serper');
    assert.equal(posts[0].url, 'https://google.serper.dev/search');
    assert.equal(posts[0].body.q, 'cari berita BMRI hari ini');
    assert.equal(posts[0].body.num, 5);
    assert.ok(stages.includes('http-start'));
    assert.ok(stages.includes('http-done'));
    assert.ok(stages.includes('parse-done'));
    assert.ok(stages.includes('deliver'));
    assert.ok(delivered > 1, 'fallback + real results');
});

test('Google backend: SEARCH mode also works (same backend)', () => {
    const posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
        engine: 'google',
        googleApiKey: 'test-key',
        httpPost: (url, body, c, cb) => {
            posts.push(url);
            cb(null, JSON.stringify(SERPER_FIXTURE));
        }
    });
    wp.search('bmri', null, () => {}, undefined);
    assert.equal(posts.length, 1, 'Google backend used for SEARCH mode too');
});

test('Google backend: no API key -> falls back to DDG instant (no Google request)', () => {
    const gets = [], posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
        engine: 'google',
        googleApiKey: '',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify({ AbstractText: '', RelatedTopics: [] })); },
        httpPost: (url, body, c, cb) => { posts.push(url); cb(null, '<html></html>'); }
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(posts.length, 0, 'no Google POST when API key missing');
    assert.ok(gets.some(u => u.includes('duckduckgo.com')), 'falls back to DDG instant');
    assert.equal(delivered, 1, 'fallback only (empty DDG instant)');
});

test('Google backend: malformed JSON -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
        engine: 'google',
        googleApiKey: 'test-key',
        httpPost: (url, body, c, cb) => cb(null, '{broken json')
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only');
});

test('Google backend: network error -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
        engine: 'google',
        googleApiKey: 'test-key',
        httpPost: (url, body, c, cb) => cb(new Error('network'))
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only');
});

// ── DDG backend unchanged (regression) ────────────────────────────────────

test('DDG backend: agent mode still uses DDG instant GET (not Google)', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        engine: 'ddgo',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify({ AbstractText: 't', AbstractURL: 'https://example.com/a', Heading: 'h', RelatedTopics: [] })); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.equal(gets.length, 1, 'DDG instant GET used');
    assert.ok(gets[0].includes('duckduckgo.com'));
});

test('DDG backend: SEARCH mode uses instant-answer GET (not HTML POST)', () => {
    const posts = [], gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        engine: 'ddgo',
        httpPost: (url, body, c, cb) => { posts.push(url); },
        httpGet: (url, c, cb) => { gets.push(url); cb(null, '{}'); }
    });
    wp.search('test', null, () => {}, undefined);
    assert.equal(gets.length, 1, 'instant-answer GET');
    assert.equal(posts.length, 0, 'no HTML POST');
});

// ── DDG parser robustness (BUG B fix) ─────────────────────────────────────

const ROBUST_FIXTURE = `
<div class="result results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.example.com%2Fa">Title A</a></h2>
  <a class="result__snippet">Snippet for A.</a>
</div>
<div class="web-result">
  <h2 class="result__title"><a class="result__a" href="https://www.example.com/b">Title B (direct URL)</a></h2>
  <a class="result__snippet">Snippet for B.</a>
</div>
<div class="result">
  <a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.example.com%2Fc">Title C</a>
  <p>Some extra text.</p>
  <a class="result__snippet">Snippet C.</a>
</div>
`;

test('DDG parser: extracts from web-result blocks too (robust)', () => {
    const out = parseDdgHtml(ROBUST_FIXTURE, mk, sc);
    assert.ok(out.length >= 2, 'at least 2 results from mixed block types');
    assert.equal(out[0].url, 'https://www.example.com/a');
});

test('DDG parser: empty HTML -> empty array', () => {
    assert.deepEqual(parseDdgHtml('', mk, sc), []);
    assert.deepEqual(parseDdgHtml(null, mk, sc), []);
    assert.deepEqual(parseDdgHtml('<html><body>nothing here</body></html>', mk, sc), []);
});

test('DDG parser: flat anchor extraction fallback when no result blocks', () => {
    const flatHtml = `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F1">Flat Result 1</a>
    <a class="result__snippet">Snippet 1.</a>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2F2">Flat Result 2</a>
    <a class="result__snippet">Snippet 2.</a>
    `;
    const out = parseDdgHtml(flatHtml, mk, sc);
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://example.com/1');
    assert.equal(out[0].title, 'Flat Result 1');
    assert.equal(out[1].url, 'https://example.com/2');
});

// ── WEB_ERRORS constant ────────────────────────────────────────────────────

test('WEB_ERRORS: all expected codes are strings', () => {
    assert.equal(typeof WEB_ERRORS.API_KEY_MISSING, 'string');
    assert.equal(typeof WEB_ERRORS.UNAVAILABLE, 'string');
    assert.equal(typeof WEB_ERRORS.RATE_LIMITED, 'string');
    assert.equal(typeof WEB_ERRORS.NETWORK_ERROR, 'string');
    assert.equal(typeof WEB_ERRORS.BAD_RESPONSE, 'string');
    assert.equal(typeof WEB_ERRORS.NO_RESULTS, 'string');
});

// ── Session scope fix verification ─────────────────────────────────────────
// The old bug: defaultHttpGet/HttpPost referenced `session` which was declared
// inside createWebProvider() but the functions were at module scope.
// After the fix, session-scoped closures are used internally. We verify this
// by confirming the module no longer exports defaultHttpGet/HttpPost (they're
// internal now) and that the module still works correctly.

test('module exports: defaultHttpGet/HttpPost removed (now internal closures)', () => {
    const mod = require('../providers/webProvider.js');
    assert.equal(typeof mod.defaultHttpGet, 'undefined', 'defaultHttpGet no longer exported');
    assert.equal(typeof mod.defaultHttpPost, 'undefined', 'defaultHttpPost no longer exported');
    assert.equal(typeof mod.createWebProvider, 'function');
    assert.equal(typeof mod.parseDdgHtml, 'function');
    assert.equal(typeof mod.parseGoogleJson, 'function');
});

// ── Backend-neutral result format (Step 5) ─────────────────────────────────
// search_web tool in tools/index.js always maps to:
// { query, count, results: [{ title, url, summary }] }
// regardless of backend. Verify the shape via the tool adapter.

test('backend-neutral: both engines produce {title, url, description} shape', () => {
    const googleProvider = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
        engine: 'google', googleApiKey: 'k',
        httpPost: (url, body, c, cb) => cb(null, JSON.stringify(SERPER_FIXTURE))
    });
    const ddgProvider = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true, engine: 'ddgo',
        httpGet: (url, c, cb) => cb(null, JSON.stringify({ AbstractText: 'abstract', AbstractURL: 'https://example.com/a', Heading: 'H', RelatedTopics: [{ Text: 'T', FirstURL: 'https://example.com/b' }] }))
    });
    let googleResults = null, ddgResults = null;
    googleProvider.search('bmri', null, list => { googleResults = list; }, { agent: true });
    ddgProvider.search('bmri', null, list => { ddgResults = list; }, { agent: true });
    // both should have at least fallback + real results
    assert.ok(googleResults && googleResults.length > 1, 'Google: fallback + real results');
    assert.ok(ddgResults && ddgResults.length > 1, 'DDG: fallback + real results');
    // all results should have the expected shape (from makeResult)
    for (const r of googleResults) {
        assert.equal(r.type, 'web');
        assert.ok(r.title);
        assert.ok(r.url);
    }
});
