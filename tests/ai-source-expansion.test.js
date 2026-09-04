// AI source content expansion phase — full page context regression tests.
// P2 selection, P3/P4 fetch+extraction, P5 query-aware window, P6 budget, P7 snippet fallback,
// P8 expanded context format, P11 failure safety, P12 concurrency/cancel, acceptance tests 1-5.
const { test } = require('node:test');
const assert = require('node:assert');
const { extractMainText, selectRelevantWindow, queryTokens } = require('../ai/htmlTextExtractor.js');
const { createSourceContentExpander, selectSourcesForExpansion } = require('../ai/sourceContentExpander.js');
const { buildExpandedGroundingContext } = require('../ai/promptBuilder.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider, createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

function html(articleBody) {
    return '<!doctype html><html><head><title>T</title><script>var x=1;</script><style>.a{}</style></head><body>' +
        '<nav><a>Home</a><a>News</a><a>Login</a><a>Subscribe</a></nav>' +
        '<header><h1>' + articleBody.title + '</h1></header>' +
        '<main>' + articleBody.main + '</main>' +
        '<aside>Related articles: other stuff</aside>' +
        '<footer>Cookie Policy | Privacy | All rights reserved</footer>' +
        '</body></html>';
}

// ── P4/P5 extractor ─────────────────────────────────────────────────────────────
test('extractMainText: strips scripts/styles, keeps headings/lists, drops nav/cookie noise', () => {
    const h = html({
        title: 'Chelsea Squad 2026/2027',
        main: '<p>Chelsea memiliki skuad berikut.</p><h2>Kiper</h2><ul><li>Player A</li><li>Player B</li></ul><p>Advertisement &amp; banner here</p><div>Home | News | Login | Subscribe | Cookie Policy</div><p>Bek: Player C</p>'
    });
    const t = extractMainText(h);
    assert.ok(t.includes('Chelsea Squad 2026/2027'), 'heading kept');
    assert.ok(t.includes('Kiper'), 'sub heading kept');
    assert.ok(t.includes('Player A') && t.includes('Player B'), 'list items kept');
    assert.ok(t.includes('Bek: Player C'), 'paragraph kept');
    assert.ok(!t.includes('Advertisement'), 'ad noise dropped');
    assert.ok(!t.includes('var x=1') && !t.includes('.a{'), 'script/style dropped');
    assert.ok(!/Home\s*\|\s*News/i.test(t), 'nav pipe row dropped');
    assert.ok(!t.includes('Cookie Policy') || !t.includes('All rights reserved'), 'footer noise dropped');
});

test('extractMainText: entities decoded and empty/duplicate lines removed', () => {
    const h = '<p>Harga Rp4.450 &amp; naik 4% &#8212; 2026</p><p>Harga Rp4.450 &amp; naik 4% &#8212; 2026</p><p></p><p></p>';
    const t = extractMainText(h);
    assert.ok(t.includes('Rp4.450 & naik 4%'), 'entities decoded');
    assert.strictEqual((t.match(/Rp4\.450/g) || []).length, 1, 'duplicate paragraph removed');
});

// ── P5 query-aware window ───────────────────────────────────────────────────────
test('selectRelevantWindow: keeps the region matching the query instead of blind prefix', () => {
    const lines = ['intro line ' + 'x '.repeat(60), 'middle filler ' + 'y '.repeat(60), 'squad list: Player A, Player B, Chelsea defenders', 'tail ' + 'z '.repeat(60)];
    const text = lines.join('\n');
    const win = selectRelevantWindow(text, 'tulis semua pemain chelsea', 120);
    assert.ok(win.includes('Player A'), 'window covers the query-matched list');
    assert.ok(win.length <= 130, 'window bounded ~' + win.length);
});

test('selectRelevantWindow: no query signal falls back to content head; short text untouched', () => {
    const text = 'aaa bbb\nccc ddd\n';
    assert.strictEqual(selectRelevantWindow(text, '', 100), text);
    assert.strictEqual(selectRelevantWindow(text, 'zzzqqq', 100), text);
});

// ── P2 selection ────────────────────────────────────────────────────────────────
test('selectSourcesForExpansion: rank order + domain diversity + cap', () => {
    const mk = (n, d) => ({ title: 'R' + n, url: 'https://' + d + '.example.com/page' + n, snippet: 's' + n });
    const sources = [mk(1, 'a'), mk(2, 'a'), mk(3, 'a'), mk(4, 'b'), mk(5, 'c'), mk(6, 'd')];
    const sel = selectSourcesForExpansion(sources, 4);
    assert.strictEqual(sel.length, 4, 'capped at 4');
    const domains = sel.map(s => s.domain);
    assert.strictEqual(domains.filter(d => d === 'a.example.com').length, 2, 'same-domain limited to 2');
    assert.strictEqual(sel[0].url, 'https://a.example.com/page1', 'ranking order kept');
});

// ── P7/P11 expander failure safety + full page content ────────────────────────
function fakeHttpGet(fn) {
    return (url, cancellable, cb, timeoutMs) => { try { fn(url, cb, timeoutMs); } catch (e) { cb(e); } };
}

test('expander: fetch success -> page_content evidence with extracted content', async () => {
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => {
            cb(null, html({ title: 'Chelsea', main: '<p>Ini daftar lengkap pemain Chelsea musim 2026/2027 yang baru saja diumumkan klub.</p><h2>Kiper</h2><ul><li>Player A</li><li>Player B</li></ul><p>Bek, gelandang, dan penyerang lengkap juga tersedia di halaman berikutnya halaman ini.</p>' }), { status: 200, contentType: 'text/html' });
        })
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'pemain chelsea', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'snip' }] }, (e, r) => resolve(r));
    });
    assert.ok(res, 'result');
    assert.strictEqual(res.evidence.length, 1);
    assert.strictEqual(res.evidence[0].evidenceType, 'page_content');
    assert.ok(res.evidence[0].content.includes('Player A'), 'full page content used');
    assert.ok(res.evidence[0].content.length >= 160, 'main content minimum');
    assert.strictEqual(res.stats.pageContent, 1);
    assert.strictEqual(res.stats.snippetFallback, 0);
});

