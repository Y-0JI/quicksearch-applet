const { test } = require('node:test');
const assert = require('node:assert');
const { createProductionWebSearchTool, WEB_SEARCH_RUNTIME_VERSION } = require('../ai/webSearchTool.js');
const { createSearXngProvider, parseSearXngHtml } = require('../ai/searchProviders/searxngProvider.js');

function searxngHtmlWithResults() {
    return `<html><body><div id="results">
    <article class="result"><h3><a href="https://example.com/a">Title A</a></h3><p class="content">snippet a</p></article>
    <article class="result"><h3><a href="https://example.com/b">Title B</a></h3><p class="content">snippet b</p></article>
    <article class="result"><h3><a href="#/local">Broken Local</a></h3><p class="content">skip me</p></article>
    <article class="result"><h3><a href="javascript:void(0)">JS Link</a></h3><p class="content">skip me</p></article>
  </div></body></html>`;
}
function searxngHtmlNoResults() {
    return `<html><body><div id="results"><p>Sorry! No results found.</p></div></body></html>`;
}

function fakeHttpGet(responder) {
    return (url, canc, cb) => responder(url, cb);
}

test('P6 runtime marker is P6-searxng-html', () => {
    assert.equal(WEB_SEARCH_RUNTIME_VERSION, 'P6-searxng-html');
});

test('1. HTTP 200 HTML with valid results -> SearchResult[] length > 0 (parser)', () => {
    const out = parseSearXngHtml(searxngHtmlWithResults());
    assert.ok(out.length > 0, 'parser must find results');
    assert.equal(out.length, 2, 'invalid entries are dropped (relative + javascript links)');
    for (const r of out) {
        assert.equal(typeof r.title, 'string');
        assert.ok(r.title.length > 0, 'title exists');
        assert.equal(typeof r.url, 'string');
        assert.ok(/^https?:\/\//.test(r.url), 'destination URL present: ' + r.url);
        assert.equal(typeof r.snippet, 'string', 'snippet normalized to string');
    }
    assert.equal(out[0].url, 'https://example.com/a');
});

test('2. HTTP 200 HTML but no results -> explicit no_results at web_search_parse', async () => {
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlNoResults(), { status: 200, contentType: 'text/html' }))
    });
    let err = null;
    try { await provider.search('chelsea', null); } catch (e) { err = e; }
    assert.ok(err, 'must reject, not return empty success');
    assert.equal(err.code, 'no_results');
    assert.equal(err.stage, 'web_search_parse');
    assert.equal(err.httpStatus, 200);
    assert.equal(err.backend, 'searxng_html');
});

test('3. HTTP 403 -> explicit backend/request error, never no_results', async () => {
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => {
            const e = new Error('HTTP 403');
            e.status = 403; e.httpStatus = 403; e.contentType = 'text/html';
            cb(e);
        })
    });
    let err = null;
    try { await provider.search('chelsea', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.notEqual(err.code, 'no_results', '403 must not be reported as no_results');
    assert.equal(err.stage, 'web_search_request');
    assert.equal(err.httpStatus, 403);
    assert.ok(err.message.includes('403'));
});

test('4. Content-Type is not text/html -> invalid_response', async () => {
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlWithResults(), { status: 200, contentType: 'application/json' }))
    });
    let err = null;
    try { await provider.search('chelsea', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'invalid_response');
    assert.equal(err.stage, 'web_search_parse');
    assert.ok(err.message.toLowerCase().includes('content-type'));
});

test('5. parser result items are normalized SearchResult (title/url/snippet)', () => {
    const out = parseSearXngHtml('<html><body>' +
        '<article class="result"><h3><a href="https://example.com/x">  Spaced &amp; Title  </a></h3><p class="content">   <b>snip</b> text   </p></article>' +
        '</body></html>');
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'Spaced & Title');
    assert.equal(out[0].url, 'https://example.com/x');
    assert.ok(out[0].snippet.includes('snip text'));
});

test('6. E2E canonical path: SearXNG HTML -> parser -> SearchResult[] -> tool result -> AI sources', async () => {
    const tool = createProductionWebSearchTool({
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlWithResults(), { status: 200, contentType: 'text/html' }))
    });
    const tr = await new Promise((res, rej) => tool.search({ query: 'cek jadwal chelsea minggu ini', maxResults: 5 }, (err, r) => err ? rej(err) : res(r)));
    assert.equal(tr.type, 'tool_result');
    assert.ok(tr.sources.length > 0, 'toolResult.sources must be > 0, got ' + tr.sources.length);
    assert.ok(tr.sources[0].url, 'source has url');

    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    // P3 web-first: live query searches FIRST (engine-side) then ONE grounded AI request — the
    // provider only ever receives the grounded payload, so it answers directly (no tool_call).
    const prov = createMockAiProvider({ responses: [
        { type: 'answer', text: 'grounded answer about chelsea' }
    ] });
    const engine = createAISearchEngine({ provider: prov, webSearchTool: tool, enableGrounding: true });
    const out = await new Promise((res, rej) => engine.search('cek jadwal chelsea minggu ini', (err, r) => err ? rej(err) : res(r)));
    assert.equal(out.text, 'grounded answer about chelsea');
    assert.ok(Array.isArray(out.sources) && out.sources.length > 0, 'AI must receive grounded sources, got ' + (out.sources && out.sources.length));
});

