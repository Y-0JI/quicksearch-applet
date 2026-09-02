// tests/ai-grounding-contracts.test.js — AI-3A canonical contract regression (follow-up FINAL)
const { test } = require('node:test');
const assert = require('node:assert');
const Gt = require('../ai/groundingTypes.js');
const { createMockWebSearchTool, createWebSearchTool } = require('../ai/webSearchTool.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider } = require('../ai/aiProvider.js');

// ── A. normalizeToolCall ─────────────────────────────────────────
test('A1 normalizeToolCall: valid web_search → tool_call', () => {
    const r = Gt.normalizeToolCall({ type: 'tool_call', tool: 'web_search', arguments: { query: '  hello ' } });
    assert.equal(r.type, 'tool_call');
    assert.equal(r.tool, 'web_search');
    assert.equal(r.arguments.query, 'hello');
});

for (const t of ['shell', 'terminal', 'system_command', 'file_write', 'app_control', 'browser_control', 'exec', 'unknown_tool', '']) {
    test(`A2 normalizeToolCall: unknown tool "${t || '(empty)'}" → unsupported_tool`, () => {
        const r = Gt.normalizeToolCall({ type: 'tool_call', tool: t, arguments: { query: 'q' } });
        assert.equal(r.type, 'unsupported_tool');
    });
}

test('A2b normalizeToolCall: non-tool_call type → unsupported_tool', () => {
    assert.equal(Gt.normalizeToolCall({ type: 'answer', text: 'hi' }).type, 'unsupported_tool');
    assert.equal(Gt.normalizeToolCall(null).type, 'unsupported_tool');
    assert.equal(Gt.normalizeToolCall({}).type, 'unsupported_tool');
});

test('A3 normalizeToolCall: web_search missing query → tool_error invalid_query', () => {
    const r1 = Gt.normalizeToolCall({ type: 'tool_call', tool: 'web_search', arguments: {} });
    assert.equal(r1.type, 'tool_error');
    assert.equal(r1.code, 'invalid_query');
    assert.equal(r1.tool, 'web_search');

    const r2 = Gt.normalizeToolCall({ type: 'tool_call', tool: 'web_search', arguments: { query: '   ' } });
    assert.equal(r2.type, 'tool_error');
    assert.equal(r2.code, 'invalid_query');

    const r3 = Gt.normalizeToolCall({ type: 'tool_call', tool: 'web_search' });
    assert.equal(r3.type, 'tool_error');
    assert.equal(r3.code, 'invalid_query');

    const r4 = Gt.normalizeToolCall({ type: 'tool_call', tool: 'web_search', arguments: { query: '' } });
    assert.equal(r4.type, 'tool_error');
    assert.equal(r4.code, 'invalid_query');
});

// ── B. canonical WebSearchTool ───────────────────────────────────
test('B1 canonical object request → tool_result (never raw Array)', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://a.com', snippet: 's' }]) });
    tool.search({ query: 'q', maxResults: 5 }, null, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.type, 'tool_result');
        assert.equal(res.tool, 'web_search');
        assert.equal(res.query, 'q');
        assert.ok(Array.isArray(res.sources));
        assert.equal(res.sources[0].id, 'web-1');
        assert.ok(!Array.isArray(res) || res.type, 'must not be raw array');
    });
});

test('B1b canonical zero results → tool_result sources []', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, []) });
    tool.search({ query: 'q', maxResults: 5 }, null, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.type, 'tool_result');
        assert.equal(res.sources.length, 0);
    });
});

test('B1c canonical request with many results respects limit', () => {
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => {
            const arr = Array.from({ length: 20 }, (_, i) => ({ title: 'T' + i, url: 'https://example.com/' + i, snippet: 's' }));
            cb(null, arr);
        }
    });
    tool.search({ query: 'q', maxResults: 5 }, null, (err, res) => {
        assert.equal(res.sources.length, 5);
        assert.ok(res.sources.every(s => Gt.isCanonicalSource(s)));
    });
    tool.search({ query: 'q', maxResults: 2 }, null, (err, res) => {
        assert.equal(res.sources.length, 2);
    });
});