test('expander: one fetch fails -> snippet fallback for that source, others unaffected', async () => {
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => {
            if (url.indexOf('good') !== -1) {
                cb(null, html({ title: 'Good page', main: '<p>Good page content with real data about the chelsea squad for season 2026/2027 published by the club itself.</p><p>More details here including the full roster of players and their positions.</p>' }), { status: 200, contentType: 'text/html' });
            } else {
                const e = new Error('HTTP 404');
                e.status = 404;
                cb(e, '', { status: 404, contentType: 'text/html' });
            }
        })
    });
    const res = await new Promise((resolve) => {
        expander.expand({
            query: 'chelsea',
            sources: [
                { title: 'bad', url: 'https://bad.example.com/', snippet: 'snippet fallback text for the bad source' },
                { title: 'good', url: 'https://good.example.com/', snippet: 'snip good' }
            ]
        }, (e, r) => resolve(r));
    });
    const byType = {};
    for (const ev of res.evidence) byType[ev.evidenceType] = (byType[ev.evidenceType] || 0) + 1;
    assert.strictEqual(byType['page_content'], 1);
    assert.strictEqual(byType['snippet_fallback'], 1);
    const fb = res.evidence.find(ev => ev.evidenceType === 'snippet_fallback');
    assert.strictEqual(fb.content, 'snippet fallback text for the bad source', 'snippet fallback used');
    assert.strictEqual(fb.fetchStatus, 'failed');
    assert.strictEqual(res.stats.fetchFailed, 1);
});

test('expander: ALL fetches fail -> snippet fallback, no crash, still answers (acceptance 4)', async () => {
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => { const e = new Error('timeout'); e.code = 'timeout'; cb(e); })
    });
    const res = await new Promise((resolve) => {
        expander.expand({
            query: 'q',
            sources: [
                { title: 'a', url: 'https://a.example.com/', snippet: 'snip a' },
                { title: 'b', url: 'https://b.example.com/', snippet: 'snip b' }
            ]
        }, (e, r) => resolve(r));
    });
    assert.ok(res && Array.isArray(res.evidence) && res.evidence.length === 2, 'evidence still present');
    assert.ok(res.evidence.every(ev => ev.evidenceType === 'snippet_fallback'), 'all snippet fallback');
});

test('expander: extraction empty -> snippet fallback with fetchStatus empty', async () => {
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => cb(null, '<html><body><script>1</script></body></html>', { status: 200, contentType: 'text/html' }))
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'the snippet' }] }, (e, r) => resolve(r));
    });
    assert.strictEqual(res.evidence[0].evidenceType, 'snippet_fallback');
    assert.strictEqual(res.evidence[0].content, 'the snippet');
});

// ── P6 budget + P5 window under per-source cap ─────────────────────────────────
test('expander: per-source budget keeps query-relevant region of a long page', async () => {
    const longBody = '<p>Start ' + 'x'.repeat(400) + '</p><p>SKUAD LENGKAP: Player A, Player B, Player C, Player D</p><p>End ' + 'y'.repeat(400) + '</p>';
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => cb(null, html({ title: 'T', main: longBody }), { status: 200, contentType: 'text/html' })),
        perSourceChars: 200
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'skuad lengkap', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 's' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    assert.ok(ev.content.length <= 210, 'bounded by perSourceChars');
    assert.ok(ev.content.includes('Player A'), 'query-relevant list kept');
});

