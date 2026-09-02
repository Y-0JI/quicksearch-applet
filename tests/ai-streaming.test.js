const { test } = require('node:test');
const assert = require('node:assert');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

// ── §18.B: Engine flow — start → delta A → delta B → complete produces loading → streaming → answer ──

test('stream B1: basic streaming flow start→delta→complete', () => {
    // Provide requestHandler so request() returns a tool_call (triggers grounding → streamRequest)
    const provider = createMockStreamingAiProvider({
        chunks: ['Hello ', 'World'],
        requestHandler: (payload, cb) => {
            cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: payload.query } });
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    const events = [];
    engine.searchStream('q', {
        onStart: () => events.push('start'),
        onDelta: (chunk, full) => events.push({ type: 'delta', chunk, full }),
        onComplete: (data) => events.push({ type: 'complete', text: data.text }),
        onError: (err) => events.push({ type: 'error', code: err.code })
    });
    assert.equal(events[0], 'start');
    assert.equal(events[1].type, 'delta');
    assert.equal(events[1].chunk, 'Hello ');
    assert.equal(events[1].full, 'Hello ');
    assert.equal(events[2].type, 'delta');
    assert.equal(events[2].chunk, 'World');
    assert.equal(events[2].full, 'Hello World');
    assert.equal(events[3].type, 'complete');
    assert.equal(events[3].text, 'Hello World');
});

test('stream B2: text order is exact', () => {
    const chunks = ['a', 'b', 'c', 'd', 'e'];
    const provider = createMockStreamingAiProvider({
        chunks,
        requestHandler: (payload, cb) => {
            cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: payload.query } });
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    const deltas = [];
    engine.searchStream('q', {
        onDelta: (chunk) => deltas.push(chunk),
        onComplete: () => {}
    });
    assert.deepEqual(deltas, ['a', 'b', 'c', 'd', 'e']);
});

test('stream B3: empty deltas do not break state', () => {
    const provider = createMockStreamingAiProvider({
        chunks: ['', 'real', ''],
        requestHandler: (payload, cb) => {
            cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: payload.query } });
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    const deltas = [];
    engine.searchStream('q', {
        onDelta: (chunk) => deltas.push(chunk),
        onComplete: () => {}
    });
    assert.deepEqual(deltas, ['', 'real', '']);
});

// ── §18.C: Stale stream protection ──

test('stream C1: late A delta ignored after B starts', () => {
    let firstStreamHandler = null;
    let secondStreamHandler = null;
    let callIndex = 0;
    const provider = {
        request(payload, cancellable, cb) {
            cb(null, { type: 'answer', text: 'answer for ' + payload.query });
        },
        streamRequest(payload, cancellable, onEvent) {
            callIndex++;
            if (callIndex === 1) {
                firstStreamHandler = onEvent;
            } else {
                secondStreamHandler = onEvent;
            }
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let deltas1 = [], deltas2 = [], got1 = null, got2 = null;
    engine.searchStream('first', { onDelta: (c) => deltas1.push(c), onComplete: d => { got1 = d; } });
    engine.searchStream('second', { onDelta: (c) => deltas2.push(c), onComplete: d => { got2 = d; } });
    // Late first stream events — should be ignored (stale gen)
    if (firstStreamHandler) {
        firstStreamHandler({ type: 'start' });
        firstStreamHandler({ type: 'delta', text: 'late A' });
        firstStreamHandler({ type: 'complete', result: { text: 'LATE OVERWRITE', sources: [], grounded: false } });
    }
    assert.equal(got1, null, 'stale A must not deliver its completion');
    assert.deepEqual(deltas1, [], 'stale A delta must be ignored');
    // Second stream should still be able to deliver
    if (secondStreamHandler) {
        secondStreamHandler({ type: 'start' });
        secondStreamHandler({ type: 'delta', text: 'ok' });
        secondStreamHandler({ type: 'complete', result: { text: 'ok', sources: [], grounded: false } });
    }
    assert.equal(got2 && got2.text, 'ok', 'B must still deliver');
});

test('stream C2: late A error ignored after B starts', () => {
    let firstHandler = null;
    let callIndex = 0;
    const provider = {
        request(payload, cancellable, cb) {
            cb(null, { type: 'answer', text: 'answer' });
        },
        streamRequest(payload, cancellable, onEvent) {
            callIndex++;
            if (callIndex === 1) firstHandler = onEvent;
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err1 = null;
    engine.searchStream('first', { onError: e => { err1 = e; }, onComplete: () => {} });
    engine.searchStream('second', { onComplete: () => {}, onError: () => {} });
    if (firstHandler) {
        firstHandler({ type: 'error', error: { code: 'network_error', message: 'late' } });
    }
    assert.equal(err1, null, 'stale A error must not deliver');
});

// ── §18.D: Cancellation blocks stale deltas ──

test('stream D1: cancel blocks old chunks after cancel', () => {
    // Use a slow mock that holds the handler but doesn't deliver immediately
    let heldHandler = null;
    const provider = {
        request(payload, cancellable, cb) {
            // Don't deliver immediately — hold for this test
            // Return a tool_call to trigger grounding path which calls streamRequest
            cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } });
        },
        streamRequest(payload, cancellable, onEvent) {
            heldHandler = onEvent;
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; }, onDelta: () => {} });
    // Cancel before stream delivers
    engine.cancel();
    // Late stream events — should be blocked by stale check
    if (heldHandler) {
        heldHandler({ type: 'start' });
        heldHandler({ type: 'delta', text: 'late' });
        heldHandler({ type: 'complete', result: { text: 'late', sources: [], grounded: false } });
    }
    assert.equal(got, null, 'cancel must block old chunks');
});

