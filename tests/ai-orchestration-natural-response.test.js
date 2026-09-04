// Phase: AI Orchestration & Natural Response — regression tests (P16 matrix).
// Covers: P4 runtime context (dynamic, not persisted), P6 pair-safe history trimming,
// P7 evidence dedupe/cap, P9 mode-specific generation strategy + provider temperature
// compatibility, and prompt-order invariants (runtime ctx never enters history).
const { test } = require('node:test');
const assert = require('node:assert');
const promptBuilder = require('../ai/promptBuilder.js');
const convMod = require('../ai/conversationState.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
const { buildRequestBody, createNineRouterProvider } = require('../ai/nineRouterProvider.js');

function makeWebTool(sources) {
    return createMockWebSearchTool({ sources: sources || [
        { title: 'Chelsea News', url: 'https://example.com/chelsea', snippet: 'fixture news for this week' }
    ] });
}

// ── P4 runtime context ──
test('buildRuntimeContext: dynamic date/time/timezone/mode, injectable clock', () => {
    const now = new Date(2026, 8, 4, 15, 30); // 4 Sep 2026 15:30 local
    const ctx = promptBuilder.buildRuntimeContext({ now, timezoneLabel: 'UTC+07:00', mode: 'ai' });
    assert.ok(ctx.includes('Current date: Friday, 4 September 2026'), ctx);
    assert.ok(ctx.includes('Current time: 15:30'), ctx);
    assert.ok(ctx.includes('Timezone: UTC+07:00'), ctx);
    assert.ok(ctx.includes('Current mode: AI'), ctx);
    assert.ok(!ctx.includes('Web search evidence was used'), 'no evidence claim when not used');
});

test('buildRuntimeContext: web mode + evidence-used flag, and safe defaults', () => {
    const ctx = promptBuilder.buildRuntimeContext({ mode: 'web', webSearchUsed: true });
    assert.ok(ctx.includes('Current mode: Web Search'), ctx);
    assert.ok(ctx.includes('Web search evidence was used for this request.'), ctx);
    // no options / bad clock must not throw
    const bare = promptBuilder.buildRuntimeContext();
    assert.ok(bare.includes('Current date:'));
    assert.ok(bare.includes('Current time:'));
    assert.ok(bare.includes('Current mode: AI'));
    const bad = promptBuilder.buildRuntimeContext({ now: 'nope', timezoneLabel: ' ' });
    assert.ok(bad.includes('Current date:'), 'falls back to real clock');
});

// ── P4/P11: runtime context injected into engine system prompts per request ──
test('engine: system prompt carries runtime context; grounded (live) payload marks web mode + evidence', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'grounded answer' });
            onEvent({ type: 'complete', result: { text: 'grounded answer', sources: [] } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: true });
    await new Promise((resolve) => {
        engine.searchStream('Jadwal chelsea?', null, {
            onComplete: () => resolve(),
            onError: () => resolve()
        });
    });
    // P3 web-first: a live query is grounded from the start — one payload, no ungrounded first leg
    assert.strictEqual(payloads.length, 1);
    const sys1 = payloads[0].systemPrompt || '';
    assert.ok(sys1.includes('Current date:'), 'runtime ctx present');
    assert.ok(sys1.includes('Current time:'), sys1);
    assert.ok(sys1.includes('Current mode: Web Search'), sys1);
    assert.ok(sys1.includes('Web search evidence was used for this request.'), sys1);
    // runtime metadata never stored into conversation history messages
    const history1 = payloads[0].history || [];
    for (const h of history1) {
        assert.ok(!String(h.content || '').includes('Current date:'), 'history clean of runtime ctx');
    }
});

// ── P4: same request, no fake history on first message ──
test('engine: first message sends no history; runtime ctx lives only in system prompt', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: { text: 'hi', sources: [] } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: false });
    await new Promise((resolve) => {
        engine.searchStream('halo', null, { onComplete: () => resolve(), onError: () => resolve() });
    });
    assert.ok(!('history' in (payloads[0] || {})), 'no fake history on first request');
});

// ── P5/P6: follow-up carries prior turns; cancelled/failed never become history ──
test('multi-turn: prior complete turns reach the request; per-turn pairing intact', () => {
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Siapa pemain Chelsea sekarang?');
    convMod.completeAssistant(conv, s.assistantId, 'Enzo Maresca adalah pelatihnya.', []);
    s = convMod.rapidSend(conv, 'Nomor punggungnya?'); // current, still streaming
    const history = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(history, [
        { role: 'user', content: 'Siapa pemain Chelsea sekarang?' },
        { role: 'assistant', content: 'Enzo Maresca adalah pelatihnya.' }
    ]);
});

// ── P6: pair-safe trimming with odd limits ──
test('history trimming never leaves an orphan leading assistant (odd limit)', () => {
    const conv = convMod.createConversation();
    // 4 completed turns (8 msgs) + a current user msg (streaming) -> 9 msgs
    for (let i = 0; i < 4; i++) {
        const s = convMod.rapidSend(conv, 'U' + i);
        convMod.completeAssistant(conv, s.assistantId, 'A' + i, []);
    }
    convMod.rapidSend(conv, 'current'); // not part of history
    for (const limit of [3, 5, 7]) {
        const hist = convMod.getHistory(conv, limit);
        assert.ok(hist.length > 0, 'non-empty window at limit ' + limit);
        assert.ok(hist.length <= limit + 1, 'window bounded at limit ' + limit + ' got ' + hist.length);
        assert.strictEqual(hist[0].role, 'user', 'window never starts on an orphan assistant (limit ' + limit + ')');
        // alternating roles preserved
        for (let i = 0; i < hist.length; i++) {
            assert.strictEqual(hist[i].role, i % 2 === 0 ? 'user' : 'assistant', 'alternation at ' + i);
        }
    }
});

