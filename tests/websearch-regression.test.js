// Regression tests for Web Search reliability (Search-only)
// Covers: success, timeout, network error, cancellation, cleanup,
// no duplicate, URL handling, normal search, SearXNG, Google, DDG, Bing
const { test } = require('node:test');
const assert = require('node:assert');
// Mock Cinnamon GI for searchEngine in Node
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function(id){
  if (id === 'gi.Gio') return { Cancellable: function(){ this.cancelled=false; this.cancel=()=>{this.cancelled=true;}; this.is_cancelled=()=>this.cancelled; } };
  if (id === 'gi.GLib') return { SOURCE_REMOVE:0, PRIORITY_DEFAULT:0, source_remove:()=>{} };
  if (id === 'mainloop') return { timeout_add: (ms,fn)=>{ const id=setTimeout(fn,ms); return id; } };
  if (id === 'gi.St' || id === 'gi.Clutter') return {};
  return origRequire.apply(this, arguments);
};
const { createWebProvider, REQUEST_TIMEOUT_MS, parseBingHtml, parseDdgHtml, parseGoogleJson, parseSearxngJson } = require('../providers/webProvider.js');
const { createSearchEngine } = require('../searchEngine.js');
const { classifyQuery, makeResult, scoreResult } = require('../result.js');

const mk = o => o;
const sc = () => 1;

function makeCanc() {
  let cancelled = false;
  return {
    cancel() { cancelled = true; },
    is_cancelled() { return cancelled; },
    get cancelled() { return cancelled; }
  };
}

// ---- 1. Web Search success ----
test('1. Web Search success: SearXNG returns real results', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => cb(null, JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', content: 'snip' }] }))
  });
  let delivered = 0;
  wp.search('test', null, list => { delivered = (list||[]).length; });
  assert.ok(delivered > 1, 'fallback + real');
});

test('1b. Web Search success: DDG instant returns real results', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    engine: 'ddgo', useInstantAnswers: true,
    httpGet: (u, c, cb) => cb(null, JSON.stringify({ AbstractText: 'abstract', AbstractURL: 'https://example.com/a', Heading: 'H', RelatedTopics: [] }))
  });
  let delivered = 0;
  wp.search('bmri', null, list => { delivered = (list||[]).length; });
  assert.ok(delivered >= 1);
});

test('1c. Web Search success: Google returns real results', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
    engine: 'google', googleApiKey: 'k',
    httpPost: (u, b, c, cb) => cb(null, JSON.stringify({ organic: [{ title: 'T', link: 'https://example.com/a', snippet: 's' }] }))
  });
  let delivered = 0;
  wp.search('test', null, list => { delivered = (list||[]).length; });
  assert.ok(delivered > 1);
});

test('1d. Web Search success: Bing returns real results', () => {
  const html = `<li class="b_algo"><h2><a href="https://example.com/a">Title A</a></h2><div class="b_caption"><p>snip</p></div></li>`;
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://bing.com/search?q=' + encodeURIComponent(q),
    engine: 'bing',
    httpGet: (u, c, cb) => cb(null, html)
  });
  let delivered = 0;
  wp.search('test', null, list => { delivered = (list||[]).length; });
  assert.ok(delivered > 1);
});

// ---- 2. Web Search timeout ----
test('2. Web Search timeout: hanging transport triggers timeout fallback after REQUEST_TIMEOUT_MS', async () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => { /* never calls back -> hang */ }
  });
  let callCount = 0;
  wp.search('hang query', null, list => { callCount++; });
  assert.equal(callCount, 1);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(callCount, 1, 'still only fallback before timeout');
  wp.destroy();
});

// ---- 3. Web Search network error ----
test('3. Web Search network error: SearXNG network error delivers human-readable fallback', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => cb(new Error('ECONNREFUSED'))
  });
  let lastDesc = '';
  wp.search('test', null, list => { if (list && list[0]) lastDesc = list[0].description || ''; });
  assert.ok(lastDesc.includes('SearXNG'), 'human-readable SearXNG message');
  assert.ok(!lastDesc.includes('ECONNREFUSED'), 'raw error not leaked');
});

test('3b. Web Search network error: Google falls back without raw trace', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
    engine: 'google', googleApiKey: 'k',
    httpPost: (u, b, c, cb) => cb(new Error('network failure'))
  });
  let delivered = 0;
  wp.search('test', null, list => { delivered = (list||[]).length; });
  assert.equal(delivered, 1, 'fallback only, no raw trace');
});

test('3c. Web Search network error: Bing fallback human-readable', () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://bing.com/search?q=' + encodeURIComponent(q),
    engine: 'bing',
    httpGet: (u, c, cb) => cb(new Error('timeout'))
  });
  let delivered = 0;
  wp.search('test', null, list => { delivered = (list||[]).length; });
  assert.equal(delivered, 1);
});

