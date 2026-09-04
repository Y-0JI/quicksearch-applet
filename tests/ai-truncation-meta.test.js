// AI Orchestration follow-up audit — end-to-end completion metadata regression tests.
// Verifies finish_reason / truncated / cancelled / failed / stream-interruption lifecycle
// metadata survives the whole chain: streamParser -> provider -> engine -> conversation state.
// (No earlier test pinned finishReason/truncated through more than one layer.)
const { test } = require('node:test');
const assert = require('node:assert');
const { createStreamParser } = require('../ai/streamParser.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider, createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
const convMod = require('../ai/conversationState.js');
const { createNineRouterProvider } = require('../ai/nineRouterProvider.js');

function sseData(obj) {
    return 'data: ' + JSON.stringify(obj) + '\n\n';
}
function sseDelta(text) {
    return sseData({ choices: [{ delta: { content: text } }] });
}
function sseFinish(reason) {
    return sseData({ choices: [{ delta: {}, finish_reason: reason }] });
}

function makeWebTool() {
    return createMockWebSearchTool({ sources: [
        { title: 'Chelsea News', url: 'https://example.com/chelsea', snippet: 'fixture news' }
    ] });
}

// ── P2/P3: streamParser surfaces finish_reason on the complete event ──
test('streamParser: finish_reason=length -> complete.truncated true + finishReason kept', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    parser.feed(sseDelta('partial answer that got cut '));
    parser.feed(sseFinish('length'));
    parser.feed('data: [DONE]\n\n');
    const done = events.find(e => e.type === 'complete');
    assert.ok(done, 'complete event emitted');
    assert.strictEqual(done.result.finishReason, 'length');
    assert.strictEqual(done.result.truncated, true);
    assert.ok(done.result.text.includes('partial answer'));
});

test('streamParser: normal stop finish_reason -> truncated false', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    parser.feed(sseDelta('full answer '));
    parser.feed(sseFinish('stop'));
    parser.feed('data: [DONE]\n\n');
    const done = events.find(e => e.type === 'complete');
    assert.ok(done);
    assert.strictEqual(done.result.finishReason, 'stop');
    assert.strictEqual(done.result.truncated, false);
});

// ── P2/P3: engine streaming onComplete carries truncation metadata ──
test('engine streaming: provider complete(finishReason length) -> onComplete truncated true', async () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'jawaban terpotong' });
            onEvent({ type: 'complete', result: { text: 'jawaban terpotong', sources: [], grounded: false, finishReason: 'length', truncated: true } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: false });
    const got = await new Promise((resolve) => {
        engine.searchStream('q', null, {
            onComplete: d => resolve(d),
            onError: () => resolve(null)
        });
    });
    assert.ok(got, 'completed');
    assert.strictEqual(got.truncated, true, 'truncated propagated');
    assert.strictEqual(got.finishReason, 'length');
});

// ── P2/P3: engine non-streaming (search) preserves metadata on plain + grounded answers ──
test('engine non-streaming: plain truncated answer keeps finishReason/truncated', async () => {
    const provider = createMockAiProvider({
        responses: [{ type: 'answer', text: 'potong', finishReason: 'length', truncated: true }]
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: false });
    const got = await new Promise((resolve) => {
        engine.search('q', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got, 'answered');
    assert.strictEqual(got.truncated, true, 'truncated propagated on non-streaming answer');
    assert.strictEqual(got.finishReason, 'length');
});

test('engine non-streaming: grounded second-leg truncated answer keeps metadata', async () => {
    const calls = [];
    const provider = createMockAiProvider({
        responses: [
            { type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } },
            { type: 'answer', text: 'grounded potong', finishReason: 'length', truncated: true }
        ]
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: true });
    const got = await new Promise((resolve) => {
        engine.search('q', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got, 'grounded answer delivered');
    assert.strictEqual(got.text, 'grounded potong');
    assert.strictEqual(got.truncated, true, 'grounded truncated propagated');
    assert.strictEqual(got.finishReason, 'length');
    void calls;
});

// ── P3: nineRouter streaming transport keeps finish_reason from SSE ──
test('nineRouter streaming: finish_reason length in SSE -> complete event metadata', async () => {
    const chunks = [sseDelta('potong '), sseFinish('length'), 'data: [DONE]\n\n'];
    const httpStreamFetch = (url, opts, onChunk, onDone) => {
        let i = 0;
        function next() {
            if (i < chunks.length) { onChunk(chunks[i++]); setImmediate(next); }
            else onDone(null);
        }
        setImmediate(next);
    };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: 'k-test-meta', model: 'test-model', httpStreamFetch
    });
    const events = [];
    await new Promise((resolve) => {
        provider.streamRequest({ query: 'q' }, (evt) => {
            events.push(evt);
            if (evt.type === 'complete' || evt.type === 'error') setTimeout(resolve, 10);
        });
        setTimeout(resolve, 500);
    });
    const done = events.find(e => e.type === 'complete');
    assert.ok(done, 'complete emitted');
    assert.strictEqual(done.result.finishReason, 'length');
    assert.strictEqual(done.result.truncated, true);
});

// ── P3: conversation state lifecycle distinction ──
test('conversation: normal vs truncated vs cancelled vs failed lifecycle distinct', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Q1');
    convMod.completeAssistant(conv, s.assistantId, 'normal answer', []);
    s = convMod.rapidSend(conv, 'Q2');
    convMod.completeAssistant(conv, s.assistantId, 'potong', [], { finishReason: 'length', truncated: true });
    s = convMod.rapidSend(conv, 'Q3');
    convMod.updateAssistant(conv, s.assistantId, 'partial');
    convMod.cancelAssistant(conv, s.assistantId);
    s = convMod.rapidSend(conv, 'Q4');
    convMod.failAssistant(conv, s.assistantId, { code: 'provider_error' });

    const msgs = convMod.getMessages(conv);
    assert.strictEqual(msgs[1].status, 'complete');
    assert.strictEqual(msgs[1].truncated, false, 'normal answer not truncated');
    assert.strictEqual(msgs[3].status, 'complete');
    assert.strictEqual(msgs[3].truncated, true, 'token-limit answer truncated but completed');
    assert.strictEqual(msgs[3].finishReason, 'length');
    assert.strictEqual(msgs[5].status, 'cancelled', 'user cancel distinct');
    assert.ok(!msgs[5].truncated, 'cancel not flagged as truncation');
    assert.strictEqual(msgs[5].content, 'partial', 'partial kept visible');
    assert.strictEqual(msgs[7].status, 'error', 'provider error distinct');
    // cancelled + failed never become completed assistant history.
    // (Q4 is the current user message -> it is the live query, excluded from getHistory.)
    const history = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(history, [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'normal answer' },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: 'potong' },
        { role: 'user', content: 'Q3' }
    ]);
});