test('B2 legacy string request → raw Array (compat)', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://a.com', snippet: 's' }]) });
    tool.search('q', null, (err, res) => {
        assert.ok(Array.isArray(res), 'legacy must be array');
        assert.equal(res[0].url, 'https://a.com');
    });
});

test('B2b legacy (query, cb) overload → raw Array', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://a.com', snippet: 's' }]) });
    tool.search('q', (err, res) => {
        assert.ok(Array.isArray(res));
    });
});

test('B3 canonical via backend → tool_result', () => {
    let seen = null;
    const backend = { search(query, maxResults, c, cb) { seen = { query, maxResults }; cb(null, [{ title: 'T', url: 'https://a.com', snippet: 's' }]); } };
    const tool = createWebSearchTool({ backend });
    tool.search({ query: 'q', maxResults: 3 }, null, (err, res) => {
        assert.equal(seen.query, 'q');
        assert.equal(seen.maxResults, 3);
        assert.equal(res.type, 'tool_result');
        assert.equal(res.sources.length, 1);
    });
});

// ── C. canonical source validation ───────────────────────────────
test('C1 invalid URL dropped', () => {
    const out = Gt.normalizeSources([{ title: 'T', url: 'ftp://bad', snippet: 's' }, { title: 'T', url: 'javascript:alert(1)', snippet: '' }], 10);
    assert.equal(out.length, 0);
});

test('C2 raw valid source without id → normalized and assigned canonical id', () => {
    const r = Gt.createToolResult('q', [{ title: 'T', url: 'https://a.com', snippet: 's' }]);
    assert.equal(r.sources.length, 1);
    assert.ok(Gt.isCanonicalSource(r.sources[0]));
    assert.equal(r.sources[0].id, 'web-1');
});

test('C2b mixed valid/invalid: invalid dropped, valid kept', () => {
    const r = Gt.createToolResult('q', [{ title: 'T', url: 'https://a.com', snippet: 's' }, { title: '', url: 'ftp://bad' }, null, { title: 'T2', url: 'https://b.com', snippet: '' }]);
    assert.equal(r.sources.length, 2);
    assert.ok(r.sources.every(s => Gt.isCanonicalSource(s)));
});

test('C3 canonical builder output all pass isCanonicalSource()', () => {
    for (const fn of [() => Gt.createToolResult('q', [{ title: 'T', url: 'https://a.com', snippet: 's' }, { title: 'T2', url: 'https://b.com', snippet: 's2' }]),
        () => Gt.createGroundingContext('q', [{ title: 'T', url: 'https://a.com', snippet: 's' }]),
        () => Gt.createGroundedAnswer('text', [{ title: 'T', url: 'https://a.com', snippet: 's' }])]) {
        const obj = fn();
        const sources = obj.sources;
        for (const s of sources) assert.ok(Gt.isCanonicalSource(s), JSON.stringify(s) + ' must be canonical');
    }
});

test('C4 validateSources separates valid/invalid (inspection helper)', () => {
    const good = { id: 'web-1', title: 'T', url: 'https://a.com', snippet: 's' };
    const bad = { title: 'T', url: 'ftp://bad', snippet: 's' };
    const v = Gt.validateSources([good, bad, null]);
    assert.equal(v.valid.length, 1);
    assert.equal(v.invalid.length, 2);
});

test('C5 canonicalizeSources is single enforcement path', () => {
    // Should match normalizeSources semantics for raw input, but also accept already-canonical
    const raw = [{ title: 'T', url: 'https://a.com', snippet: 's' }, { title: 'T', url: 'ftp://bad', snippet: '' }];
    const a = Gt.canonicalizeSources(raw);
    const b = Gt.normalizeSources(raw, 10);
    assert.deepEqual(a, b);
    // already-canonical preserves id sequentiality after dedupe
    const canon = [{ id: 'web-1', title: 'T', url: 'https://a.com', snippet: 's' }, { id: 'web-2', title: 'T2', url: 'https://a.com', snippet: 's2' }];
    const c = Gt.canonicalizeSources(canon);
    assert.equal(c.length, 1, 'dedupe canonical still applies');
    assert.equal(c[0].id, 'web-1');
});