test('expander: global total budget caps later sources', async () => {
    const expander = createSourceContentExpander({
        httpGet: fakeHttpGet((url, cb) => cb(null, html({ title: 'T', main: '<p>' + 'content '.repeat(300) + '</p>' }), { status: 200, contentType: 'text/html' })),
        totalBudgetChars: 500,
        maxSources: 3
    });
    const sources = [
        { title: 'a', url: 'https://a.example.com/', snippet: 'sa' },
        { title: 'b', url: 'https://b.example.com/', snippet: 'sb' },
        { title: 'c', url: 'https://c.example.com/', snippet: 'sc' }
    ];
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources }, (e, r) => resolve(r));
    });
    const used = res.evidence.reduce((n, ev) => n + ev.content.length, 0);
    assert.ok(used <= 500, 'total budget respected: ' + used);
});

// ── P12 concurrency limit + cancellation ───────────────────────────────────────
test('expander: maxConcurrent respected (acceptance 5/rapid + load)', async () => {
    const inflight = [];
    let maxActive = 0;
    const pending = [];
    const httpGet = (url, cancellable, cb) => {
        inflight.push({ url, cb });
        maxActive = Math.max(maxActive, inflight.length);
    };
    const expander = createSourceContentExpander({ httpGet, maxConcurrent: 3, maxSources: 4, timeoutMs: 5000 });
    const sources = [1, 2, 3, 4].map(i => ({ title: 's' + i, url: 'https://' + i + '.example.com/', snippet: 'sn' + i }));
    let res = null;
    expander.expand({ query: 'q', sources }, (e, r) => { res = r; });
    assert.strictEqual(inflight.length, 3, 'starts only 3 of 4');
    assert.ok(maxActive <= 3, 'never exceeds concurrency');
    // release 2 -> third starts; release rest -> completes
    inflight.splice(0, 3).forEach(p => p.cb(null, html({ title: 'T', main: '<p>ok content here with data</p>' }), { status: 200, contentType: 'text/html' }));
    assert.strictEqual(inflight.length, 1, 'fourth starts after a slot frees');
    inflight.splice(0, 1).forEach(p => p.cb(null, html({ title: 'T', main: '<p>more ok content here</p>' }), { status: 200, contentType: 'text/html' }));
    assert.ok(res && res.evidence.length === 4, 'all sources expanded');
});

test('expander: cancelled before completion -> cb never invoked', async () => {
    const held = [];
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => { held.push(cb); },
        maxSources: 2
    });
    let called = false;
    const cancellable = { is_cancelled: () => false, cancel() {} };
    expander.expand({ query: 'q', sources: [{ title: 'a', url: 'https://a.example.com/', snippet: 's' }], cancellable }, () => { called = true; });
    cancellable.is_cancelled = () => true;
    held.forEach(cb => cb(null, html({ title: 'T', main: '<p>late content here</p>' }), { status: 200, contentType: 'text/html' }));
    assert.strictEqual(called, false, 'no callback after cancel');
});

// ── P8 expanded context format ─────────────────────────────────────────────────
test('buildExpandedGroundingContext: typed evidence + instruction; empty -> ""', () => {
    const ctx = buildExpandedGroundingContext([
        { title: 'Page', url: 'https://a.example.com/', evidenceType: 'page_content', content: 'FULL LIST HERE' },
        { title: 'SnippetOnly', url: 'https://b.example.com/', evidenceType: 'snippet_fallback', content: 'short snippet' }
    ], 'tulis semua pemain');
    assert.ok(ctx.includes('FULL PAGE CONTENT'), 'page content typed');
    assert.ok(ctx.includes('SNIPPET FALLBACK'), 'snippet typed');
    assert.ok(ctx.includes('FULL LIST HERE'), 'content embedded');
    assert.ok(ctx.includes('URL: https://a.example.com/'), 'url embedded');
    assert.ok(ctx.includes('USER QUESTION: tulis semua pemain'), 'user question echoed');
    assert.ok(ctx.includes('INSTRUCTION'), 'instruction present');
    assert.ok(ctx.includes('did not fit in the snippet'), 'no-snippet-excuse rule present');
    assert.strictEqual(buildExpandedGroundingContext([], 'q'), '');
    assert.strictEqual(buildExpandedGroundingContext(null, 'q'), '');
});

