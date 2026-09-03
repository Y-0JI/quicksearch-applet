// tests/ai-grounding-orchestration.test.js — AI-3B lifecycle/orchestration focused (A–L)
// Covers direct, single round, loop guard, empty, errors, cancel/stale.
// Uses controllable deferred callbacks to prove async guards; asserts side-effects not just gen.
const { test } = require('node:test');
const assert = require('node:assert');
const Gt = require('../ai/groundingTypes.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');

// helpers
function captureProvider(handler) {
    let calls = 0;
    const payloads = [];
    const provider = {
        request(payload, cancellable, cb) {
            if (typeof cancellable === 'function' && cb === undefined) { cb = cancellable; cancellable = null; }
            calls++;
            payloads.push(payload);
            return handler(payload, cancellable, cb, calls, payloads);
        },
        _calls() { return calls; },
        _payloads() { return payloads; }
    };
    return provider;
}
function captureTool(handler) {
    let calls = 0;
    const reqs = [];
    const tool = {
        search(req, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            calls++;
            reqs.push(req);
            return handler(req, cancellable, cb, calls, reqs);
        },
        _calls() { return calls; },
        _reqs() { return reqs; }
    };
    return tool;
}

// A — Direct answer
test('A direct answer: Provider1 direct -> WebSearch 0, provider 1, no grounding, no Provider2', () => {
    let toolCalls = 0;
    const provider = captureProvider((payload, _c, cb) => {
        assert.ok(!payload.groundingContext, 'direct path payload must not have groundingContext');
        assert.ok(!payload.groundingContextObj, 'direct path payload must not have groundingContextObj');
        cb(null, { type: 'answer', text: 'direct' });
    });
    const tool = captureTool(() => { toolCalls++; assert.fail('WebSearch must not be called on direct answer'); });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null, err = null;
    engine.search('hello', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(provider._calls(), 1, 'provider exactly 1');
    assert.equal(tool._calls(), 0, 'webSearch 0');
    assert.equal(toolCalls, 0);
    assert.ok(got, 'answer delivered');
    assert.equal(err, null);
    assert.equal(got.type, 'answer');
    assert.equal(got.grounded, false);
    assert.equal(got.sources.length, 0);
});

// B — Valid grounded path
test('B valid grounded: 1 WebSearch, 2 provider, grounding context, canonical final, no Provider3', () => {
    let providerCalls = 0;
    let secondPayload = null;
    const provider = captureProvider((payload, _c, cb, calls) => {
        providerCalls = calls;
        if (!payload.groundingContext) {
            assert.deepEqual(payload.tools, ['web_search'], 'Provider1 must advertise web_search when grounding enabled');
            return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'expected query' } });
        }
        secondPayload = payload;
        // Provider2 must receive grounding, must not advertise tools for second round
        assert.ok(payload.groundingContext && payload.groundingContext.includes('https://example.com/a'), 'groundingContext must contain source url');
        assert.ok(payload.groundingContextObj && payload.groundingContextObj.type === 'grounding_context', 'groundingContextObj canonical');
        assert.deepEqual(payload.tools, [], 'Provider2 must not advertise web_search');
        cb(null, { type: 'answer', text: 'grounded answer' });
    });
    const tool = captureTool((req, _c, cb) => {
        // canonical request object
        assert.equal(typeof req, 'object');
        assert.ok(!Array.isArray(req));
        assert.equal(req.query, 'expected query');
        assert.equal(req.maxResults, Gt.DEFAULT_MAX_RESULTS);
        const tr = Gt.createToolResult(req.query, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
        assert.equal(tr.type, 'tool_result');
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null, err = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(tool._calls(), 1, 'WebSearch exactly 1');
    assert.equal(provider._calls(), 2, 'provider exactly 2');
    assert.equal(providerCalls, 2);
    assert.ok(secondPayload, 'Provider2 was called');
    assert.equal(err, null);
    assert.ok(got, 'final answer delivered');
    assert.equal(got.type, 'answer');
    assert.equal(got.grounded, true);
    assert.ok(got.sources.every(s => Gt.isCanonicalSource(s)), 'canonical sources');
    assert.equal(got.sources[0].url, 'https://example.com/a');
    // no Provider3: if provider were called a third time, _calls would be 3
    assert.equal(provider._calls(), 2, 'no Provider3');
});

// C — Tool loop guard
test('C loop guard: Provider2 returns tool_call -> no second WebSearch, no Provider3, invalid_response', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        // second call returns tool_call again -> loop attempt
        return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'y' } });
    });
    const tool = captureTool((req, _c, cb) => {
        const tr = Gt.createToolResult(req.query, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(tool._calls(), 1, 'WebSearch stays 1');
    assert.equal(provider._calls(), 2, 'provider stays 2');
    assert.equal(got, null, 'no final answer on loop');
    assert.ok(err, 'deterministic error');
    assert.equal(err.code, 'invalid_response');
});

// D — Empty sources
test('D empty sources: tool_result sources [] -> no Provider2, no_results, no fake context', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not be called on empty sources');
    });
    const tool = captureTool((req, _c, cb) => {
        const tr = Gt.createToolResult(req.query, []);
        assert.equal(tr.sources.length, 0);
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(provider._calls(), 1, 'Provider2 not called');
    assert.equal(tool._calls(), 1);
    assert.equal(got, null, 'no grounded answer');
    assert.ok(err, 'deterministic no_results error');
    assert.equal(err.code, 'no_results');
    // Phase 7 §5: empty-but-valid tool_result must carry an explicit stage, never Stage: unknown
    assert.equal(err.stage, 'web_search_normalize', 'no_results must not surface as Stage: unknown');
    assert.equal(err._stage, 'web_search_normalize');
});