test('6b. tool-level no-results error carries explicit parse stage (never Stage unknown)', async () => {
    const tool = createProductionWebSearchTool({
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlNoResults(), { status: 200, contentType: 'text/html' }))
    });
    let err = null;
    await new Promise((res) => tool.search({ query: 'chelsea', maxResults: 5 }, (e) => { err = e; res(); }));
    assert.ok(err, 'no-results page must error at the tool boundary, not empty success');
    assert.ok(String(err.message).includes('No search results'), err.message);
    assert.equal(err.stage, 'web_search_parse');
    assert.notEqual(err.stage, 'unknown');
    assert.equal(err.httpStatus, 200);
});

test('7. regression: valid raw results never become empty sources at any layer', async () => {
    const raw = [
        { title: 'Chelsea', url: 'https://example.com/chelsea', snippet: 'fixture snippet' }
    ];
    // parser -> provider -> normalizeSearchResults keeps it
    const html = '<html><body><article class="result"><h3><a href="https://example.com/chelsea">Chelsea</a></h3><p class="content">fixture snippet</p></article></body></html>';
    const tool = createProductionWebSearchTool({
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, html, { status: 200, contentType: 'text/html' }))
    });
    const tr = await new Promise((res, rej) => tool.search({ query: 'chelsea', maxResults: 5 }, (err, r) => err ? rej(err) : res(r)));
    assert.ok(tr.sources.length > 0, 'valid raw must survive into tool_result sources');
    assert.equal(tr.sources[0].url, raw[0].url);

    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const prov = createMockAiProvider({ responses: [
        { type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } },
        { type: 'answer', text: 'ok' }
    ] });
    const engine = createAISearchEngine({ provider: prov, webSearchTool: tool, enableGrounding: true });
    const out = await new Promise((res, rej) => engine.search('chelsea', (err, r) => err ? rej(err) : res(r)));
    assert.ok(out.sources.length > 0, 'sources survive into the AI grounded answer');
});

test('P7 init: SearXNG provider module loads and exposes a working factory', async () => {
    const { createSearXngProvider } = require('../ai/searchProviders/searxngProvider.js');
    assert.equal(typeof createSearXngProvider, 'function', 'provider factory must be exported');
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlWithResults(), { status: 200, contentType: 'text/html' }))
    });
    const results = await provider.search('chelsea', null);
    assert.ok(Array.isArray(results) && results.length > 0, 'initialized provider can search');
    // resolution helper must also resolve the module through the production tool path
    const w = require('../ai/webSearchTool.js');
    w._loadSearxngProviderModule();
    assert.ok(w._makeSearxngProviderInitError, 'init-error builder exported');
});

test('P7 init: module-unavailable diagnostic preserves root cause, step, stage', () => {
    const w = require('../ai/webSearchTool.js');
    const e = w._makeSearxngProviderInitError({ causeText: 'Cannot find module ./searchProviders/searxngProvider.js (ENOENT)', step: 'provider_import' });
    assert.equal(e.code, 'backend_unavailable');
    assert.equal(e.stage, 'web_search_init');
    assert.equal(e.step, 'provider_import');
    assert.equal(e.provider, 'searxng');
    assert.ok(String(e.message).includes('provider_import'), 'message names the failing step: ' + e.message);
    assert.ok(String(e.message).includes('ENOENT'), 'root cause must stay in the message: ' + e.message);
    assert.ok(!String(e.message).includes('module unavailable') || String(e.message).includes('root cause'), 'original cause visible');
});

test('P7 init: backend connection failure is NOT classified as module unavailable', async () => {
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet((url, cb) => { const e = new Error('econnrefused'); e.code = 'backend_unavailable'; cb(e); })
    });
    let err = null;
    try { await provider.search('chelsea', null); } catch (e) { err = e; }
    assert.ok(err, 'backend failure must reject');
    assert.equal(err.code, 'backend_unavailable');
    assert.equal(err.stage, 'web_search_request');
    assert.equal(err.step, undefined, 'not a provider-init failure');
    assert.ok(!String(err.message).toLowerCase().includes('module unavailable'), 'must not be mislabeled as module problem: ' + err.message);
});

