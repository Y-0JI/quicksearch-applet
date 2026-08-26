// Regression tests for the agent's DuckDuckGo HTML-results path (Phase 13,
// option 2). Uses a REAL captured DDG HTML fixture (real bytes, real anchor/
// snippet/uddg structure) so parsing is exercised for real — no canned JSON.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider, parseDdgHtml } = require('../providers/webProvider.js');

// Real-shape DDG HTML (6 results; agent path caps at 5). URLs are uddg redirectors.
const FIXTURE = `
<div class="result results_links_deep web-result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.google.com%2Ffinance%2Fquote%2FBMRI">Bank Mandiri (Persero) Tbk PT (BMRI) Stock Price &amp; News</a></h2>
  <a class="result__snippet">Harga saham BMRI hari ini Rp 4.500 di Google Finance.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fid.tradingview.com%2Fsymbols%2FIDX-BMRI">Chart &amp; Harga Saham BMRI — IDX:BMRI</a></h2>
  <a class="result__snippet">TradingView menampilkan chart BMRI.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fid.investing.com%2Fequities%2Fbank-mandiri">Harga Saham BMRI hari ini | Investing.com</a></h2>
  <a class="result__snippet">Data lengkap BMRI.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fajaib.co.id%2Fsaham%2Faset%2FBMRI">Harga Saham BMRI Hari Ini - Ajaib</a></h2>
  <a class="result__snippet">Ajaib menyediakan.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Ffive">Result 5</a></h2>
  <a class="result__snippet">Fifth.</a>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fsix">Result 6 (must be capped)</a></h2>
  <a class="result__snippet">Sixth.</a>
</div>
`;

const mk = o => o;
const sc = () => 1;

test('parseDdgHtml: extracts real results, decodes uddg, caps at 5, no shell', () => {
    const out = parseDdgHtml(FIXTURE, mk, sc);
    assert.equal(out.length, 5, 'capped at 5 (6 in fixture)');
    assert.equal(out[0].url, 'https://www.google.com/finance/quote/BMRI', 'uddg decoded');
    assert.ok(out[0].title.includes('Bank Mandiri'), 'entity decoded (&amp;)');
    assert.ok(out[0].description.includes('Google Finance'), 'snippet captured');
    out.forEach(r => assert.ok(/^https?:\/\//.test(r.url), 'valid http url: ' + r.url));
});

test('AGENT path: webProvider fetches HTML (POST), delivers real results, single request', () => {
    const stages = [], httpPosts = [], httpGets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        httpPost: (u, b, c, cb) => { httpPosts.push(u); cb(null, FIXTURE); },
        httpGet: (u, c, cb) => { httpGets.push(u); },
        onStage: (n) => stages.push(n)
    });
    let delivered = 0;
    wp.search('cari berita BMRI hari ini', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(httpPosts.length, 1, 'exactly ONE HTML POST (no hidden retry)');
    assert.equal(httpGets.length, 0, 'agent does NOT use the instant-answer GET');
    assert.ok(stages.includes('http-start') && stages.includes('http-done') && stages.includes('parse-done'), 'stages recorded');
    assert.ok(stages.includes('deliver'), 'real results delivered');
    assert.ok(delivered > 1, 'fallback + real results delivered: ' + delivered);
});

test('AGENT path: empty HTML -> fallback only, finishes (no crash, no retry)', () => {
    const httpPosts = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        httpPost: (u, b, c, cb) => { httpPosts.push(u); cb(null, '<html><body>no results</body></html>'); }
    });
    let delivered = 0;
    wp.search('cari berita emas hari ini', null, list => { delivered = (list || []).length; }, { agent: true });
    assert.equal(httpPosts.length, 1, 'still a single request');
    assert.equal(delivered, 1, 'only the instant fallback (no upgrade)');
});

test('SEARCH mode unchanged: uses instant-answer GET, NOT HTML POST', () => {
    const httpPosts = [], httpGets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        httpPost: (u, b, c, cb) => { httpPosts.push(u); },
        httpGet: (u, c, cb) => { httpGets.push(u); cb(null, '{}'); }
    });
    wp.search('bmri', null, () => {}, undefined); // no opts.agent => SEARCH mode
    assert.equal(httpGets.length, 1, 'SEARCH mode uses instant-answer GET');
    assert.equal(httpPosts.length, 0, 'SEARCH mode never touches the HTML POST path');
});

test('AGENT chain (tool + manager): real fixture -> tool finishes immediately, not at grace', async () => {
    const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
    const { createDefaultTools } = require('../providers/tools/index.js');
    const { createAgentManager } = require('../providers/agentManager.js');
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        httpPost: (u, b, c, cb) => cb(null, FIXTURE)
    });
    const deps = {
        tryCalculate: () => null, detectUrl: () => null, openPath: () => true, openUri: () => true,
        fileProvider: { search: (q, c, cb) => cb([]) }, webProvider: wp,
        appProvider: { searchApps: q => [], getApp: () => ({ launch() {} }) },
        screenCapture: { capture: (cb) => cb(null, { image: 'data:image/png;base64,iVBORw0KGgo=' }) },
        computerControl: { typeText: (t, c, cb) => cb(null, { typed: t }) },
        timers: { after: (ms, fn) => setTimeout(fn, ms), clear: () => {} },
        LIMITS: Object.assign({}, LIMITS, { agentWebGraceMs: 1200 }),
        validators: { validatePoint: () => null, validateKey: () => null, sanitizeText: s => s, validateScroll: () => ({ direction: 'up', amount: 1 }) }
    };
    const reg = createToolRegistry();
    for (const t of createDefaultTools(deps)) reg.register(t);
    const calls = [];
    const aiAsk = (q, ctx, cb) => {
        const hasTools = !!(ctx.tools && ctx.tools.length);
        calls.push({ hasTools });
        if (hasTools) {
            if (calls.filter(c => c.hasTools).length === 1) cb(null, { toolCalls: [{ id: 't1', name: 'search_web', argsJson: JSON.stringify({ query: q }) }] });
            else cb(null, { answer: 'final' });
        } else cb(null, { answer: 'final' });
    };
    const agent = createAgentManager({ aiAsk, registry: reg, routeToAgent: () => true, limits: { agentWebGraceMs: 1200 } });
    const t0 = Date.now();
    await new Promise(res => agent.run('cari berita BMRI hari ini', { messages: [{ role: 'user', content: 'cari berita BMRI hari ini' }] }, () => res()));
    const dt = Date.now() - t0;
    assert.ok(dt < 200, 'tool finished on real results, NOT at the 1200ms grace: ' + dt + 'ms');
    assert.equal(calls.length, 2, 'tool round + final-answer round');
});