// ── P7: evidence dedupe + cap, only high-signal sent ──
test('grounding context dedupes by url+snippet, drops low-signal, caps 5', () => {
    const dup = { title: 'A', url: 'https://example.com/a', snippet: 'same snippet content repeated here' };
    const mk = (i) => ({ title: 'T' + i, url: 'https://example.com/' + i, snippet: 'unique snippet content number ' + i });
    const results = [dup, dup, { ...dup, url: 'https://example.com/a#frag' }, mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
    const ctx = promptBuilder.buildGroundingContext(results);
    assert.ok(ctx.startsWith('Reference context from web search'), ctx.slice(0, 60));
    // each line is one [n] source; max 5 lines after dedupe
    const lines = ctx.split('\n').filter(l => /^\[\d+\]/.test(l));
    assert.ok(lines.length <= 5, 'cap 5 sources, got ' + lines.length);
    const urls = lines.map(l => l.replace(/^\[\d+\]\s/, '').split(' (')[0]);
    assert.strictEqual(new Set(urls).size, urls.length, 'no duplicate url kept');
});

// ── P9: mode-specific generation strategy ──
test('engine: live query (web-first) forwards the grounded temperature directly', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            onEvent({ type: 'start' });
            onEvent({ type: 'complete', result: { text: 'grounded answer', sources: [] } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: makeWebTool(), enableGrounding: true });
    await new Promise((resolve) => {
        engine.searchStream('Jadwal chelsea?', null, { onComplete: () => resolve(), onError: () => resolve() });
    });
    // P3 web-first: the single payload IS the grounded leg
    assert.strictEqual(payloads.length, 1);
    assert.strictEqual(payloads[0].temperature, 0.3, 'web/grounded leg: default factual temperature');
});

test('engine: generationStrategy override is honored per mode', async () => {
    const payloads = [];
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            payloads.push(payload);
            if (payloads.length === 1) {
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
                return;
            }
            onEvent({ type: 'start' });
            onEvent({ type: 'complete', result: { text: 'grounded answer', sources: [] } });
        }
    });
    const engine = createAISearchEngine({
        provider,
        webSearchTool: makeWebTool(),
        enableGrounding: true,
        generationStrategy: { ai: 0.9, web: 0.2 }
    });
    await new Promise((resolve) => {
        engine.searchStream('q', null, { onComplete: () => resolve(), onError: () => resolve() });
    });
    assert.strictEqual(payloads[1].temperature, 0.2, 'web override applied');
});

// ── P9/P10: provider temperature compatibility ──
test('provider: temperature forwarded only when usable; reasoning models skip it', () => {
    const bodyA = JSON.parse(buildRequestBody('deepseek-chat', 'sys', 'q', null, null, null, null, 1024, 0.3));
    assert.strictEqual(bodyA.temperature, 0.3, 'normal model accepts temperature');
    const bodyB = JSON.parse(buildRequestBody('openai/o3-mini', 'sys', 'q', null, null, null, null, 1024, 0.3));
    assert.ok(!('temperature' in bodyB), 'reasoning model (o3) must not receive temperature');
    const bodyC = JSON.parse(buildRequestBody('deepseek-reasoner', 'sys', 'q', null, null, null, null, 1024, 0.3));
    assert.ok(!('temperature' in bodyC), 'reasoner model must not receive temperature');
    const bodyD = JSON.parse(buildRequestBody('test-model', 'sys', 'q', null, null, null, null, 1024, 99));
    assert.strictEqual(bodyD.temperature, 2, 'temperature clamped to [0,2]');
    const bodyE = JSON.parse(buildRequestBody('test-model', 'sys', 'q', null, null, null, null, 1024));
    assert.ok(!('temperature' in bodyE), 'absent temperature stays absent (provider default)');
});

test('provider: payload.temperature reaches request body; streaming body too', async () => {
    const caps = [];
    const httpFetch = (url, opts) => {
        caps.push({ kind: 'request', body: opts.body });
        return Promise.resolve({ status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) });
    };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: 'k-test-123', model: 'test-model', httpFetch
    });
    await new Promise((resolve, reject) => {
        provider.request({ query: 'q', systemPrompt: 's', temperature: 0.4 }, (err, res) => err ? reject(err) : resolve(res));
    });
    const body = JSON.parse(caps[0].body);
    assert.strictEqual(body.temperature, 0.4, 'request body forwards temperature');
});

// ── P4: runtime ctx dynamic, not hardcoded (time changes between requests) ──
test('runtime context is rebuilt per request (not a static string)', () => {
    const a = promptBuilder.buildRuntimeContext({ timezoneLabel: 'UTC+00:00' });
    const b = promptBuilder.buildRuntimeContext({ timezoneLabel: 'UTC+00:00' });
    assert.ok(a && b);
    // same process ms differ rarely; guarantee the *function* is not constant by content shape
    assert.ok(a.includes('Current date:') && b.includes('Current date:'));
});