// D2 — Empty sources on the STREAMING tool-call path also carries a stage
test('D2 empty sources streaming: tool_result sources [] -> no_results with web_search_normalize stage, no second stream', () => {
    let stream1Cb = null, stream2Calls = 0;
    const provider = {
        request() { throw new Error('non-streaming must not be used'); },
        streamRequest(payload, cancellable, onEvent) {
            if (!payload.groundingContext) {
                stream1Cb = onEvent;
                return;
            }
            stream2Calls++;
        }
    };
    const tool = captureTool((_req, _c, cb) => {
        const tr = Gt.createToolResult('x', []);
        assert.equal(tr.sources.length, 0);
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.searchStream('q', { onComplete: d => { got = d; }, onError: e => { err = e; } });
    assert.ok(stream1Cb, 'first stream pending');
    stream1Cb({ type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
    assert.equal(stream2Calls, 0, 'no second stream on empty sources');
    assert.equal(got, null, 'no grounded complete');
    assert.ok(err, 'deterministic no_results error');
    assert.equal(err.code, 'no_results');
    assert.equal(err.stage, 'web_search_normalize', 'streaming empty tool_result must not surface as Stage: unknown');
    assert.equal(err._stage, 'web_search_normalize');
});

// E — Web search error
test('E web search error: Provider2 not called, no grounded answer, error via existing path', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not run after webSearch error');
    });
    const tool = captureTool((_req, _c, cb) => {
        const e = new Error('fail');
        e.code = 'web_search_unavailable';
        cb(e);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(provider._calls(), 1);
    assert.equal(tool._calls(), 1);
    assert.equal(got, null);
    assert.ok(err);
    assert.equal(err.code, 'web_search_unavailable');
});

// F — Invalid canonical results
test('F1 invalid canonical: raw Array -> fail closed invalid_response, no Provider2', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not be called on invalid canonical');
    });
    // tool returns raw Array instead of tool_result (simulates legacy misuse)
    const tool = {
        search(req, c, cb) {
            if (typeof c === 'function' && !cb) { cb = c; c = null; }
            cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
        }
    };
    // wrap with counts
    let toolCalls = 0;
    const orig = tool.search;
    tool.search = (req, c, cb) => { toolCalls++; return orig(req, c, cb); };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(toolCalls, 1);
    assert.equal(provider._calls(), 1);
    assert.equal(got, null);
    assert.ok(err);
    assert.equal(err.code, 'invalid_response');
});

test('F2 invalid canonical: object without type tool_result -> invalid_response', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not be called');
    });
    const tool = captureTool((_req, _c, cb) => {
        cb(null, { tool: 'web_search', query: 'x', sources: [{ id: 'web-1', title: 'T', url: 'https://example.com/a', snippet: 's' }] });
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(provider._calls(), 1);
    assert.ok(err);
    assert.equal(err.code, 'invalid_response');
    assert.equal(got, null);
});