test('stream D2: engine search() still works after streaming cancel', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['late'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    engine.cancel();
    // Non-streaming search should still work
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    // The mock streaming provider handles both request and streamRequest
    // request() should convert complete event to answer
    assert.ok(got, 'search should still deliver after cancel');
});

// ── §18.E: Sources — streaming text + final sources ──

test('stream E1: grounded query streams text then delivers sources at completion', () => {
    let streamHandler = null;
    const provider = {
        request(payload, cancellable, cb) {
            if (!payload.groundingContext) {
                return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'search q' } });
            }
            cb(null, { type: 'answer', text: 'grounded answer' });
        },
        streamRequest(payload, cancellable, onEvent) {
            streamHandler = onEvent;
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    const events = [];
    engine.searchStream('q', {
        onStart: () => events.push('start'),
        onDelta: (chunk) => events.push({ type: 'delta', chunk }),
        onComplete: (data) => events.push({ type: 'complete', text: data.text, sources: data.sources }),
        onError: (err) => events.push({ type: 'error', code: err.code })
    });
    // Web search happened, provider got grounding context
    // Now stream the grounded answer
    if (streamHandler) {
        streamHandler({ type: 'start' });
        streamHandler({ type: 'delta', text: 'grounded answer' });
        streamHandler({ type: 'complete', result: { text: 'grounded answer', sources: [{ title: 'T', url: 'https://example.com', snippet: 's' }], grounded: true } });
    }
    const deltas = events.filter(e => e.type === 'delta');
    assert.ok(deltas.length > 0, 'should have streaming deltas');
    const complete = events.find(e => e.type === 'complete');
    assert.equal(complete.text, 'grounded answer');
    assert.ok(Array.isArray(complete.sources), 'sources should be an array');
});

test('stream E2: no sources → no empty Sources section', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['answer'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    assert.ok(got);
    assert.ok(!got.grounded, 'should not be grounded');
});

// ── §18.F: Provider error during streaming ──

test('stream F1: error before first text → error event', () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type: 'error', error: { code: 'auth_error', message: 'auth failed' } });
        }
    });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.searchStream('q', { onError: e => { err = e; } });
    assert.equal(err.code, 'auth_error');
});

test('stream F2: provider with no streamRequest falls back to non-streaming', () => {
    const provider = {
        request(payload, cancellable, cb) {
            cb(null, { type: 'answer', text: 'fallback answer' });
        },
        destroy() {}
        // No streamRequest method
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; }, onDelta: () => {} });
    assert.ok(got, 'fallback should deliver');
    assert.equal(got.type, 'answer');
    assert.equal(got.text, 'fallback answer');
});

// ── §18.G: Normal Search regression — streaming path never called ──

test('stream G1: search() not affected by streaming provider', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['streaming'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    // Non-streaming search should work via the mock's request() method
    assert.ok(got, 'search should deliver');
    assert.equal(got.type, 'answer');
});

// ── Edge cases ──

test('stream edge: empty query → error', () => {
    const provider = createMockStreamingAiProvider({ chunks: [] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.searchStream('', { onError: e => { err = e; } });
    assert.equal(err.code, 'invalid_response');
});

test('stream edge: streaming search with cancellable object', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['ok'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.searchStream('q', { onStart: () => {}, onDelta: () => {}, onComplete: d => { got = d; } });
    assert.ok(got);
});

test('stream edge: destroyed engine does not stream', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['late'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    engine.destroy();
    let delivered = false;
    engine.searchStream('q', { onComplete: () => { delivered = true; } });
    assert.equal(delivered, false);
});
