// Bing backend tests (Phase 15 follow-up).
// All tests use injected transports — no real network, no API key.
// Bing uses a no-credential HTML scrape, normalized to the shared web result shape.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider, parseBingHtml, WEB_ERRORS } = require('../providers/webProvider.js');

const mk = o => o;
const sc = () => 1;

// ── parseBingHtml ────────────────────────────────────────────────────────────

const BING_FIXTURE = `
<!DOCTYPE html><html><body>
<li class="b_algo">
  <h2><a href="https://www.bankmandiri.co.id/bmri" h="ID=SERP,1">BMRI - Bank Mandiri Resmi</a></h2>
  <div class="b_caption"><p>Bank Mandiri (BMRI) informasi saham dan berita hari ini.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://finance.yahoo.com/quote/BMRI">BMRI Stock - Yahoo Finance</a></h2>
  <div class="b_caption"><p>Real-time BMRI price and chart.</p></div>
</li>
<li class="b_algo">
  <h2><a href="https://tradingview.com/symbols/BMRI">TradingView BMRI</a></h2>
  <div class="b_caption"><p>BMRI chart and technical analysis.</p></div>
</li>
`;

test('parseBingHtml: extracts title, url, snippet from b_algo blocks', () => {
    const out = parseBingHtml(BING_FIXTURE, mk, sc);
    assert.equal(out.length, 3);
    assert.equal(out[0].title, 'BMRI - Bank Mandiri Resmi');
    assert.equal(out[0].url, 'https://www.bankmandiri.co.id/bmri');
    assert.ok(out[0].description.includes('Bank Mandiri'));
});

test('parseBingHtml: result shape matches other web backends', () => {
    const out = parseBingHtml(BING_FIXTURE, mk, sc);
    for (const r of out) {
        assert.equal(r.type, 'web');
        assert.equal(r.score, sc('web-instant'));
        assert.ok(r.title && r.url && /^https?:\/\//.test(r.url));
        assert.equal(r.icon, 'web-browser');
    }
});

test('parseBingHtml: caps at 5 results', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
        `<li class="b_algo"><h2><a href="https://example.com/${i}">R ${i}</a></h2><div class="b_caption"><p>snip ${i}</p></div></li>`).join('');
    const out = parseBingHtml(many, mk, sc);
    assert.equal(out.length, 5);
});

test('parseBingHtml: skips non-http(s) urls', () => {
    const html = `
      <li class="b_algo"><h2><a href="ftp://example.com/x">Bad</a></h2><div class="b_caption"><p>nope</p></div></li>
      <li class="b_algo"><h2><a href="https://good.example/y">Good</a></h2><div class="b_caption"><p>ok</p></div></li>`;
    const out = parseBingHtml(html, mk, sc);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://good.example/y');
});

test('parseBingHtml: empty/malformed HTML -> empty array (no crash)', () => {
    assert.deepEqual(parseBingHtml('', mk, sc), []);
    assert.deepEqual(parseBingHtml(null, mk, sc), []);
    assert.deepEqual(parseBingHtml('<html><body>no results</body></html>', mk, sc), []);
    assert.deepEqual(parseBingHtml('<div class="b_algo"></div>', mk, sc), []); // no h2/a
});

// ── Bing backend via WebProvider (injected transport) ─────────────────────────

test('Bing backend: engine selection routes to Bing, not DuckDuckGo', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        useInstantAnswers: false,
        engine: 'bing',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, BING_FIXTURE); }
    });
    wp.search('cari berita BMRI', null, () => {}, { agent: true });
    assert.equal(gets.length, 1, 'exactly ONE GET for Bing');
    assert.ok(gets[0].includes('www.bing.com/search'), 'request went to Bing');
    assert.ok(!gets[0].includes('duckduckgo'), 'Bing must NOT route to DuckDuckGo');
});

test('Bing backend: query is URL-encoded in the request', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, BING_FIXTURE); }
    });
    wp.search('cari berita BMRI hari ini', null, () => {}, { agent: true });
    assert.ok(gets[0].includes('q='));
    assert.ok(gets[0].includes('BMRI') || gets[0].includes('cari'), 'query present (encoded)');
});

test('Bing backend: AGENT mode fetches Bing HTML and returns normalized results', () => {
    const stages = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(null, BING_FIXTURE),
        onStage: n => stages.push(n)
    });
    let delivered = 0;
    wp.search('cari berita BMRI', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.ok(stages.includes('http-start'));
    assert.ok(stages.includes('http-done'));
    assert.ok(stages.includes('parse-done'));
    assert.ok(stages.includes('deliver'));
    assert.ok(delivered > 1, 'fallback + real Bing results');
});

test('Bing backend: SEARCH mode also works (same Bing backend)', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, BING_FIXTURE); }
    });
    wp.search('bmri', null, () => {}, undefined);
    assert.equal(gets.length, 1, 'Bing used for SEARCH mode too');
    assert.ok(gets[0].includes('bing.com'));
});

test('Bing backend: empty results -> fallback only', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(null, '<html><body>no b_algo here</body></html>')
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only (empty parse)');
});

test('Bing backend: malformed HTML -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(null, '{broken')
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only (malformed)');
});

test('Bing backend: network error -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(new Error('ECONNREFUSED'))
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only (network error)');
});

test('Bing backend: timeout-like error -> fallback only, no crash', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(new Error('timeout'))
    });
    let delivered = 0;
    wp.search('test', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(delivered, 1, 'fallback only (timeout)');
});

test('Bing backend: cancellation prevents upgrade delivery', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing',
        httpGet: (url, c, cb) => cb(null, BING_FIXTURE)
    });
    let callCount = 0;
    const fakeCanc = { is_cancelled: () => true };
    wp.search('test', fakeCanc, () => { callCount++; }, { agent: true });
    assert.ok(callCount <= 1, 'at most 1 delivery (fallback guaranteed, upgrade cancelled)');
});

// ── Regression: other engines must NOT be affected by Bing ────────────────────

test('DDG regression: engine=ddgo still uses DuckDuckGo, not Bing', () => {
    const gets = [], posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        engine: 'ddgo',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, '{}'); },
        httpPost: (url, body, c, cb) => { posts.push(url); cb(null, '<html></html>'); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.ok(posts.some(u => u.includes('html.duckduckgo.com')), 'DDG HTML used');
    assert.ok(!gets.some(u => u.includes('bing.com')), 'no Bing GET');
});

test('Google regression: engine=google still uses Serper', () => {
    const posts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
        engine: 'google', googleApiKey: 'k',
        httpPost: (url, body, c, cb) => { posts.push(url); cb(null, JSON.stringify({ organic: [] })); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.equal(posts.length, 1);
    assert.ok(posts[0].includes('serper.dev'), 'Google -> Serper');
    assert.ok(!posts[0].includes('bing.com'));
});

test('SearXNG regression: engine=searxng still uses local instance', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => { gets.push(url); cb(null, JSON.stringify({ results: [] })); }
    });
    wp.search('test', null, () => {}, { agent: true });
    assert.ok(gets[0].includes('127.0.0.1:8080'), 'SearXNG local used');
    assert.ok(!gets[0].includes('bing.com'));
});

// ── WEB_ERRORS still intact ───────────────────────────────────────────────────

test('WEB_ERRORS unchanged (Bing adds no new code)', () => {
    assert.equal(typeof WEB_ERRORS.UNAVAILABLE, 'string');
    assert.equal(WEB_ERRORS.SEARXNG_UNAVAILABLE, 'searxng-unavailable');
});