test('F3 invalid canonical: sources not Array -> invalid_response', () => {
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not be called');
    });
    const tool = captureTool((_req, _c, cb) => {
        cb(null, { type: 'tool_result', tool: 'web_search', query: 'x', sources: 'not-an-array' });
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null, got = null;
    engine.search('q', { onAnswer: d => { got = d; }, onError: e => { err = e; } });
    assert.equal(provider._calls(), 1);
    assert.ok(err);
    assert.equal(err.code, 'invalid_response');
    assert.equal(got, null);
});

// G — Cancel during Provider #1
test('G cancel during Provider1: late callback ignored, no WebSearch, no Provider2, no delivery', () => {
    let pendingCb = null;
    const provider = captureProvider((payload, _c, cb) => {
        pendingCb = cb;
        // do not call yet
    });
    const tool = captureTool(() => { assert.fail('WebSearch must not start after cancel during Provider1'); });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let delivered = false;
    engine.search('q', { onAnswer: () => { delivered = true; }, onError: () => { delivered = true; } });
    assert.equal(provider._calls(), 1);
    engine.cancel();
    // late callback after cancel
    pendingCb(null, { type: 'answer', text: 'late' });
    assert.equal(delivered, false, 'late Provider1 callback ignored');
    assert.equal(tool._calls(), 0, 'WebSearch never started');
    assert.equal(provider._calls(), 1, 'no Provider2');
});

// H — Cancel during Web Search
test('H cancel during WebSearch: late WebSearch callback ignored, Provider2 not called, no delivery', () => {
    let webCb = null;
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        assert.fail('Provider2 must not be called after cancel during WebSearch');
    });
    const tool = captureTool((_req, _c, cb) => { webCb = cb; });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let delivered = false;
    engine.search('q', { onAnswer: () => { delivered = true; }, onError: () => { delivered = true; } });
    assert.equal(tool._calls(), 1, 'WebSearch started');
    assert.ok(webCb, 'WebSearch pending');
    engine.cancel();
    const tr = Gt.createToolResult('x', [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
    webCb(null, tr);
    assert.equal(delivered, false, 'late WebSearch ignored');
    assert.equal(provider._calls(), 1, 'Provider2 never started');
});

// I — Cancel during Provider #2
test('I cancel during Provider2: late Provider2 callback ignored, no final delivery', () => {
    let provider2Cb = null;
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (calls === 1) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        // second call -> pending
        provider2Cb = cb;
    });
    const tool = captureTool((_req, _c, cb) => {
        const tr = Gt.createToolResult('x', [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let delivered = false;
    engine.search('q', { onAnswer: () => { delivered = true; }, onError: () => { delivered = true; } });
    assert.ok(provider2Cb, 'Provider2 pending');
    assert.equal(provider._calls(), 2, 'Provider2 started');
    engine.cancel();
    provider2Cb(null, { type: 'answer', text: 'late grounded' });
    assert.equal(delivered, false, 'late Provider2 ignored');
    // ensure new request not affected
    let got2 = null;
    const provider2 = captureProvider((payload, _c, cb) => cb(null, { type: 'answer', text: 'fresh' }));
    const engine2 = createAISearchEngine({ provider: provider2, enableGrounding: false });
    engine2.search('fresh', { onAnswer: d => { got2 = d; } });
    assert.ok(got2 && got2.text === 'fresh', 'fresh engine unaffected');
});

// J — Stale Provider #1
test('J stale Provider1: Query A late ignored, A does not start WebSearch, does not overwrite B', () => {
    let firstCb = null;
    const provider = captureProvider((payload, _c, cb, calls) => {
        if (payload.query === 'first') { firstCb = cb; return; }
        if (payload.query === 'second') return cb(null, { type: 'answer', text: 'second' });
        cb(null, { type: 'answer', text: 'unknown' });
    });
    const toolCalls = [];
    const tool = captureTool((req, _c, cb) => { toolCalls.push(req.query); const tr = Gt.createToolResult(req.query, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]); cb(null, tr); });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: false });
    let got1 = null, got2 = null;
    engine.search('first', { onAnswer: d => { got1 = d; } });
    engine.search('second', { onAnswer: d => { got2 = d; } });
    assert.equal(provider._calls(), 2, 'both queries reached provider');
    // late first
    firstCb(null, { type: 'answer', text: 'first-late' });
    assert.equal(got1, null, 'Query A ignored');
    assert.ok(got2 && got2.text === 'second', 'Query B not overwritten');
    assert.equal(tool._calls(), 0, 'stale Provider1 did not start WebSearch');
});

