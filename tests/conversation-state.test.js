// Phase 8 — AI Chat UX & Interaction Lifecycle regression tests.
// Covers: conversation message model (§1/§2), multi-turn context (§3), history window (§4),
// streaming lifecycle (§5), cancel (§6/§7/§8), per-message sources (§10), rapid send (§12),
// reset (§13), and engine history threading.
const { test } = require('node:test');
const assert = require('node:assert');
const convMod = require('../ai/conversationState.js');
const promptBuilder = require('../ai/promptBuilder.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

function makeWebTool() {
    return createMockWebSearchTool({ sources: [
        { title: 'Chelsea News', url: 'https://example.com/chelsea', snippet: 'fixture' }
    ] });
}

// ---- 15.1 Conversation model / UI: history preserved, order kept ----
test('15.1 conversation keeps all messages and order', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'User A');
    convMod.completeAssistant(conv, s.assistantId, 'AI A', []);
    s = convMod.rapidSend(conv, 'User B');
    convMod.completeAssistant(conv, s.assistantId, 'AI B', []);
    const msgs = convMod.getMessages(conv);
    assert.strictEqual(msgs.length, 4);
    assert.strictEqual(msgs[0].role, 'user'); assert.strictEqual(msgs[0].content, 'User A');
    assert.strictEqual(msgs[1].role, 'assistant'); assert.strictEqual(msgs[1].content, 'AI A');
    assert.strictEqual(msgs[2].role, 'user'); assert.strictEqual(msgs[2].content, 'User B');
    assert.strictEqual(msgs[3].role, 'assistant'); assert.strictEqual(msgs[3].content, 'AI B');
    assert.ok(msgs.every(m => m.id && m.role && typeof m.timestamp === 'number' && m.status));
});

// ---- 15.2 Multi-turn context reaches the AI request ----
test('15.2a getHistory returns prior turns only, excluding current user + active assistant', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Apa itu Linux?');
    convMod.completeAssistant(conv, s.assistantId, 'Linux adalah kernel.', []);
    s = convMod.rapidSend(conv, 'Siapa pembuatnya?'); // assistant still streaming
    const history = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(history, [
        { role: 'user', content: 'Apa itu Linux?' },
        { role: 'assistant', content: 'Linux adalah kernel.' }
    ]);
    // current user message always included in the full context view
    const ctx = convMod.getContextMessages(conv, 10);
    assert.strictEqual(ctx.length, 3);
    assert.strictEqual(ctx[ctx.length - 1].role, 'user');
    assert.strictEqual(ctx[ctx.length - 1].content, 'Siapa pembuatnya?');
});

test('15.2b promptBuilder.buildHistoryMessages validates roles, drops empty, bounds window', () => {
    const raw = [
        { role: 'user', content: '  ' },          // empty -> dropped
        { role: 'system', content: 'nope' },      // system -> dropped
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A2' },
        null,                                      // junk -> dropped
        { role: 'user', content: 'U2' }
    ];
    const out = promptBuilder.buildHistoryMessages(raw, 10);
    assert.deepStrictEqual(out, [
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'U2' }
    ]);
    const bounded = promptBuilder.buildHistoryMessages(out, 2);
    assert.deepStrictEqual(bounded, [
        { role: 'assistant', content: 'A2' },
        { role: 'user', content: 'U2' }
    ]);
    assert.deepStrictEqual(promptBuilder.buildHistoryMessages(null, 10), []);
    assert.deepStrictEqual(promptBuilder.buildHistoryMessages([], 10), []);
});

test('15.2c engine attaches history to first AND second (grounded) provider payloads', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            if (payloads.length === 1) {
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'chelsea' } });
                return;
            }
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'grounded answer' });
            onEvent({ type: 'complete', result: { text: 'grounded answer', sources: [] } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: true });
    const history = [
        { role: 'user', content: 'Apa itu Linux?' },
        { role: 'assistant', content: 'Linux adalah kernel.' }
    ];
    const events = [];
    await new Promise((resolve) => {
        engine.searchStream('Jadwal chelsea?', null, {
            onComplete: (d) => { events.push(['complete', d]); resolve(); },
            onError: (e) => { events.push(['error', e]); resolve(); }
        }, { history });
    });
    assert.strictEqual(payloads.length, 2, 'first leg + grounded second leg');
    assert.deepStrictEqual(payloads[0].history, history, 'history on first leg');
    assert.deepStrictEqual(payloads[1].history, history, 'history on grounded second leg');
    assert.strictEqual(events[0][0], 'complete');
    assert.strictEqual(events[0][1].text, 'grounded answer');
});

