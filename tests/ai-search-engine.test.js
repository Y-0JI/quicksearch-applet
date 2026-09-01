const { test } = require('node:test');
const assert = require('node:assert');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

function cancellable() {
    let c = false;
    return { is_cancelled: () => c, cancel: () => { c = true; } };
}

// 1 query reaches provider
test('engine: query reaches provider', () => {
    let seen = null;
    const provider = createMockAiProvider({ handler: (req, cb) => { seen = req.query; cb(null, { type: 'answer', text: 'ok' }); } });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    engine.search('hello', null, { onAnswer: () => {} });
    assert.equal(seen, 'hello');
});

// 2 final answer reaches callback
test('engine: final answer reaches onAnswer', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'final' }] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.search('q', { onAnswer: (d) => { got = d; } });
    // also supports (query, callbacks) overload
    assert.equal(got.text, 'final');
});

// 3 valid web tool call invokes WebSearchTool
test('engine: valid tool_call invokes WebSearchTool', () => {
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'bmri' } });
            cb(null, { type: 'answer', text: 'grounded' });
        }
    });
    let toolCalled = false;
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => { toolCalled = true; assert.equal(q, 'bmri'); cb(null, [{ title: 't', url: 'https://example.com', snippet: 's' }]); } });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(toolCalled, true);
    assert.equal(got.text, 'grounded');
});

// 4 search results return to provider for grounding + sources normalized
test('engine: grounding passes sources to provider and delivers them', () => {
    let secondReq = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            secondReq = req;
            cb(null, { type: 'answer', text: 'done' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'Title', url: 'https://example.com/a', snippet: 'snip' }]) });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.ok(secondReq.groundingContext.includes('https://example.com/a'));
    assert.equal(got.sources.length, 1);
    assert.equal(got.sources[0].url, 'https://example.com/a');
});

// 5 unknown tool does not execute
test('engine: unknown tool does not execute webSearch', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'exec', arguments: { query: 'q' } }] });
    let toolCalled = false;
    const tool = createMockWebSearchTool({ handler: () => { toolCalled = true; } });
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(toolCalled, false);
    assert.equal(err.code, 'unsupported_tool');
});

// 6 provider error normalized
test('engine: provider error normalized', () => {
    const provider = createMockAiProvider({ handler: (req, cb) => cb(new Error('boom')) });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'provider_error');
});

// 7 web search error normalized
test('engine: web search error normalized', () => {
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            cb(null, { type: 'answer', text: 'ok' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => { const e = new Error('fail'); e.code = 'web_search_unavailable'; cb(e); } });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'web_search_unavailable');
});

// 8 stale response ignored (first async answer ignored after second search)
test('engine: stale response ignored', () => {
    let firstCb = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (req.query === 'first') { firstCb = cb; return; }
            cb(null, { type: 'answer', text: 'second' });
        }
    });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got1 = null, got2 = null;
    engine.search('first', { onAnswer: d => { got1 = d; } });
    engine.search('second', { onAnswer: d => { got2 = d; } });
    // late first response
    firstCb(null, { type: 'answer', text: 'first-late' });
    assert.equal(got1, null);
    assert.equal(got2.text, 'second');
});

// 9 cancellation prevents old request
test('engine: cancel prevents deliver', () => {
    let heldCb = null;
    const provider = createMockAiProvider({ handler: (req, cb) => { heldCb = cb; } });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let delivered = false;
    engine.search('q', { onAnswer: () => { delivered = true; }, onError: () => { delivered = true; } });
    engine.cancel();
    heldCb(null, { type: 'answer', text: 'late' });
    assert.equal(delivered, false);
});

// 10 malformed provider response -> invalid_response
test('engine: malformed response handled', () => {
    const provider = createMockAiProvider({ responses: [{ nonsense: true }] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'invalid_response');
});

// overload: search(query, callbacks) without cancellable
test('engine: search overload without cancellable', () => {
    const provider = createMockAiProvider({ responses: [{ type: 'answer', text: 'hi' }] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(got.text, 'hi');
});

// stale on second leg (webSearch delayed, new search invalidates grounding delivery)
test('engine: stale on grounding leg ignored', () => {
    let webCb = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            cb(null, { type: 'answer', text: 'grounded' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => { webCb = cb; } });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let delivered = false;
    engine.search('first', { onAnswer: () => { delivered = true; } });
    // second search invalidates first before webSearch returns
    const provider2 = createMockAiProvider({ responses: [{ type: 'answer', text: 'second' }] });
    // reuse engine: second search
    engine.search('second', { onAnswer: () => {} });
    // now webSearch late
    webCb(null, [{ title: 't', url: 'https://example.com', snippet: 's' }]);
    // first grounded answer must not deliver (stale)
    assert.equal(delivered, false);
});
