// Source content expansion hardening — regression tests.
// P1-1 full-intent detection + multi-window coverage, P1-2 unified budget,
// P1-3 real abort (timeout/cancel), P1-4 URL safety, P2-1 diagnostics fields,
// P2-2 extraction quality fallback, P2-3 list structure preservation.
const { test } = require('node:test');
const assert = require('node:assert');
const {
    extractMainText,
    extractMainTextLoose,
    selectRelevantWindow,
    buildFullContentWindows,
    isFullContentIntent
} = require('../ai/htmlTextExtractor.js');
const {
    createSourceContentExpander,
    selectSourcesForExpansion,
    isSafeFetchUrl
} = require('../ai/sourceContentExpander.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

// ── P1-1 intent detection ─────────────────────────────────────────────────────
test('isFullContentIntent: completeness queries detected', () => {
    assert.strictEqual(isFullContentIntent('tulis semua pemain Chelsea'), true);
    assert.strictEqual(isFullContentIntent('skuad lengkap chelsea 2026/2027'), true);
    assert.strictEqual(isFullContentIntent('daftar seluruh pemain'), true);
    assert.strictEqual(isFullContentIntent('full squad list'), true);
    assert.strictEqual(isFullContentIntent('siapa striker Chelsea'), false);
    assert.strictEqual(isFullContentIntent('berapa harga BMRI hari ini'), false);
    assert.strictEqual(isFullContentIntent('jadwal chelsea minggu ini'), false);
});

// ── P2-3 list structure ───────────────────────────────────────────────────────
test('extractMainText: heading + list structure preserved as separate lines', () => {
    const htmlStr = '<html><body><h2>Kiper</h2><ul><li>Player A</li><li>Player B</li></ul>' +
        '<h2>Bek</h2><ul><li>Player C</li><li>Player D</li></ul></body></html>';
    const t = extractMainText(htmlStr);
    const lines = t.split('\n').map(l => l.trim());
    assert.ok(lines.includes('Kiper'), 'heading Kiper kept');
    assert.ok(lines.includes('Bek'), 'heading Bek kept');
    assert.ok(lines.includes('- Player A'), 'list item A on its own bullet line');
    assert.ok(lines.includes('- Player C'), 'list item C on its own bullet line');
    assert.ok(!lines.some(l => /Player [ABCD].*Player [ABCD]/.test(l)), 'items not merged into one paragraph');
});

// ── P1-1 single window vs multi-window coverage ───────────────────────────────
function coverageText() {
    const lines = [];
    lines.push('HEADMARKER ' + 'a'.repeat(180));
    lines.push('par ' + 'b'.repeat(180));
    lines.push('par ' + 'c'.repeat(180));
    lines.push('par ' + 'd'.repeat(180));
    lines.push('SKUAD data pemain lengkap di sini');
    lines.push('par ' + 'e'.repeat(180));
    lines.push('par ' + 'f'.repeat(180));
    lines.push('par ' + 'g'.repeat(180));
    lines.push('par ' + 'h'.repeat(180));
    lines.push('TAILMARKER ' + 'z'.repeat(180));
    return lines.join('\n');
}

test('full-intent multi-window covers head+matched+tail; single window does not', () => {
    const text = coverageText();
    const multi = buildFullContentWindows(text, 'data skuad', 420);
    const single = selectRelevantWindow(text, 'data skuad', 420);
    assert.ok(multi.includes('SKUAD data pemain'), 'multi covers the matched area');
    assert.ok(multi.includes('TAILMARKER'), 'multi reaches the tail');
    assert.ok(multi.includes('HEADMARKER'), 'multi keeps the head');
    assert.ok(multi.length <= 430, 'multi bounded');
    assert.ok(single.includes('SKUAD data pemain'), 'single covers the match');
    assert.ok(!single.includes('TAILMARKER'), 'single window does not reach the tail');
});

// ── P1-1/P1-2 expander: full intent widens coverage within per-source budget ──
function squadText() {
    const out = [];
    out.push('SEKSI-A intro paragraph ' + 'x'.repeat(60));
    out.push('- Kiper A1');
    out.push('- Kiper A2');
    out.push('SEKSI-B paragraph ' + 'y'.repeat(60));
    out.push('- Bek B1');
    out.push('- Bek B2');
    out.push('- Bek B3');
    out.push('SEKSI-C paragraph skuad lengkap chelsea ' + 'm'.repeat(40));
    out.push('- Gelandang C1');
    out.push('- Gelandang C2');
    out.push('- Gelandang C3');
    out.push('SEKSI-D paragraph ' + 'n'.repeat(60));
    out.push('- Penyerang D1');
    out.push('- Penyerang D2');
    return out.join('\n');
}

test('expander full intent: multi-window coverage reaches 3+ sections within budget', async () => {
    const htmlStr = '<html><body><main>' + squadText().split('\n').map(l => '<p>' + l + '</p>').join('') + '</main></body></html>';
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, htmlStr, { status: 200, contentType: 'text/html' }),
        perSourceChars: 300,
        maxSources: 2
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'tulis semua pemain chelsea', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'sn' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    assert.ok(ev, 'evidence');
    assert.strictEqual(ev.evidenceType, 'page_content');
    assert.ok(ev.content.length <= 310, 'per-source budget respected: ' + ev.content.length);
    const sections = ['SEKSI-A', 'SEKSI-B', 'SEKSI-C', 'SEKSI-D'].filter(s => ev.content.includes(s));
    assert.ok(sections.length >= 3, 'multi-window coverage across sections, got: ' + sections.join(','));
});