// ---- 15.3 Streaming: one assistant message, chunks update it in place ----
test('15.3 streaming updates a single assistant message; no duplicates', () => {
    const conv = convMod.createConversation();
    const user = convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    assert.strictEqual(convMod.getMessages(conv).length, 2);
    convMod.updateAssistant(conv, aId, 'Hel');
    convMod.updateAssistant(conv, aId, 'Hello');
    convMod.updateAssistant(conv, aId, 'Hello world');
    let msgs = convMod.getMessages(conv);
    assert.strictEqual(msgs.length, 2, 'still exactly one assistant message');
    assert.strictEqual(msgs[1].content, 'Hello world');
    assert.strictEqual(msgs[1].status, 'streaming');
    convMod.completeAssistant(conv, aId, 'Hello world final', []);
    msgs = convMod.getMessages(conv);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].status, 'complete');
    assert.strictEqual(msgs[1].content, 'Hello world final');
    assert.strictEqual(convMod.hasActive(conv), false);
    assert.strictEqual(user, msgs[0].id);
});

// ---- 15.4 Cancel first AI request: late chunks ignored, message stays cancelled ----
test('15.4 cancel first request blocks late chunks and keeps partial content', () => {
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Explain X');
    const aId = convMod.appendAssistant(conv);
    convMod.updateAssistant(conv, aId, 'partial resp');
    assert.strictEqual(convMod.cancelAssistant(conv, aId), true);
    // late chunks must not modify the cancelled message
    assert.strictEqual(convMod.updateAssistant(conv, aId, 'LATE CHUNK'), false);
    assert.strictEqual(convMod.completeAssistant(conv, aId, 'LATE COMPLETE', []), false);
    const m = convMod.getMessages(conv)[1];
    assert.strictEqual(m.status, 'cancelled');
    assert.strictEqual(m.content, 'partial resp');
    assert.strictEqual(convMod.hasActive(conv), false);
});

// ---- 15.5 Cancel during web search: no grounding, no second request ----
test('15.5 cancel during pending web search prevents grounded second request', async () => {
    let webCalled = 0;
    let secondLeg = 0;
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            if (payload.groundingContext) secondLeg++;
            onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        }
    });
    const held = {};
    const webTool = {
        search: (req, cancellable, cb) => {
            webCalled++;
            held.cb = cb;
            held.cancellable = cancellable;
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true });
    const events = [];
    await new Promise((resolve) => {
        engine.searchStream('live query', null, {
            onComplete: (d) => { events.push(['complete', d]); resolve(); },
            onError: (e) => { events.push(['error', e]); resolve(); }
        });
        // user presses Stop while web search is pending
        engine.cancel();
        // web search completes late — must NOT continue to grounding
        held.cb(null, { type: 'tool_result', query: 'x', sources: [{ title: 'T', url: 'https://example.com', snippet: 's' }] });
        setTimeout(resolve, 20);
    });
    assert.strictEqual(webCalled, 1);
    assert.strictEqual(secondLeg, 0, 'no grounded second AI request after cancel');
    assert.strictEqual(events.length, 0, 'no late completion delivered');
});

// ---- 15.6 Cancel grounded AI request: late chunks ignored ----
test('15.6 cancel grounded response drops late chunks (conversation + engine)', async () => {
    // conversation level
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.updateAssistant(conv, aId, 'grounded...');
    assert.strictEqual(convMod.cancelAssistant(conv, aId), true);
    assert.strictEqual(convMod.updateAssistant(conv, aId, 'LATE'), false);
    // engine level: cancel mid-stream -> no further onDelta/onComplete
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'a' });
            setTimeout(() => {
                onEvent({ type: 'delta', text: 'b' });
                onEvent({ type: 'complete', result: { text: 'ab', sources: [] } });
            }, 5);
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: false });
    const events = [];
    await new Promise((resolve) => {
        engine.searchStream('q', null, {
            onDelta: () => events.push('delta'),
            onComplete: () => events.push('complete'),
            onError: () => events.push('error')
        });
        setTimeout(() => { engine.cancel(); }, 1);
        setTimeout(resolve, 30);
    });
    assert.ok(!events.includes('complete'), 'no complete after cancel');
});

// ---- 15.7 Source ownership: sources cannot migrate between messages ----
test('15.7 sources stay attached to the assistant message that produced them', () => {
    const conv = convMod.createConversation();
    const srcA = [{ title: 'A1', url: 'https://a.example/1', snippet: 'a' }];
    const srcB = [{ title: 'B1', url: 'https://b.example/1', snippet: 'b' }];
    let s = convMod.rapidSend(conv, 'Q1');
    convMod.completeAssistant(conv, s.assistantId, 'Answer A', srcA);
    s = convMod.rapidSend(conv, 'Q2');
    convMod.completeAssistant(conv, s.assistantId, 'Answer B', srcB);
    const msgs = convMod.getMessages(conv);
    assert.deepStrictEqual(msgs[1].sources, srcA);
    assert.deepStrictEqual(msgs[3].sources, srcB);
    // completing B must not mutate A
    assert.deepStrictEqual(msgs[1].sources, srcA);
});