test('P8: URL validator is GJS-safe — works without global URL API and rejects unsafe URLs', () => {
    const { isHttpUrl, normalizeSearchResult, normalizeSearchResults } = require('../ai/searchProviders/searchResult.js');
    const savedUrl = globalThis.URL;
    try {
        // Simulate the Cinnamon/GJS sandbox where the global URL constructor may be absent.
        delete globalThis.URL;
        // accepted without URL API
        assert.ok(isHttpUrl('https://example.com/chelsea'), 'valid https accepted without URL API');
        assert.ok(isHttpUrl('http://example.com/a'), 'valid http accepted without URL API');
        assert.ok(isHttpUrl('https://example.com:8080/path?q=1#frag'), 'url with port/query/fragment accepted');
        // rejected
        assert.equal(isHttpUrl('javascript:alert(1)'), false);
        assert.equal(isHttpUrl('data:text/html,hi'), false);
        assert.equal(isHttpUrl(''), false);
        assert.equal(isHttpUrl('#fragment'), false);
        assert.equal(isHttpUrl('https:///nohost'), false);
        assert.equal(isHttpUrl('https://'), false);
        assert.equal(isHttpUrl('not a url'), false);
        assert.equal(isHttpUrl('https://exa mple.com'), false, 'whitespace inside url rejected');
        assert.equal(isHttpUrl('ftp://example.com'), false);
        // canonical normalization keeps valid results, never empties due to missing URL API
        assert.ok(normalizeSearchResult({ title: 'Chelsea schedule', url: 'https://example.com/chelsea', snippet: 'x' }));
        assert.ok(normalizeSearchResult({ title: 'Plain', url: 'http://example.org/b' }));
        assert.equal(normalizeSearchResult({ title: 'Bad', url: 'javascript:void(0)' }), null);
        const out = normalizeSearchResults([
            { title: 'Chelsea', url: 'https://example.com/chelsea', snippet: 's1' },
            { title: 'Two', url: 'http://example.org/two', snippet: 's2' }
        ]);
        assert.equal(out.length, 2, 'valid results must never all be dropped without a URL API');
        // groundingTypes canonicalization also survives without URL API
        const Gt = require('../ai/groundingTypes.js');
        const canon = Gt.canonicalizeSources(out);
        assert.equal(canon.length, 2, 'tool-level canonicalization survives without URL API: ' + canon.length);
    } finally {
        if (savedUrl !== undefined) globalThis.URL = savedUrl;
        else delete globalThis.URL;
    }
});

test('P8: zero-out normalization logs per-item drop reason, never silent', () => {
    const { normalizeSearchResults } = require('../ai/searchProviders/searchResult.js');
    const logs = [];
    const savedLog = global.log;
    global.log = (m) => logs.push(m);
    try {
        const out = normalizeSearchResults([{ title: 'x', url: 'ftp://bad.example', snippet: 's' }]);
        assert.equal(out.length, 0, 'invalid entry dropped');
        const trace = logs.find(l => String(l).includes('first_drop_reason='));
        assert.ok(trace, 'drop trace emitted');
        assert.ok(String(trace).includes('raw_count=1'), trace);
        assert.ok(String(trace).includes('normalized_count=0'), trace);
        assert.ok(String(trace).includes('first_raw_url=ftp://bad.example'), trace);
        assert.ok(String(trace).includes('first_drop_reason=url_validation_failed'), trace);
    } finally {
        if (savedLog !== undefined) global.log = savedLog;
        else delete global.log;
    }
});

test('P8 E2E: full canonical path survives without global URL API (bug: parsed>0 but normalized=0)', async () => {
    const savedUrl = globalThis.URL;
    try {
        delete globalThis.URL;
        const w = require('../ai/webSearchTool.js');
        const tool = w.createProductionWebSearchTool({
            engine: 'searxng',
            searxngUrl: 'http://127.0.0.1:8080',
            httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlWithResults(), { status: 200, contentType: 'text/html' }))
        });
        // parser -> provider -> SearchResult[]
        const provider = createSearXngProvider({
            searxngUrl: 'http://127.0.0.1:8080',
            httpGet: fakeHttpGet((url, cb) => cb(null, searxngHtmlWithResults(), { status: 200, contentType: 'text/html' }))
        });
        const parsed = parseSearXngHtml(searxngHtmlWithResults());
        assert.ok(parsed.length > 0, 'parsed_results > 0');
        const results = await provider.search('cek jadwal chelsea minggu ini', null);
        assert.ok(results.length > 0, 'normalized_results > 0 without URL API: got ' + results.length);
        // tool result boundary
        const tr = await new Promise((res, rej) => tool.search({ query: 'cek jadwal chelsea minggu ini', maxResults: 5 }, (err, r) => err ? rej(err) : res(r)));
        assert.ok(tr.sources.length > 0, 'tool_sources > 0 without URL API: got ' + tr.sources.length);
        // AI boundary
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        const { createMockAiProvider } = require('../ai/aiProvider.js');
        // P3 web-first: live query searches engine-side first, so the provider receives the
        // single grounded payload and answers directly (no tool_call first leg).
        const prov = createMockAiProvider({ responses: [
            { type: 'answer', text: 'chelsea grounded answer' }
        ] });
        const engine = createAISearchEngine({ provider: prov, webSearchTool: tool, enableGrounding: true });
        const out = await new Promise((res, rej) => engine.search('cek jadwal chelsea minggu ini', (err, r) => err ? rej(err) : res(r)));
        assert.ok(out.text.length > 0);
        assert.ok(out.sources.length > 0, 'AI received_sources > 0 without URL API: got ' + out.sources.length);
    } finally {
        if (savedUrl !== undefined) globalThis.URL = savedUrl;
        else delete globalThis.URL;
    }
});
