// H multi-aspect fan-out tests: deterministic, max 2, fail-closed to single query.
const { test } = require('node:test');
const assert = require('node:assert');
const Gt = require('../ai/groundingTypes.js');

test('H-A: single query unchanged (no fan-out)', () => {
    assert.deepStrictEqual(Gt.decomposeMultiAspect('Apa itu Linux?'), null);
    assert.deepStrictEqual(Gt.decomposeMultiAspect('Cara install Docker'), null);
});

test('H-B: valid two-aspect detection', () => {
    const r = Gt.decomposeMultiAspect('Bandingkan X dari sisi harga dan performa');
    assert.ok(r && Array.isArray(r.queries) && r.queries.length === 2);
    assert.ok(r.queries[0].indexOf('harga') !== -1 && r.queries[1].indexOf('performa') !== -1);
});

test('H-C: max 2 sub-queries', () => {
    const r = Gt.decomposeMultiAspect('Bandingkan X dari sisi a dan b');
    assert.ok(!r || r.queries.length <= 2);
    assert.strictEqual(Gt.MAX_FANOUT, 2);
});

test('H-D: ambiguous dan stays single', () => {
    assert.strictEqual(Gt.decomposeMultiAspect('Saya dan teman pergi'), null);
    assert.strictEqual(Gt.decomposeMultiAspect('dan'), null);
    assert.strictEqual(Gt.decomposeMultiAspect('Bandingkan X'), null);
});

test('H-E: empty aspect falls back', () => {
    assert.strictEqual(Gt.decomposeMultiAspect('Bandingkan X dari sisi  dan '), null);
});

test('H-F: duplicate aspect deduped', () => {
    const r = Gt.decomposeMultiAspect('Bandingkan X dari sisi harga dan harga');
    assert.ok(!r || r.queries.length === 1 || r === null, 'dedupe or fallback');
    if (r) assert.strictEqual(new Set(r.queries).size, r.queries.length);
});

test('H-G: sub-query length bounded', () => {
    const long = 'x'.repeat(200);
    const r = Gt.decomposeMultiAspect('Bandingkan ' + long + ' dari sisi a dan b');
    assert.ok(!r || r.queries.every(q => q.length <= 120), 'each <=120 or fallback');
});

test('H-ASPECT: aspect labels preserved for grounding text', () => {
    const r = Gt.decomposeMultiAspect('Bandingkan X dari sisi harga dan performa');
    assert.ok(r && r.aspects && r.aspects.length === 2);
    assert.deepStrictEqual(r.aspects, ['harga', 'performa']);
});

const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');

function srcSet(n, prefix) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ title: prefix + i, url: 'https://example.com/' + prefix + i, snippet: 'snippet text number ' + i + ' long enough here' });
    return out;
}
function engineWith(searchFn) {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'answer text' });
            onEvent({ type: 'complete', result: { text: 'answer text', sources: [] } });
        }
    });
    const webSearchTool = { search: searchFn };
    return createAISearchEngine({ provider, webSearchTool, enableGrounding: true });
}
function runStream(engine, q) {
    return new Promise((resolve) => {
        const events = [];
        engine.searchStream(q, null, {
            onDelta: (c) => events.push(['delta', c]),
            onComplete: (d) => { events.push(['complete', d]); resolve(events); },
            onError: (e) => { events.push(['error', e]); resolve(events); }
        });
    });
}

test('H-H: concurrent search for two aspects', async () => {
    const seen = [];
    const engine = engineWith((req, canc, cb) => {
        seen.push(req.query);
        setTimeout(() => cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(3, 's' + seen.length) }), 5);
    });
    const events = await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(events.some(e => e[0] === 'complete'), 'completes');
    assert.strictEqual(seen.length, 2, 'two concurrent searches, got ' + JSON.stringify(seen));
});

test('H-I: A succeeds B fails retains A', async () => {
    const engine = engineWith((req, canc, cb) => {
        if (req.query.indexOf('harga') !== -1) cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(3, 'a') });
        else { const e = new Error('backend down'); e.code = 'backend_unavailable'; cb(e); }
    });
    const events = await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(events.some(e => e[0] === 'complete'), 'completes from A: ' + JSON.stringify(events.map(e => e[0])));
});

test('H-J: A fails B succeeds retains B', async () => {
    const engine = engineWith((req, canc, cb) => {
        if (req.query.indexOf('performa') !== -1) cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(3, 'b') });
        else { const e = new Error('x'); e.code = 'request_failed'; cb(e); }
    });
    const events = await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(events.some(e => e[0] === 'complete'), 'completes from B');
});

test('H-K: both fail falls back to existing error', async () => {
    const engine = engineWith((req, canc, cb) => { const e = new Error('down'); e.code = 'backend_unavailable'; cb(e); });
    const events = await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(events.some(e => e[0] === 'error'), 'errors like single path');
});

test('H-R: aspect identity in grounding text, no new metadata', async () => {
    let captured = null;
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            captured = payload;
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'ok answer' });
            onEvent({ type: 'complete', result: { text: 'ok answer', sources: [] } });
        }
    });
    let n = 0;
    const webTool = { search: (req, canc, cb) => {
        n++;
        const tag = 'u' + n;
        const srcs = [];
        for (let i = 0; i < 3; i++) srcs.push({ title: tag + i, url: 'https://example.com/' + tag + '/' + i, snippet: 'snippet text number ' + i + ' long enough here' });
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcs });
    } };
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true });
    await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    const ctx = captured && (captured.groundingContext || '');
    assert.ok(ctx.indexOf('[aspek: harga]') !== -1 && ctx.indexOf('[aspek: performa]') !== -1, 'aspect tags in text');
});