// ── D. createGroundingContext ────────────────────────────────────
test('D createGroundingContext shape', () => {
    const ctx = Gt.createGroundingContext('  q  ', [{ title: 'T', url: 'https://a.com', snippet: 's' }]);
    assert.equal(ctx.type, 'grounding_context');
    assert.equal(ctx.query, 'q');
    assert.ok(Array.isArray(ctx.sources));
    assert.ok(ctx.sources.every(s => Gt.isCanonicalSource(s)));
});

test('D empty sources → grounding_context with []', () => {
    const ctx = Gt.createGroundingContext('q', []);
    assert.equal(ctx.type, 'grounding_context');
    assert.equal(ctx.sources.length, 0);
});

test('D null sources → [] defensively', () => {
    const ctx = Gt.createGroundingContext('q', null);
    assert.equal(ctx.sources.length, 0);
});

// ── E. createGroundedAnswer ──────────────────────────────────────
test('E1 no source → grounded false', () => {
    const a = Gt.createGroundedAnswer('text', []);
    assert.equal(a.type, 'answer');
    assert.equal(a.grounded, false);
    assert.equal(a.sources.length, 0);
    assert.equal(a.text, 'text');
});

test('E1b null/undefined → grounded false', () => {
    assert.equal(Gt.createGroundedAnswer('text', null).grounded, false);
    assert.equal(Gt.createGroundedAnswer('text').grounded, false);
});

test('E2 with sources → grounded true + canonical sources', () => {
    const a = Gt.createGroundedAnswer('text', [{ title: 'T', url: 'https://a.com', snippet: 's' }]);
    assert.equal(a.grounded, true);
    assert.equal(a.sources.length, 1);
    assert.ok(Gt.isCanonicalSource(a.sources[0]));
});

test('E2b invalid sources dropped → grounded false if none survive', () => {
    const a = Gt.createGroundedAnswer('text', [{ title: '', url: 'ftp://bad' }, null]);
    assert.equal(a.grounded, false);
    assert.equal(a.sources.length, 0);
});

// ── F. URL dedupe ────────────────────────────────────────────────
test('F1 hostname casing: https://Example.COM vs https://example.com/ duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://Example.com', snippet: 's' }, { title: 'B', url: 'https://example.com/', snippet: 's2' }], 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'A', 'first valid wins');
});

test('F1b root slash: https://example.com vs https://example.com/ duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://example.com', snippet: 's' }, { title: 'B', url: 'https://example.com/', snippet: 's2' }], 10);
    assert.equal(out.length, 1);
});

test('F2 path case preserved: /path vs /PATH NOT duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://example.com/path', snippet: 's' }, { title: 'B', url: 'https://example.com/PATH', snippet: 's2' }], 10);
    assert.equal(out.length, 2);
});

test('F3 query preserved: ?a=1 vs ?a=2 NOT duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://example.com?a=1', snippet: 's' }, { title: 'B', url: 'https://example.com?a=2', snippet: 's2' }], 10);
    assert.equal(out.length, 2);
});

test('F3b same query IS duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://example.com?a=1', snippet: 's' }, { title: 'B', url: 'https://example.com?a=1', snippet: 's2' }], 10);
    assert.equal(out.length, 1);
});

test('F3c hash preserved: #a vs #b NOT duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'https://example.com#a', snippet: 's' }, { title: 'B', url: 'https://example.com#b', snippet: 's2' }], 10);
    assert.equal(out.length, 2);
});