// ── engine integration: expanded context reaches the grounded second leg ──────
function makeExpanderEvidence(evidence) {
    return {
        expand(req, cb) { setImmediate(() => cb(null, { evidence, stats: { total: 2, selected: 2, fetchedOk: 1, fetchFailed: 1, pageContent: 1, snippetFallback: 1, totalChars: 100, budgetChars: 16000, budgetPercent: 1 } })); }
    };
}

test('engine non-streaming: grounded leg uses expanded page content, sources intact', async () => {
    const seen = [];
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            seen.push(req);
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'harga bmri' } });
            cb(null, { type: 'answer', text: 'Harga BMRI sekitar Rp4.450 [1].' });
        }
    });
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'Berita', url: 'https://example.com/berita', snippet: 'snip' }])
    });
    const expander = makeExpanderEvidence([
        { title: 'Berita', url: 'https://example.com/berita', evidenceType: 'page_content', content: 'Harga saham BMRI hari ini berada di sekitar Rp4.450 dengan volume tinggi.' }
    ]);
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true, sourceContentExpander: expander });
    const got = await new Promise((resolve) => {
        engine.search('harga bmri', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got, 'grounded answer delivered');
    const second = seen.find(r => r.groundingContext);
    assert.ok(second, 'second leg ran');
    assert.ok(second.groundingContext.includes('Harga saham BMRI hari ini berada di sekitar Rp4.450'), 'expanded content in prompt');
    assert.ok(second.groundingContext.includes('FULL PAGE CONTENT'), 'typed evidence');
    assert.ok(got.sources.length === 1, 'sources metadata intact');
    assert.strictEqual(got.text, 'Harga BMRI sekitar Rp4.450.', 'citation cleaned as before');
});

test('engine streaming tool_call: expanded context reaches grounded stream', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            if (!payload.groundingContext) {
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'skuad chelsea' } });
                return;
            }
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'Berikut skuad lengkapnya.' });
            onEvent({ type: 'complete', result: { text: 'Berikut skuad lengkapnya.', sources: [], grounded: false } });
        }
    });
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'Chelsea', url: 'https://example.com/chelsea', snippet: 'snip' }])
    });
    const expander = makeExpanderEvidence([
        { title: 'Chelsea', url: 'https://example.com/chelsea', evidenceType: 'page_content', content: 'SKUAD LENGKAP: Player A, Player B, Player C, Player D, Player E, Player F.' }
    ]);
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true, sourceContentExpander: expander });
    const got = await new Promise((resolve) => {
        engine.searchStream('skuad chelsea', null, {
            onComplete: d => resolve(d),
            onError: () => resolve(null)
        });
    });
    assert.ok(got, 'streaming complete');
    const grounded = payloads.find(p => p.groundingContext);
    assert.ok(grounded, 'grounded payload');
    assert.ok(grounded.groundingContext.includes('Player A') && grounded.groundingContext.includes('Player F'), 'full list content in context');
    assert.ok(got.sources.length === 1, 'sources intact');
});

test('engine: stale expansion result after cancel never starts second leg (acceptance 5)', async () => {
    let expandCb = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            calls++;
            cb(null, { type: 'answer', text: 'late grounded' });
        }
    });
    let calls = 0;
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'T', url: 'https://example.com/t', snippet: 's' }])
    });
    const expander = {
        expand(req, cb) { expandCb = () => cb(null, { evidence: [{ title: 'T', url: 'https://example.com/t', evidenceType: 'page_content', content: 'stale page content long enough 1234567890' }], stats: {} }); }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true, sourceContentExpander: expander });
    let delivered = false;
    engine.search('x', { onAnswer: () => { delivered = true; }, onError: () => {} });
    engine.cancel();
    assert.ok(expandCb, 'expansion started');
    expandCb();
    assert.strictEqual(calls, 0, 'second leg never started after cancel');
    assert.strictEqual(delivered, false, 'no stale answer delivered');
});

test('engine: expander crash/throw falls back to snippet grounding', async () => {
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            cb(null, { type: 'answer', text: 'ok answer' });
        }
    });
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'T', url: 'https://example.com/t', snippet: 'snippet text' }])
    });
    const engine = createAISearchEngine({
        provider, webSearchTool: webTool, enableGrounding: true,
        sourceContentExpander: { expand() { throw new Error('boom'); } }
    });
    const got = await new Promise((resolve) => {
        engine.search('harga terbaru', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got && got.text === 'ok answer', 'answer still delivered on expander failure');
});

// queryTokens sanity used by window tests
test('queryTokens: tokenizes and skips stopwords', () => {
    const toks = queryTokens('tulis semua pemain chelsea 2026/2027');
    assert.ok(toks.includes('tulis') && toks.includes('pemain') && toks.includes('chelsea'));
    assert.ok(!toks.includes('semua'), 'stopword skipped');
});