test('expander normal query: single relevant window, still bounded', async () => {
    const htmlStr = '<html><body><main>' + squadText().split('\n').map(l => '<p>' + l + '</p>').join('') + '</main></body></html>';
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, htmlStr, { status: 200, contentType: 'text/html' }),
        perSourceChars: 300
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'siapa striker chelsea', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'sn' }] }, (e, r) => resolve(r));
    });
    assert.ok(res.stats.fullContentIntent === false, 'normal query not full intent');
    const ev = res.evidence[0];
    assert.ok(ev.content.length <= 310, 'bounded');
});

// ── P1-2 unified global budget ────────────────────────────────────────────────
test('unified budget: page_content + snippet_fallback share one cap (invariant)', async () => {
    const bigMain = '<p>' + ('real content words here '.repeat(600)) + '</p>'; // page content > any window
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => {
            if (url.indexOf('page') !== -1) cb(null, '<html><body>' + bigMain + '</body></html>', { status: 200, contentType: 'text/html' });
            else { const e = new Error('HTTP 500'); e.status = 500; cb(e, '', { status: 500, contentType: 'text/html' }); }
        },
        perSourceChars: 400,
        totalBudgetChars: 500
    });
    const res = await new Promise((resolve) => {
        expander.expand({
            query: 'q',
            sources: [
                { title: 'page', url: 'https://page.example.com/', snippet: 'ps' },
                { title: 'fallback', url: 'https://fallback.example.com/', snippet: 'snippet fallback text that is long enough to matter' }
            ]
        }, (e, r) => resolve(r));
    });
    const used = res.evidence.reduce((n, ev) => n + ev.content.length, 0);
    assert.ok(used <= 500, 'invariant sum <= budget: ' + used);
    assert.strictEqual(res.evidence[0].evidenceType, 'page_content');
    assert.strictEqual(res.evidence[1].evidenceType, 'snippet_fallback');
    assert.ok(res.evidence[1].content.length > 0, 'fallback still present within budget');
    assert.strictEqual(res.stats.totalChars, used);
});