// ── P3: stream interruption (provider error mid-stream) -> engine error, not completed ──
test('engine streaming: provider error after deltas -> onError, no onComplete', async () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'some' });
            onEvent({ type: 'error', error: { code: 'network_error', message: 'connection lost' } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: false });
    const events = [];
    await new Promise((resolve) => {
        engine.searchStream('q', null, {
            onComplete: () => { events.push('complete'); resolve(); },
            onError: (e) => { events.push('error:' + e.code); resolve(); }
        });
    });
    assert.deepStrictEqual(events, ['error:network_error']);
});

// ── P2: nineRouter non-streaming parseResponseText keeps finish_reason ──
// ── P5 grounded second-leg edge cases: fallback keeps FIRST-response metadata ──
function fallbackProvider(firstAnswer) {
    // non-streaming provider: call1 returns a plain answer (live query), call2 (grounded
    // second leg) always fails -> engine falls back to the first answer + its metadata.
    return createMockAiProvider({
        handler: (payload, cb) => {
            if (payload && payload.groundingContext) {
                const e = new Error('second leg failed');
                e.code = 'provider_error';
                return cb(e);
            }
            return cb(null, firstAnswer);
        }
    });
}

function liveAnswer(text, meta) {
    const r = { type: 'answer', text };
    if (meta) { r.finishReason = meta.finishReason; r.truncated = !!meta.truncated; }
    return r;
}

// P3 (AI Pipeline V3): live/current queries are web-first — there is NO first ungrounded
// response to fall back to. On grounded-leg failure the existing error policy surfaces; the
// old "first answer + its metadata" fallback path no longer exists for live queries.
test('P5-CASE-C: live query + grounded failure -> error (no truncated-first fallback)', async () => {
    const engine = createAISearchEngine({
        provider: fallbackProvider(liveAnswer('first potong', { finishReason: 'length', truncated: true })),
        webSearchTool: makeWebTool(),
        enableGrounding: true
    });
    let errCode = null;
    const got = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: d => resolve(d), onError: (e) => { errCode = e && e.code; resolve(null); } });
    });
    assert.strictEqual(got, null, 'no ungrounded first-answer fallback for live queries');
    assert.strictEqual(errCode, 'provider_error', 'grounded failure surfaces via error policy');
});

test('P5-CASE-D: live query + grounded failure -> error (consistent, no hidden draft)', async () => {
    const engine = createAISearchEngine({
        provider: fallbackProvider(liveAnswer('first normal')),
        webSearchTool: makeWebTool(),
        enableGrounding: true
    });
    let errCode = null;
    const got = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: d => resolve(d), onError: (e) => { errCode = e && e.code; resolve(null); } });
    });
    assert.strictEqual(got, null, 'no answer delivered');
    assert.strictEqual(errCode, 'provider_error', 'grounded failure surfaces via error policy');
});

test('P5-CASE-A/B: grounded second-leg answer owns its own metadata (success path)', async () => {
    // CASE A: second synthesis normal -> truncated false, no leak from anywhere
    const calls = [];
    const provA = createMockAiProvider({
        responses: [
            { type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } },
            { type: 'answer', text: 'synthesis normal' }
        ]
    });
    const engA = createAISearchEngine({ provider: provA, webSearchTool: makeWebTool(), enableGrounding: true });
    const gotA = await new Promise((resolve) => {
        engA.search('q', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.strictEqual(gotA.truncated, false, 'normal synthesis not truncated');
    // CASE B: second synthesis truncated -> truncated true, finishReason from second response
    const provB = createMockAiProvider({
        responses: [
            { type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } },
            { type: 'answer', text: 'synthesis potong', finishReason: 'length', truncated: true }
        ]
    });
    const engB = createAISearchEngine({ provider: provB, webSearchTool: makeWebTool(), enableGrounding: true });
    const gotB = await new Promise((resolve) => {
        engB.search('q', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.strictEqual(gotB.text, 'synthesis potong');
    assert.strictEqual(gotB.truncated, true);
    assert.strictEqual(gotB.finishReason, 'length');
    void calls;
});

test('nineRouter non-streaming: length finish_reason parsed to answer meta', async () => {
    const httpFetch = (url, opts) => Promise.resolve({
        status: 200,
        bodyText: JSON.stringify({
            choices: [{ message: { content: 'potong' }, finish_reason: 'length' }]
        })
    });
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: 'k-test-meta2', model: 'test-model', httpFetch
    });
    const res = await new Promise((resolve, reject) => {
        provider.request({ query: 'q' }, (err, r) => err ? reject(err) : resolve(r));
    });
    assert.strictEqual(res.finishReason, 'length');
    assert.strictEqual(res.truncated, true);
});