// K — Stale WebSearch
test('K stale WebSearch: Query A WebSearch late ignored, Provider2 for A not started, B active', () => {
    let webCbA = null;
    const provider = captureProvider((payload, _c, cb) => {
        if (!payload.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        // Provider2 for A should not be reached; B is direct answer
        if (payload.query === 'second') return cb(null, { type: 'answer', text: 'second' });
        assert.fail('Provider2 for stale WebSearch A must not be called');
    });
    // need two engines? Single engine with two searches: first will be stale at WebSearch stage.
    // First search: provider immediate tool_call, webSearch deferred.
    // Second search: bumps gen before webSearch A returns.
    const tool = captureTool((req, _c, cb) => {
        // first WebSearch -> capture, second not expected (B is direct)
        webCbA = cb;
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    // use a provider that for second query returns direct (no grounding) — but engine will use same provider.
    // So we need provider handler that distinguishes by query and grounding presence.
    // Make provider handler smarter: if query second -> direct even if grounding missing
    const provider2 = captureProvider((payload, _c, cb) => {
        if (payload.query === 'first' && !payload.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        if (payload.query === 'second') return cb(null, { type: 'answer', text: 'second' });
        assert.fail('unexpected Provider2 for stale A: ' + JSON.stringify(payload));
    });
    const tool2 = captureTool((_req, _c, cb) => { webCbA = cb; });
    const engine2 = createAISearchEngine({ provider: provider2, webSearchTool: tool2, enableGrounding: true });
    let gotA = null, gotB = null;
    engine2.search('first', { onAnswer: d => { gotA = d; }, onError: () => { gotA = 'err'; } });
    assert.equal(tool2._calls(), 1, 'first WebSearch pending');
    assert.ok(webCbA);
    engine2.search('second', { onAnswer: d => { gotB = d; } });
    assert.equal(provider2._calls(), 2, 'second query reached provider');
    assert.ok(gotB && gotB.text === 'second', 'B delivered');
    const tr = Gt.createToolResult('x', [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
    webCbA(null, tr);
    assert.equal(gotA, null, 'stale WebSearch A ignored, no Provider2');
    assert.equal(provider2._calls(), 2, 'Provider2 for A not started');
});

// L — Stale Provider #2
test('L stale Provider2: late grounded for A ignored, B not overwritten, only active delivers', () => {
    let provider2CbA = null;
    const provider = captureProvider((payload, _c, cb, calls) => {
        // Query A: first call tool_call, second call (grounded) deferred
        // Query B: direct answer immediate
        if (payload.query === 'first' && !payload.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        if (payload.query === 'first' && payload.groundingContext) { provider2CbA = cb; return; }
        if (payload.query === 'second') return cb(null, { type: 'answer', text: 'second' });
        cb(null, { type: 'answer', text: 'unknown' });
    });
    const tool = captureTool((_req, _c, cb) => {
        const tr = Gt.createToolResult('x', [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
        cb(null, tr);
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let gotA = null, gotB = null;
    engine.search('first', { onAnswer: d => { gotA = d; }, onError: e => { gotA = e; } });
    assert.ok(provider2CbA, 'Provider2 for first pending');
    assert.equal(provider._calls(), 2, 'first reached Provider2');
    engine.search('second', { onAnswer: d => { gotB = d; } });
    assert.ok(gotB && gotB.text === 'second', 'B delivered');
    provider2CbA(null, { type: 'answer', text: 'first-grounded-late' });
    assert.equal(gotA, null, 'stale Provider2 A ignored, no final delivery');
    assert.equal(gotB.text, 'second', 'B not overwritten by stale A');
});