// ---- 15.8 Rapid query: cancel current, preserve partial, append new, start new ----
test('15.8 rapidSend cancels active with partial preserved and opens the new request', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Request A');
    const aIdA = s.assistantId;
    convMod.updateAssistant(conv, aIdA, 'partial A');
    s = convMod.rapidSend(conv, 'Request B');
    const aIdB = s.assistantId;
    const msgs = convMod.getMessages(conv);
    assert.strictEqual(msgs.length, 4);
    const a = msgs[1];
    assert.strictEqual(a.status, 'cancelled', 'A preserved as cancelled');
    assert.strictEqual(a.content, 'partial A', 'partial A kept');
    assert.strictEqual(msgs[2].role, 'user'); assert.strictEqual(msgs[2].content, 'Request B');
    assert.strictEqual(msgs[3].status, 'streaming');
    assert.strictEqual(convMod.hasActive(conv), true);
    // late A output cannot touch B or appear after B
    assert.strictEqual(convMod.updateAssistant(conv, aIdA, 'LATE A'), false);
    convMod.updateAssistant(conv, aIdB, 'B output');
    assert.strictEqual(convMod.getMessages(conv)[1].content, 'partial A');
    assert.strictEqual(convMod.getMessages(conv)[3].content, 'B output');
});

// ---- 15.9 Reset conversation ----
test('15.9 reset clears messages, active state, and old sources', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Q');
    convMod.completeAssistant(conv, s.assistantId, 'A', [{ title: 'T', url: 'https://example.com', snippet: 's' }]);
    s = convMod.rapidSend(conv, 'Q2'); // active
    assert.ok(convMod.count(conv) > 0);
    convMod.reset(conv);
    assert.strictEqual(convMod.count(conv), 0);
    assert.strictEqual(convMod.hasActive(conv), false);
    assert.strictEqual(convMod.getActiveId(conv), null);
    // next request starts clean
    s = convMod.rapidSend(conv, 'Fresh');
    assert.strictEqual(convMod.getMessages(conv).length, 2);
});

// ---- §4 history window: bounded, ordered, current user always included ----
test('history window bounds to limit and preserves role ordering', () => {
    const conv = convMod.createConversation();
    for (let i = 0; i < 12; i++) {
        const s = convMod.rapidSend(conv, 'U' + i);
        convMod.completeAssistant(conv, s.assistantId, 'A' + i, []);
    }
    // 12 turns = 24 messages; history cuts before current user msg (U11) and keeps last 10 -> U6..A10
    const hist = convMod.getHistory(conv, 10);
    assert.strictEqual(hist.length, 10);
    assert.strictEqual(hist[0].role, 'user');
    assert.strictEqual(hist[0].content, 'U6');
    assert.strictEqual(hist[hist.length - 1].content, 'A10');
    // alternating roles preserved
    for (let i = 0; i < hist.length; i++) {
        assert.strictEqual(hist[i].role, i % 2 === 0 ? 'user' : 'assistant');
    }
});

// ---- cancelled/error assistant turns are not sent as context ----
test('cancelled and error assistant messages are excluded from history', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Q1');
    convMod.cancelAssistant(conv, s.assistantId);
    s = convMod.rapidSend(conv, 'Q2');
    convMod.failAssistant(conv, s.assistantId, { code: 'provider_error' });
    s = convMod.rapidSend(conv, 'Q3');
    convMod.completeAssistant(conv, s.assistantId, 'Good answer', []);
    // history = prior turns only (Q3 is the live current query); cancelled A1 and failed A2 excluded
    const hist = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(hist, [
        { role: 'user', content: 'Q1' },
        { role: 'user', content: 'Q2' }
    ]);
    // full context view always includes the current user message
    const ctx = convMod.getContextMessages(conv, 10);
    assert.deepStrictEqual(ctx, [
        { role: 'user', content: 'Q1' },
        { role: 'user', content: 'Q2' },
        { role: 'user', content: 'Q3' }
    ]);
});

// ---- §8/§9 status model: cancelled and error states ----
test('failAssistant attaches sanitized error and preserves history', () => {
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.updateAssistant(conv, aId, 'partial');
    assert.strictEqual(convMod.failAssistant(conv, aId, { code: 'no_results', stage: 'web_search_normalize', message: 'x' }), true);
    const m = convMod.getMessages(conv)[1];
    assert.strictEqual(m.status, 'error');
    assert.deepStrictEqual(m.error, { code: 'no_results', stage: 'web_search_normalize', message: 'x' });
    assert.strictEqual(convMod.hasActive(conv), false);
    assert.strictEqual(convMod.getMessages(conv).length, 2, 'history intact');
    // terminal states are immutable
    assert.strictEqual(convMod.cancelAssistant(conv, aId), false);
    assert.strictEqual(convMod.updateAssistant(conv, aId, 'late'), false);
});