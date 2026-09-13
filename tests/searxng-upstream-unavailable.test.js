const { test } = require('node:test');
const assert = require('node:assert');
const { createSearXngProvider } = require('../ai/searchProviders/searxngProvider.js');

function fakeHttpGet(html) {
    return (url, canc, cb) => cb(null, html, { status: 200, contentType: 'text/html; charset=utf-8' });
}
function upstreamDownPage() {
    return `<html><body>
    <div id="results" class="">
    <div class="dialog-error-block" role="alert"><p><strong>Sorry!</strong></p><p>No results were found.</p></div>
    </div>
    <div id="engines_msg"><table class="engine-stats" id="engines_msg-table">
    <tr><td class="engine-name"><a href="/stats?engine=brave">brave</a></td>
    <td class="response-error">Suspended: too many requests</td></tr>
    <tr><td class="engine-name"><a href="/stats?engine=google+cse">google cse</a></td>
    <td class="response-error">Suspended: access denied</td></tr>
    <tr><td class="engine-name"><a href="/stats?engine=bing">bing</a></td>
    <td class="response-error">Suspended: CAPTCHA</td></tr></table></div>
    </body></html>`;
}
function genuineNoResultsPage() {
    return `<html><body><div id="results"><p>Sorry! No results found.</p></div></body></html>`;
}

test('C. upstream suspended page -> UPSTREAM_UNAVAILABLE, not NO_RESULTS', async () => {
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(upstreamDownPage()) });
    let err = null;
    try { await provider.search('cek kenaikan ihsg hari ini', null); } catch (e) { err = e; }
    assert.ok(err, 'must reject');
    assert.equal(err.code, 'upstream_unavailable');
});

test('D. CAPTCHA-only page -> UPSTREAM_UNAVAILABLE', async () => {
    const html = `<html><body><div class="dialog-error-block"><p>No results were found.</p></div><td class="response-error">Suspended: CAPTCHA</td></body></html>`;
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(html) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'upstream_unavailable');
});

test('E. access-denied page -> UPSTREAM_UNAVAILABLE', async () => {
    const html = `<html><body><div class="dialog-error-block"><p>No results were found.</p></div><td class="response-error">Suspended: access denied</td></body></html>`;
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(html) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'upstream_unavailable');
});

test('B. genuine no-results stays NO_RESULTS', async () => {
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(genuineNoResultsPage()) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'no_results');
});

test('F. arbitrary HTML with word Suspended is NOT upstream_unavailable', async () => {
    const html = `<html><body><p>I feel Suspended in mid-air today, what a word.</p></body></html>`;
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(html) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'no_results');
});

test('G. malformed HTML keeps existing parse behavior', async () => {
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet('<html><<//broken') });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'no_results');
});

test('E2E. provider -> tool -> engine keeps upstream_unavailable + stage', async () => {
    const { createProductionWebSearchTool } = require('../ai/webSearchTool.js');
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const tool = createProductionWebSearchTool({
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: fakeHttpGet(upstreamDownPage())
    });
    const prov = createMockAiProvider({ responses: [{ type: 'answer', text: 'never reached' }] });
    const engine = createAISearchEngine({ provider: prov, webSearchTool: tool, enableGrounding: true });
    let err = null;
    await new Promise((res) => engine.search('cek kenaikan ihsg hari ini', (e) => { err = e; res(); }));
    assert.ok(err, 'must error, not answer');
    assert.equal(err.code, 'upstream_unavailable');
    assert.equal(err.stage || err._stage, 'web_search_upstream');
    assert.ok(/no healthy upstream/i.test(err.message), 'message names the outage, got: ' + err.message);
});

test('H. connection refused stays backend_unavailable', async () => {
    const provider = createSearXngProvider({
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, canc, cb) => { const e = new Error('connect ECONNREFUSED'); e.code = 'backend_unavailable'; cb(e); }
    });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'backend_unavailable');
});

test('I. upstream error detail names the suspended engines', async () => {
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(upstreamDownPage()) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'upstream_unavailable');
    assert.ok(/engines: brave/i.test(err.message), 'message names engines, got: ' + err.message);
    assert.ok(/google\s?\+?\s?cse/i.test(err.message), 'message includes second engine, got: ' + err.message);
});

test('J. no engine-name cells -> upstream error without engines detail (graceful)', async () => {
    const html = `<html><body><div id="results"></div><td class="response-error">Suspended: CAPTCHA</td></body></html>`;
    const provider = createSearXngProvider({ searxngUrl: 'http://127.0.0.1:8080', httpGet: fakeHttpGet(html) });
    let err = null;
    try { await provider.search('q', null); } catch (e) { err = e; }
    assert.ok(err);
    assert.equal(err.code, 'upstream_unavailable');
    assert.ok(!/engines:/.test(err.message), 'no engines detail when cells missing, got: ' + err.message);
});