test('F4 first valid wins', () => {
    const out = Gt.normalizeSources([
        { title: 'First', url: 'https://a.com', snippet: 'first' },
        { title: 'Second', url: 'https://a.com', snippet: 'second' },
        { title: 'Third', url: 'https://b.com', snippet: 'third' }
    ], 10);
    assert.equal(out[0].snippet, 'first');
    assert.equal(out[0].title, 'First');
    assert.equal(out.length, 2);
});

test('F4b trim whitespace before dedupe', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: ' https://a.com ', snippet: 's' }, { title: 'B', url: 'https://a.com', snippet: 's2' }], 10);
    assert.equal(out.length, 1);
});

test('F5 protocol case folded: HTTPS://example.com duplicate', () => {
    const out = Gt.normalizeSources([{ title: 'A', url: 'HTTPS://example.com/a', snippet: 's' }, { title: 'B', url: 'https://example.com/a', snippet: 's2' }], 10);
    assert.equal(out.length, 1);
});

// ── G. AISearchEngine contract integration ───────────────────────
test('G1 engine: invalid web_search arguments → invalid_query (not invalid_response)', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'web_search', arguments: {} }] });
    const engine = createAISearchEngine({ provider, enableGrounding: true });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.ok(err);
    assert.equal(err.code, 'invalid_query');
});

test('G1b engine: empty query in tool_call → invalid_query', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'web_search', arguments: { query: '   ' } }] });
    const engine = createAISearchEngine({ provider, enableGrounding: true });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'invalid_query');
});

test('G1c engine: missing arguments key → invalid_query', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'web_search' }] });
    const engine = createAISearchEngine({ provider, enableGrounding: true });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'invalid_query');
});

test('G2 engine: valid web_search uses canonical normalizeToolCall boundary and grounding_context', () => {
    let secondReq = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            secondReq = req;
            cb(null, { type: 'answer', text: 'grounded' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https ->example.com/a', snippet: 's' }].map(x => ({ title: 'T', url: 'https://example.com/a', snippet: 's' }))) });
    // use real tool that returns legacy array; engine must still build canonical grounding_context
    const tool2 = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]) });
    const engine = createAISearchEngine({ provider, webSearchTool: tool2, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.ok(secondReq);
    assert.ok(secondReq.groundingContext.includes('https://example.com/a'));
    assert.ok(secondReq.groundingContextObj);
    assert.equal(secondReq.groundingContextObj.type, 'grounding_context');
    assert.equal(got.grounded, true);
});

test('G2b engine: unknown tool → unsupported_tool', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'exec', arguments: { query: 'q' } }] });
    const engine = createAISearchEngine({ provider, enableGrounding: true });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'unsupported_tool');
});

test('G3 engine: direct answer → canonical grounded answer grounded false', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'direct' }] });
    const engine = createAISearchEngine({ provider });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(got.type, 'answer');
    assert.equal(got.grounded, false);
    assert.equal(got.sources.length, 0);
    assert.equal(got.text, 'direct');
});

test('G3b engine: grounded answer → grounded true + canonical sources', () => {
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            cb(null, { type: 'answer', text: 'grounded text' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]) });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(got.type, 'answer');
    assert.equal(got.grounded, true);
    assert.ok(got.sources.every(s => Gt.isCanonicalSource(s)));
});

test('G3c engine: callback overload (query, onAnswer) still delivers canonical answer', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'hi' }] });
    const engine = createAISearchEngine({ provider });
    let got = null;
    engine.search('q', (err, res) => { got = res; });
    assert.equal(got.type, 'answer');
    assert.equal(got.grounded, false);
});

test('G4 engine accepts canonical tool_result from WebSearchTool', () => {
    let secondReq = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            secondReq = req;
            cb(null, { type: 'answer', text: 'ok' });
        }
    });
    const tool = {
        search(qOrReq, c, cb) {
            if (typeof c === 'function' && !cb) { cb = c; c = null; }
            const q = typeof qOrReq === 'string' ? qOrReq : qOrReq.query;
            const tr = Gt.createToolResult(q, [{ id: 'web-1', title: 'T', url: 'https://example.com/a', snippet: 's' }]);
            cb(null, tr);
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(got.grounded, true);
    assert.equal(got.sources[0].url, 'https://example.com/a');
    assert.ok(secondReq.groundingContextObj && secondReq.groundingContextObj.type === 'grounding_context');
});