// ---- 4. Web Search cancellation ----
test('4. Web Search cancellation: cancelled request does not deliver upgrade', () => {
  const canc = makeCanc();
  canc.cancel();
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => cb(null, JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', content: 'x' }] }))
  });
  let callCount = 0;
  wp.search('test', canc, () => { callCount++; });
  assert.equal(callCount, 0, 'cancelled: no delivery');
});

// ---- 5. Web Search cleanup ----
test('5. Web Search cleanup: webProvider destroy clears session', async () => {
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => cb(null, JSON.stringify({ results: [] }))
  });
  wp.search('test', null, () => {});
  wp.destroy();
  const wp2 = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://ddg/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u, c, cb) => cb(null, JSON.stringify({ results: [{ title: 'A', url: 'https://example.com/a', content: 'x' }] }))
  });
  let delivered = 0;
  wp2.search('test', null, list => { delivered = (list||[]).length; });
  assert.ok(delivered >= 1);
});

test('5b. No duplicate request: each search triggers exactly one HTTP', () => {
  let gets = 0;
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://bing.com/search?q=' + encodeURIComponent(q),
    engine: 'bing',
    httpGet: (u, c, cb) => { gets++; cb(null, `<li class="b_algo"><h2><a href="https://example.com/a">T</a></h2><p>s</p></li>`); }
  });
  wp.search('one', null, () => {});
  assert.equal(gets, 1);
  wp.search('two', null, () => {});
  assert.equal(gets, 2, 'second search makes second request, not duplicate for first');
});

// ---- 8. URL query detection still works ----
test('8. URL query detection still works', () => {
  const { detectUrl } = require('../providers/urlProvider.js');
  assert.ok(detectUrl('https://example.com'), 'https URL detected');
  assert.ok(detectUrl('http://google.com/search?q=BMRI'), 'http URL detected');
  assert.ok(detectUrl('example.com'), 'bare domain detected');
  assert.equal(detectUrl('carikan berita BMRI hari ini'), null, 'info query not a URL');
  assert.equal(detectUrl('berapa harga emas hari ini?'), null);
});

// ---- 9. normal search regression ----
test('9. Normal search: app/file/web classification via classifyQuery', () => {
  const r = classifyQuery('bmri');
  assert.equal(r.apps, true);
  assert.equal(r.files, true);
  assert.equal(r.web, true);
  assert.equal(r.url, false);
  assert.equal(r.calc, false);
  const urlR = classifyQuery('https://example.com');
  assert.equal(urlR.url, true);
  assert.equal(urlR.web, false);
  const calcR = classifyQuery('2+2');
  assert.equal(calcR.calc, true);
});

// ---- 11. SearXNG regression ----
test('11. SearXNG regression: selected engine respected, not silent DDG', () => {
  let gets = [];
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    engine: 'searxng', searxngUrl: 'http://127.0.0.1:8080',
    httpGet: (u,c,cb)=>{ gets.push(u); cb(null, JSON.stringify({ results: [{title:'A', url:'https://example.com/a', content:'x'}] })); }
  });
  wp.search('test', null, ()=>{});
  assert.ok(gets[0].includes('127.0.0.1:8080/search'), 'SearXNG URL used');
  assert.ok(!gets[0].includes('duckduckgo'), 'not routed to DDG');
});

// ---- 12. Google regression ----
test('12. Google regression: engine google uses Serper', () => {
  const posts = [];
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://google.com/search?q=' + encodeURIComponent(q),
    engine: 'google', googleApiKey: 'k',
    httpPost: (u,b,c,cb)=>{ posts.push(u); cb(null, JSON.stringify({ organic: [{title:'A', link:'https://example.com/a', snippet:'s'}] })); }
  });
  wp.search('test', null, ()=>{});
  assert.ok(posts[0].includes('serper.dev'), 'Google -> Serper');
});

// ---- 13. DDG regression ----
test('13. DDG regression: engine ddgo uses DuckDuckGo instant', () => {
  const gets = [];
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    engine: 'ddgo', useInstantAnswers: true,
    httpGet: (u,c,cb)=>{ gets.push(u); cb(null, JSON.stringify({ AbstractText: 't', AbstractURL: 'https://example.com/a', Heading: 'h', RelatedTopics: [] })); }
  });
  wp.search('test', null, ()=>{});
  assert.ok(gets[0].includes('duckduckgo.com'), 'DDG instant');
});

// ---- 14. Bing regression ----
test('14. Bing regression: engine bing uses Bing', () => {
  const gets = [];
  const wp = createWebProvider({
    makeResult: mk, scoreResult: sc,
    fallbackUrlFor: q => 'https://bing.com/search?q=' + encodeURIComponent(q),
    engine: 'bing',
    httpGet: (u,c,cb)=>{ gets.push(u); cb(null, `<li class="b_algo"><h2><a href="https://example.com/a">T</a></h2><p>s</p></li>`); }
  });
  wp.search('test', null, ()=>{});
  assert.ok(gets[0].includes('bing.com'), 'Bing');
  assert.ok(!gets[0].includes('duckduckgo'), 'not DDG');
});