// ── P1-4 URL safety ───────────────────────────────────────────────────────────
test('isSafeFetchUrl blocks localhost/private/loopback/special schemes', () => {
    const blocked = [
        'http://localhost/', 'http://localhost:8080/x', 'https://foo.localhost/',
        'http://127.0.0.1/', 'http://127.0.0.1:8080/status', 'http://10.0.0.5/x',
        'http://192.168.1.1/', 'http://172.16.0.1/', 'http://172.31.255.255/',
        'http://0.0.0.0/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/',
        'http://[fe80::1]/', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)',
        'ftp://example.com/', 'http://evil.local/x'
    ];
    for (const u of blocked) assert.strictEqual(isSafeFetchUrl(u), false, 'should block: ' + u);
    const allowed = ['https://example.com/', 'http://example.com/a?b=1', 'https://www.google.com/search?q=x', 'https://sub.example.co.uk/path', 'https://172.32.0.1/x', 'https://example.com:8443/x'];
    for (const u of allowed) assert.strictEqual(isSafeFetchUrl(u), true, 'should allow: ' + u);
});

test('selection + expander never fetch unsafe urls', async () => {
    let fetches = 0;
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => { fetches++; cb(null, '<html><body><p>real page content with enough text to matter for extraction here</p></body></html>', { status: 200, contentType: 'text/html' }); }
    });
    const unsafe = { title: 'local', url: 'http://127.0.0.1/admin', snippet: 'local snip' };
    const sel = selectSourcesForExpansion([unsafe], 3);
    assert.strictEqual(sel.length, 0, 'unsafe filtered from selection');
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [unsafe] }, (e, r) => resolve(r));
    });
    assert.strictEqual(fetches, 0, 'never fetched');
    assert.strictEqual(res.evidence.length, 0);
    assert.strictEqual(res.stats.selected, 0);
});

test('redirect to private url: content discarded, snippet fallback used', async () => {
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, '<html><body><p>evil but fetched body with lots of content here</p></body></html>', { status: 200, contentType: 'text/html', finalUrl: 'http://127.0.0.1/internal' })
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://public.example.com/', snippet: 'public snippet text' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    assert.strictEqual(ev.evidenceType, 'snippet_fallback');
    assert.strictEqual(ev.fetchStatus, 'blocked');
    assert.strictEqual(ev.fetchError, 'redirect to unsafe url');
    assert.strictEqual(ev.content, 'public snippet text');
});

// ── P1-3 real abort on timeout ────────────────────────────────────────────────
test('timeout really aborts the in-flight fetch (AbortController)', async () => {
    const origFetch = global.fetch;
    let aborted = false;
    global.fetch = (url, init) => new Promise((resolve, reject) => {
        const sig = init && init.signal;
        if (sig) sig.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('AbortError');
            e.name = 'AbortError';
            reject(e);
        });
        // never resolves on its own — only abort can settle it
    });
    try {
        const expander = createSourceContentExpander({ timeoutMs: 40, maxSources: 1 });
        const res = await new Promise((resolve) => {
            expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'snip' }] }, (e, r) => resolve(r));
        });
        assert.strictEqual(aborted, true, 'fetch aborted on timeout');
        const ev = res.evidence[0];
        assert.strictEqual(ev.evidenceType, 'snippet_fallback');
        assert.strictEqual(ev.fetchStatus, 'failed');
        assert.strictEqual(ev.fetchError, 'timeout');
    } finally {
        global.fetch = origFetch;
    }
});

test('external cancel really aborts the in-flight fetch', async () => {
    const origFetch = global.fetch;
    let aborted = false;
    let called = false;
    global.fetch = (url, init) => new Promise((resolve, reject) => {
        const sig = init && init.signal;
        if (sig) sig.addEventListener('abort', () => {
            aborted = true;
            const e = new Error('AbortError');
            e.name = 'AbortError';
            reject(e);
        });
    });
    try {
        const expander = createSourceContentExpander({ timeoutMs: 5000, cancelPollMs: 15, maxSources: 1 });
        const cancellable = { is_cancelled: () => false };
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'snip' }], cancellable }, () => { called = true; });
        await new Promise(r => setTimeout(r, 40));
        cancellable.is_cancelled = () => true; // user/engine cancel while fetch is running
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(aborted, true, 'fetch aborted on external cancel');
        assert.strictEqual(called, false, 'no completion callback after cancel');
    } finally {
        global.fetch = origFetch;
    }
});