// ── Additional: request/Source/ToolError/Cancel contracts ────────
test('validateRequest: trims and caps', () => {
    assert.equal(Gt.validateRequest({ query: '  hello  ', maxResults: 99 }).query, 'hello');
    assert.equal(Gt.validateRequest({ query: 'q', maxResults: 99 }).maxResults, 10);
    assert.equal(Gt.validateRequest({ query: '  ' }).error.code, 'invalid_query');
    assert.equal(Gt.validateRequest(null).error.code, 'invalid_query');
});

test('createToolError sanitizes newline/stack', () => {
    const e = Gt.createToolError('request_failed', 'fail\n  at stack:1\n  at stack:2');
    assert.equal(e.message, 'fail');
    assert.equal(e.type, 'tool_error');
});

test('toCallbackError / fromCallbackError round-trip', () => {
    const te = Gt.createToolError('backend_unavailable', 'Backend unavailable');
    const err = Gt.toCallbackError(te);
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'backend_unavailable');
    const back = Gt.fromCallbackError(err);
    assert.equal(back.code, 'backend_unavailable');
    assert.equal(back.type, 'tool_error');
});

test('tool_error codes all valid', () => {
    for (const code of Object.keys(Gt.ERROR_CODES)) {
        const e = Gt.createToolError(code, 'msg');
        assert.equal(e.code, code);
        assert.equal(e.tool, 'web_search');
        assert.equal(e.type, 'tool_error');
    }
});

test('WebSearchTool canonical fails with invalid query → tool_error', () => {
    const tool = createMockWebSearchTool();
    tool.search({ query: '   ', maxResults: 5 }, null, (err, res) => {
        assert.ok(err);
        assert.equal(err.code, 'invalid_query');
        assert.equal(err.type, 'tool_error');
    });
});

test('WebSearchTool canonical error does not leak stack', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => { const e = new Error('fail\n  at stack:1'); cb(e); } });
    tool.search({ query: 'q', maxResults: 5 }, null, (err, res) => {
        assert.ok(err);
        assert.ok(!String(err.message).includes('at stack'));
    });
});

test('WebSearchTool backend_unavailable via handler code', () => {
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => { const e = new Error('Backend unavailable'); e.code = 'backend_unavailable'; cb(e); } });
    tool.search({ query: 'q', maxResults: 5 }, null, (err, res) => {
        assert.equal(err.code, 'backend_unavailable');
    });
});

test('createWebSearchTool fail-closed when Gt missing (canonical) but mock legacy still works', () => {
    const Module = require('node:module');
    const origRequire = Module.prototype.require;
    const wsPath = require.resolve('../ai/webSearchTool.js');
    delete require.cache[wsPath];
    Module.prototype.require = function (id) {
        if (id.endsWith('groundingTypes.js') || id === './groundingTypes.js') throw new Error('simulated missing');
        return origRequire.apply(this, arguments);
    };
    try {
        const { createWebSearchTool: cw, createMockWebSearchTool: cm } = require('../ai/webSearchTool.js');
        const t = cw({});
        let gotErr = null;
        t.search({ query: 'q', maxResults: 5 }, null, (err, res) => { gotErr = err; });
        assert.ok(gotErr);
        assert.equal(gotErr.code, 'invalid_response');
        const m = cm({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://a.com', snippet: 's' }]) });
        let gotArr = null;
        m.search('q', null, (e, r) => { gotArr = r; });
        assert.ok(Array.isArray(gotArr));
    } finally {
        Module.prototype.require = origRequire;
        delete require.cache[wsPath];
        require('../ai/webSearchTool.js');
    }
});