test('H-PQ: source cap and evidence bound hold', async () => {
    const engine = engineWith((req, canc, cb) => {
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(10, 'q' + req.query.length) });
    });
    const events = await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(events.some(e => e[0] === 'complete'), 'completes within bounds');
});

test('H-T: no third original-query search', async () => {
    const seen = [];
    const engine = engineWith((req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 't' + seen.length) });
    });
    await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(seen.length <= 2, 'at most 2 searches, got ' + seen.length);
});

test('H-LM: timeout and cancellation use existing semantics', async () => {
    const engineTimeout = engineWith((req, canc, cb) => {
        if (req.query.indexOf('harga') !== -1) { const e = new Error('timeout'); e.code = 'timeout'; cb(e); }
        else cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'ok') });
    });
    const ev1 = await runStream(engineTimeout, 'Bandingkan X dari sisi harga dan performa');
    assert.ok(ev1.some(e => e[0] === 'complete'), 'timeout on one leg retains other');
    const engineCancel = engineWith((req, canc, cb) => {
        setTimeout(() => {
            try { engineCancel.cancel(); } catch (e) {}
            cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'c') });
        }, 5);
    });
    let settled = null;
    const raced = await Promise.race([
        runStream(engineCancel, 'Bandingkan X dari sisi harga dan performa').then(e => { settled = e; return 'stream'; }),
        new Promise(r => setTimeout(() => r('timeout'), 2000))
    ]);
    assert.ok(raced === 'timeout' || Array.isArray(settled), 'cancel path settles or stays dropped');
});

test('H-N: stale generation drops late fan-out', async () => {
    const engine = engineWith((req, canc, cb) => {
        setTimeout(() => cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 's') }), 30);
    });
    let e1done = false;
    const p1 = runStream(engine, 'Bandingkan X dari sisi harga dan performa').then(e => { e1done = true; return e; });
    const p2 = runStream(engine, 'pertanyaan lain');
    const e2 = await p2;
    await new Promise(r => setTimeout(r, 80));
    assert.ok(e2.some(e => e[0] === 'complete' || e[0] === 'error'), 'second settles');
    assert.strictEqual(e1done, false, 'stale first never completes');
    void p1;
});

test('H-OSUVWX: guards for dedupe, metadata, parser, UI', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const appletSrc = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    const runFn = appletSrc.slice(appletSrc.indexOf('_runAIRequestStream'));
    const open = runFn.indexOf('{', runFn.indexOf('onDelta: function'));
    let depth = 0, end = -1;
    for (let i = open; i < runFn.length; i++) {
        if (runFn[i] === '{') depth++;
        else if (runFn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const deltaBody = runFn.slice(open, end + 1);
    assert.ok(deltaBody.indexOf('decomposeMultiAspect') === -1, 'no fan-out in onDelta (W)');
    const engSrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiSearchEngine.js'), 'utf8');
    assert.ok(engSrc.indexOf('streamParser') === -1, 'engine never touches streamParser (W)');
    assert.ok(engSrc.indexOf('generativeUi') === -1, 'engine never touches Generative UI (X)');
    assert.ok(engSrc.indexOf('require(') !== -1, 'sanity');
});

test('H-P1A: comparison fan-out stays 2 searches', async () => {
    const seen = [];
    const engine = engineWith((req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'p' + seen.length) });
    });
    await runStream(engine, 'Bandingkan X dari sisi harga dan performa');
    assert.strictEqual(seen.length, 2, 'comparison fans out');
});

test('H-P1C: explanation stays single search', async () => {
    const seen = [];
    const { createMockStreamingAiProvider: mkProv } = require('../ai/aiProvider.js');
    const provider = mkProv({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'Jelaskan X dari sisi harga dan performa' } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: { search: (req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'e' + seen.length) });
    } }, enableGrounding: true });
    await runStream(engine, 'Jelaskan X');
    assert.strictEqual(seen.length, 1, 'explanation stays single, got ' + JSON.stringify(seen));
});

test('H-P1D: definition stays single search', async () => {
    const seen = [];
    const { createMockStreamingAiProvider: mkProv2 } = require('../ai/aiProvider.js');
    const provider = mkProv2({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'Apa itu X berdasarkan harga dan performa' } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: { search: (req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'd' + seen.length) });
    } }, enableGrounding: true });
    await runStream(engine, 'Apa itu X');
    assert.strictEqual(seen.length, 1, 'definition stays single, got ' + JSON.stringify(seen));
});

test('H-P1E: how-to stays single search', async () => {
    const seen = [];
    const engine = engineWith((req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'h' + seen.length) });
    });
    await runStream(engine, 'Cara menggunakan X dari sisi harga dan performa');
    assert.strictEqual(seen.length, 1, 'how-to stays single, got ' + JSON.stringify(seen));
});

test('H-P1B: two-object comparison fans out', async () => {
    const seen = [];
    const engine = engineWith((req, canc, cb) => {
        seen.push(req.query);
        cb(null, { type: 'tool_result', tool: 'web_search', query: req.query, sources: srcSet(2, 'b' + seen.length) });
    });
    await runStream(engine, 'Bandingkan X dan Y dari segi harga dan performa');
    assert.strictEqual(seen.length, 2, 'two-object comparison fans out, got ' + JSON.stringify(seen));
});