// ── P2-1 diagnostics fields on evidence ───────────────────────────────────────
test('evidence carries per-source diagnostics (http/raw/extracted/final)', async () => {
    const body = '<html><body><p>full page body with quite enough characters to exceed the minimum extraction length threshold here</p><ul><li>Item one</li><li>Item two</li></ul></body></html>';
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, body, { status: 200, contentType: 'text/html' })
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'sn' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    assert.strictEqual(ev.httpStatus, 200);
    assert.ok(ev.rawHtmlChars === body.length, 'raw html chars recorded');
    assert.ok(typeof ev.extractedChars === 'number' && ev.extractedChars > 0, 'extracted chars recorded');
    assert.strictEqual(ev.charCount, ev.content.length);
});

// ── P2-2 extraction quality fallback ──────────────────────────────────────────
test('big page + near-empty strict extraction -> loose fallback succeeds', async () => {
    const script = '<script>' + 'var x=1;'.repeat(4000) + '</script>'; // big raw
    const noise = '<div>Home | News | Login | Subscribe | Cookie Policy | Privacy Policy</div>';
    const realLine = '<p>Artikel lengkap skuad: subscribe newsletter kami untuk info terkini dan baca lebih lanjut di halaman ini tentang semua pemain.</p>';
    const htmlStr = '<html><head><title>t</title><style>' + 'a{}'.repeat(2000) + '</style></head><body>' + script + noise + realLine + '</body></html>';
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, htmlStr, { status: 200, contentType: 'text/html' })
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'sn' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    // strict would drop the only real line (it contains noise words); loose keeps it
    assert.strictEqual(ev.evidenceType, 'page_content', 'loose extraction recovered content');
    assert.strictEqual(ev.extractionFallback, true);
    assert.ok(ev.content.includes('Artikel lengkap skuad'), 'real content kept by loose pass');
});

test('big page + tiny real content: snippet fallback even after loose retry', async () => {
    const script = '<script>' + 'var x=1;'.repeat(5000) + '</script>';
    const htmlStr = '<html><head><title>t</title></head><body>' + script + '<p>hanya sedikit</p></body></html>';
    const expander = createSourceContentExpander({
        httpGet: (url, cancellable, cb) => cb(null, htmlStr, { status: 200, contentType: 'text/html' })
    });
    const res = await new Promise((resolve) => {
        expander.expand({ query: 'q', sources: [{ title: 't', url: 'https://a.example.com/', snippet: 'the snippet fallback' }] }, (e, r) => resolve(r));
    });
    const ev = res.evidence[0];
    assert.strictEqual(ev.evidenceType, 'snippet_fallback');
    assert.strictEqual(ev.content, 'the snippet fallback');
});

// ── engine integration: full-intent + debug flag do not disturb the answer path ─
test('engine grounded with expander + debug flag still answers (diag fields tolerated)', async () => {
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } });
            cb(null, { type: 'answer', text: 'Ini daftarnya.' });
        }
    });
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'T', url: 'https://example.com/t', snippet: 's' }])
    });
    const expander = {
        expand(req, cb) {
            cb(null, {
                evidence: [{ title: 'T', url: 'https://example.com/t', evidenceType: 'page_content', content: 'full list of players here', fetchStatus: 'ok', httpStatus: 200, rawHtmlChars: 1000, extractedChars: 100, charCount: 100 }],
                stats: { total: 1, selected: 1, pageContent: 1, snippetFallback: 0, fetchFailed: 0, totalChars: 100, budgetChars: 16000, budgetPercent: 1 }
            });
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true, sourceContentExpander: expander, debug: true });
    const got = await new Promise((resolve) => {
        engine.search('skuad chelsea', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got && got.text === 'Ini daftarnya.', 'answer delivered with debug diagnostics on');
    assert.strictEqual(got.sources.length, 1, 'sources intact');
});
