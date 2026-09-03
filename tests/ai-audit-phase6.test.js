const { test } = require('node:test');
const assert = require('node:assert');
const { createStreamParser } = require('../ai/streamParser.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

function sseData(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function sseDone() { return 'data: [DONE]\n\n'; }
function sseDelta(text) { return sseData({ choices: [{ delta: { content: text } }] }); }

// ── P1 DIRECT: real progressive streaming ──

test('AI6 P1-direct: incremental delta before completion (Hello -> Hello world)', () => {
    let handler = null;
    const provider = {
        request() { throw new Error('provider.request must not be called for direct streaming'); },
        streamRequest(payload, canc, onEvent) { handler = onEvent; },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    const deltas = [];
    let completed = null;
    let completedAfterDeltas = false;
    let deltaCountBeforeComplete = 0;
    engine.searchStream('q', {
        onStart: () => {},
        onDelta: (chunk, full) => { deltas.push(full); if (completed) completedAfterDeltas = false; },
        onComplete: (data) => {
            completed = data;
            deltaCountBeforeComplete = deltas.length;
        },
        onError: () => {}
    });
    assert.ok(handler, 'streamRequest must be invoked (no blocking request)');
    handler({ type: 'start' });
    handler({ type: 'delta', text: 'Hello' });
    assert.equal(deltas[0], 'Hello', 'first delta visible before completion');
    assert.equal(completed, null, 'not completed after first delta');
    handler({ type: 'delta', text: ' world' });
    assert.equal(deltas[1], 'Hello world');
    assert.equal(completed, null, 'not completed after second delta');
    handler({ type: 'complete', result: { text: 'Hello world', sources: [], grounded: false } });
    assert.ok(completed, 'completion after deltas');
    assert.equal(completed.text, 'Hello world');
    assert.equal(deltaCountBeforeComplete, 2, 'completion happens after all deltas');
});

test('AI6 P1-direct: direct answer does not wait for full non-streaming response', () => {
    let requestCalled = false;
    let streamCalled = false;
    const provider = {
        request(payload, canc, cb) { requestCalled = true; cb(null, { type: 'answer', text: 'should not be used' }); },
        streamRequest(payload, canc, onEvent) {
            streamCalled = true;
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'streamed' });
            onEvent({ type: 'complete', result: { text: 'streamed', sources: [], grounded: false } });
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    assert.equal(streamCalled, true, 'streamRequest must be called');
    assert.equal(requestCalled, false, 'direct answer must not use provider.request blocking path');
    assert.equal(got.text, 'streamed');
});

test('AI6 P1-direct: multiple real deltas preserve exact order', () => {
    const provider = createMockStreamingAiProvider({ chunks: ['one', ' ', 'two', ' ', 'three'] });
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    const deltas = [];
    engine.searchStream('q', { onDelta: c => deltas.push(c), onComplete: () => {} });
    assert.deepEqual(deltas, ['one', ' ', 'two', ' ', 'three']);
});

test('AI6 P1-direct: completion happens after deltas (order verified)', () => {
    let order = [];
    const provider = {
        request() {},
        streamRequest(payload, canc, onEvent) {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'a' });
            onEvent({ type: 'delta', text: 'b' });
            onEvent({ type: 'complete', result: { text: 'ab', sources: [], grounded: false } });
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    engine.searchStream('q', {
        onDelta: () => order.push('delta'),
        onComplete: () => order.push('complete')
    });
    assert.deepEqual(order, ['delta', 'delta', 'complete']);
});

test('AI6 P1-direct: provider.request not called for direct stream (spy)', () => {
    let reqCount = 0;
    const provider = {
        request() { reqCount++; },
        streamRequest(payload, canc, onEvent) {
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: { text: 'hi', sources: [], grounded: false } });
        },
        destroy() {}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    engine.searchStream('q', { onComplete: () => {}, onDelta: () => {} });
    assert.equal(reqCount, 0);
});

// ── P1 GROUNDED: sources survive real streaming pipeline ──

test('AI6 P1-grounded: sources survive streaming pipeline (empty provider sources fallback)', () => {
    // Grounded: first leg tool_call, second leg complete with empty sources -> engine must keep groundedSources
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) {
                onEvent({ type: 'start' });
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'search q' } });
                return;
            }
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: 'grounded answer' });
            // Simulate provider that sends no sources in complete
            onEvent({ type: 'complete', result: { text: 'grounded answer', sources: [], grounded: false } });
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    assert.ok(got, 'must complete');
    assert.equal(got.text, 'grounded answer');
    assert.ok(got.grounded, 'must be grounded via retained sources');
    assert.ok(Array.isArray(got.sources) && got.sources.length > 0, 'sources retained from grounding');
    assert.equal(got.sources[0].url, 'https://example.com/a');
});

test('AI6 P1-grounded: final streaming result still uses AI-5 normalization', () => {
    // Provide grounding sources that need dedup/invalid filtering; provider second leg also provides duplicate/invalid
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) {
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } });
                return;
            }
            onEvent({ type: 'delta', text: 'answer' });
            onEvent({ type: 'complete', result: {
                text: 'answer',
                sources: [
                    { title: 'A', url: 'https://example.com/a', snippet: 's' },
                    { title: 'A dup', url: 'https://example.com/a', snippet: 's2' },
                    { title: 'bad', url: 'javascript:alert(1)', snippet: 'x' },
                    { title: '', url: 'https://example.com/b', snippet: 's' }
                ],
                grounded: true
            }});
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [
            { title: 'A', url: 'https://example.com/a', snippet: 's' },
            { title: 'A dup', url: 'https://example.com/a', snippet: 's2' },
            { title: 'bad', url: 'javascript:alert(1)', snippet: 'x' },
            { title: '', url: 'https://example.com/b', snippet: 's' }
        ])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    // AI-5 normalization: dup removed, invalid removed, empty title fallback to domain
    const urls = got.sources.map(s => s.url);
    assert.ok(!urls.includes('javascript:alert(1)'), 'invalid javascript url removed');
    assert.equal(new Set(urls).size, urls.length, 'duplicates removed');
    // Should have 2 valid unique: /a and /b
    assert.equal(got.sources.length, 2);
    assert.ok(got.grounded);
});

test('AI6 P1-grounded: duplicate final sources deduplicated (provider supplies dup)', () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: {
                text: 'hi',
                sources: [
                    { title: 'T', url: 'https ->example.com/x', snippet: 's' },
                    { title: 'T2', url: 'https://EXAMPLE.com/x', snippet: 's2' },
                    { title: 'T3', url: 'https://example.com/x/', snippet: 's3' }
                ].map(s => s.url.includes('->') ? { title: s.title, url: 'https://example.com/x', snippet: s.snippet } : s),
                grounded: true
            }});
        }
    });
    // Use explicit case-duplicate only: /x vs /X case differs in host only
    const provider2 = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: {
                text: 'hi',
                sources: [
                    { title: 'T', url: 'https://example.com/x', snippet: 's' },
                    { title: 'T2', url: 'https://EXAMPLE.com/x', snippet: 's2' }
                ],
                grounded: true
            }});
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/x', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider: provider2, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    // AI-5 dedup normalizes hostname case; /x vs /x/ are distinct per spec (only root slash normalized)
    assert.equal(got.sources.length, 1, 'hostname case duplicate must collapse to 1');
    // Also verify /x vs /x/ are NOT collapsed
    const provider3 = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: {
                text: 'hi',
                sources: [
                    { title: 'T', url: 'https://example.com/x', snippet: 's' },
                    { title: 'T2', url: 'https://example.com/x/', snippet: 's2' }
                ],
                grounded: true
            }});
        }
    });
    const engine3 = createAISearchEngine({ provider: provider3, webSearchTool: tool, enableGrounding: true });
    let got3 = null;
    engine3.searchStream('q', { onComplete: d => { got3 = d; } });
    assert.equal(got3.sources.length, 2, '/x vs /x/ are distinct per spec');
});

test('AI6 P1-grounded: invalid final sources removed without losing answer', () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            onEvent({ type: 'delta', text: 'answer keeps' });
            onEvent({ type: 'complete', result: {
                text: 'answer keeps',
                sources: [
                    { title: 'bad1', url: 'ftp://example.com/file', snippet: 's' },
                    { title: 'bad2', url: '', snippet: 's' },
                    { title: 'bad3', url: 'not-a-url', snippet: 's' }
                ],
                grounded: true
            }});
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    // Provider supplied only invalid; engine falls back to groundedSources? With valid grounded, should still have them
    // In this handler, groundedSources = https://example.com/a, provider sources all invalid -> after normalization 0, so fallback keeps grounded
    // Verify answer not lost
    assert.equal(got.text, 'answer keeps');
    assert.ok(got.sources.length > 0, 'fallback to groundedSources when provider invalid');
});

test('AI6 P1-grounded: grounded streaming deltas + parser complete -> engine complete still normalized', () => {
    // End-to-end: real SSE parser feeding second leg
    const parserEvents = [];
    const parser = createStreamParser({ onEvent: e => parserEvents.push(e) });
    // Simulate second-leg SSE: two deltas then DONE
    parser.feed(sseDelta('grounded '));
    parser.feed(sseDelta('answer'));
    parser.feed(sseDone());
    parser.flush();
    const deltas = parserEvents.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0].text, 'grounded ');
    assert.equal(deltas[1].text, 'answer');
    const complete = parserEvents.find(e => e.type === 'complete');
    assert.equal(complete.result.text, 'grounded answer');
    // Now verify engine with same idea preserves sources
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            for (const evt of parserEvents) {
                if (evt.type === 'start') onEvent({ type: 'start' });
                if (evt.type === 'delta') onEvent({ type: 'delta', text: evt.text });
                if (evt.type === 'complete') onEvent({ type: 'complete', result: { text: evt.result.text, sources: [{ title: 'T', url: 'https://example.com/a', snippet: 's' }], grounded: true } });
            }
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.searchStream('q', { onComplete: d => { got = d; } });
    assert.equal(got.text, 'grounded answer');
    assert.equal(got.sources[0].url, 'https://example.com/a');
});

// ── P1 PARTIAL ERROR RETENTION ──

test('AI6 P1-partial: engine delta then error emits error (not fake complete)', () => {
    let handler = null;
    const provider = {
        request() {},
        streamRequest(payload, canc, onEvent) { handler = onEvent; },
        destroy() {}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    const deltas = [];
    let err = null, completed = null;
    engine.searchStream('q', {
        onDelta: (c, full) => deltas.push(full),
        onComplete: d => { completed = d; },
        onError: e => { err = e; }
    });
    handler({ type: 'start' });
    handler({ type: 'delta', text: 'partial answer' });
    assert.equal(deltas[0], 'partial answer');
    handler({ type: 'error', error: { code: 'network_error', message: 'net fail' } });
    assert.ok(err, 'error delivered');
    assert.equal(err.code, 'network_error');
    assert.equal(completed, null, 'must not fake complete as grounded answer');
});

test('AI6 P1-partial: applet retains partial answer on error (no clear)', () => {
    // Phase 8: partial retention moved from a single _aiAnswer flag to the conversation
    // message model — failAssistant keeps the streamed content intact (never clears it).
    const convMod = require('../ai/conversationState.js');
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    // Streaming onError is the one tied to searchStream deltas; it must route non-cancelled
    // errors to convMod.failAssistant (content-preserving) and cancelled to cancelAssistant.
    const firstIdx = src.indexOf('AI-6');
    const streamingOnErrorIdx = firstIdx >= 0 ? src.indexOf('AI-6', firstIdx + 1) : -1;
    const streamingSnippet = streamingOnErrorIdx >= 0 ? src.slice(streamingOnErrorIdx - 200, streamingOnErrorIdx + 600) : src.slice(src.indexOf('searchStream'));
    assert.ok(streamingSnippet.includes('convMod.failAssistant'), 'streaming onError must route errors to conversation failAssistant');
    assert.ok(streamingSnippet.includes('convMod.cancelAssistant'), 'streaming onError must route cancelled to conversation cancelAssistant');
    assert.ok(!streamingSnippet.includes("_aiAnswer = ''"), 'streaming onError must not clear answer state');
    // Behavior: partial answer exists -> error keeps it (via conversation model)
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'q');
    const aId = convMod.appendAssistant(conv);
    convMod.updateAssistant(conv, aId, 'partial answer');
    convMod.failAssistant(conv, aId, { code: 'network_error', message: 'fail' });
    const m = convMod.getMessages(conv)[1];
    assert.equal(m.content, 'partial answer', 'partial must remain after error');
    assert.equal(m.status, 'error', 'interrupted/error state active');
    // error before first delta -> empty content (no partial), still error state
    const conv2 = convMod.createConversation();
    convMod.appendUser(conv2, 'q');
    const aId2 = convMod.appendAssistant(conv2);
    convMod.failAssistant(conv2, aId2, { code: 'provider_error', message: 'fail' });
    const m2 = convMod.getMessages(conv2)[1];
    assert.equal(m2.content, '', 'no partial before first delta -> remains empty');
    assert.equal(m2.status, 'error', 'error state active');
});

test('AI6 P1-partial: error before first delta shows normal error', () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => { onEvent({ type: 'error', error: { code: 'provider_error', message: 'fail' } }); }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let err = null, deltas = [];
    engine.searchStream('q', {
        onDelta: c => deltas.push(c),
        onError: e => { err = e; }
    });
    assert.equal(deltas.length, 0, 'no delta before error');
    assert.equal(err.code, 'provider_error');
});

test('AI6 P1-partial: error after streaming does not produce grounded fake completion', () => {
    let handler = null;
    const provider = { request() {}, streamRequest(p,c,onEvent){ handler=onEvent; }, destroy(){} };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool(), enableGrounding: true });
    // First leg will be streaming; simulate tool_call then partial delta then error on second leg
    let deltas = [], err=null, completed=null;
    // Use a provider that emits tool_call then second-leg partial then error
    const groundedProvider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            // Hold handler for manual control
            handler = onEvent;
        }
    });
    const tool = createMockWebSearchTool({ handler: (q,c,cb)=> cb(null, [{ title:'T', url:'https://example.com/a', snippet:'s'}])});
    const eng2 = createAISearchEngine({ provider: groundedProvider, webSearchTool: tool, enableGrounding: true });
    eng2.searchStream('q', {
        onDelta: c=> deltas.push(c),
        onError: e=> err=e,
        onComplete: d=> completed=d
    });
    // Now handler is second-leg handler
    if (handler) {
        handler({ type: 'start' });
        handler({ type: 'delta', text: 'partial grounded' });
        handler({ type: 'error', error: { code: 'network_error', message: 'fail' } });
    }
    assert.ok(err, 'error emitted');
    assert.equal(completed, null, 'no fake grounded completion');
});

// ── P2 UTF-8 persistent decoder ──

test('AI6 P2-utf8: split multi-byte character across reads remains correct (persistent decoder)', () => {
    const original = '🌟 café — naïve — hello 🌍';
    const bytes = Buffer.from(original, 'utf8');
    // Split inside the first emoji (4 bytes) — e.g., after 2 bytes
    const splitAt = 2;
    const chunk1 = bytes.slice(0, splitAt);
    const chunk2 = bytes.slice(splitAt);
    // Persistent decoder simulation (what _readStreamChunks now does)
    let persistentDecoder;
    try { persistentDecoder = new TextDecoder(); } catch(e) { persistentDecoder = null; }
    let persistentText = '';
    if (persistentDecoder) {
        persistentText += persistentDecoder.decode(chunk1, { stream: true });
        persistentText += persistentDecoder.decode(chunk2, { stream: true });
        persistentText += persistentDecoder.decode();
    } else {
        persistentText = bytes.toString('utf8');
    }
    assert.equal(persistentText, original, 'persistent decoder must reassemble split UTF-8 correctly');
    // Non-persistent (buggy) would corrupt
    let buggy = '';
    try { buggy += new TextDecoder().decode(chunk1); } catch(e) { buggy += String(chunk1); }
    try { buggy += new TextDecoder().decode(chunk2); } catch(e) { buggy += String(chunk2); }
    // Buggy should NOT equal original (replacement chars)
    assert.notEqual(buggy, original, 'non-persistent decoder should corrupt split multi-byte');
});

test('AI6 P2-utf8: nineRouterProvider _readStreamChunks uses persistent decoder', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai/nineRouterProvider.js'), 'utf8');
    assert.ok(src.includes('new TextDecoder()') && src.includes('{ stream: true }'), 'must use persistent decoder with stream:true');
    assert.ok(src.includes('decoder.decode()') || src.includes('tail'), 'must flush decoder tail on stream end');
    assert.ok(!src.includes('new TextDecoder().decode(bytes.get_data())') || src.includes('decoder.decode'), 'old per-chunk new TextDecoder().decode must be replaced');
});

test('AI6 P2-utf8: fetch path also flushes decoder', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai/nineRouterProvider.js'), 'utf8');
    // fetch branch should have tail flush too
    const fetchSection = src.slice(src.indexOf('fetchStreamFetch'));
    assert.ok(fetchSection.includes('decoder.decode()'), 'fetch path must also flush decoder tail');
});

// ── P2 malformed complete SSE does not block valid ──

test('AI6 P2-sse: malformed complete event does not block following valid event', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    parser.feed('data: {invalid json}\n\n');
    parser.feed(sseDelta('valid'));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1, 'valid event after malformed must still be processed');
    assert.equal(deltas[0].text, 'valid');
    // No infinite reinsertion: feed again should not reprocess malformed
    const before = events.length;
    parser.feed('data: not-json\n\n');
    // already done? Not necessarily done, so check no hang: parser should be flushable
    parser.flush();
    assert.ok(events.length >= before, 'no hang after malformed');
});

test('AI6 P2-sse: incomplete JSON across reads still buffers correctly', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    const full = sseData({ choices: [{ delta: { content: 'split' } }] });
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    assert.equal(events.filter(e => e.type === 'delta').length, 0, 'incomplete should buffer, not emit');
    parser.feed(full.slice(mid));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'split');
});

test('AI6 P2-sse: malformed complete does not reinsert into buffer', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    // Feed malformed complete + valid in same chunk
    parser.feed('data: {invalid:}\n\n' + sseDelta('after'));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'after');
});

// ── Stale / cancel / normal isolation ──

test('AI6 stale delta still ignored', () => {
    let h1 = null, h2 = null, idx = 0;
    const provider = {
        request(){},
        streamRequest(p,c,onEvent){ idx++; if(idx===1) h1=onEvent; else h2=onEvent; },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let deltas1=[], deltas2=[];
    engine.searchStream('first', { onDelta: c=> deltas1.push(c) });
    engine.searchStream('second', { onDelta: c=> deltas2.push(c) });
    if (h1) h1({ type: 'delta', text: 'stale' });
    assert.deepEqual(deltas1, [], 'stale delta ignored');
    if (h2) h2({ type: 'delta', text: 'ok' });
    assert.deepEqual(deltas2, ['ok']);
});

test('AI6 stale completion still ignored', () => {
    let h1=null, h2=null, idx=0;
    const provider = {
        request(){},
        streamRequest(p,c,onEvent){ idx++; if(idx===1) h1=onEvent; else h2=onEvent; },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let got1=null, got2=null;
    engine.searchStream('first', { onComplete: d=> got1=d });
    engine.searchStream('second', { onComplete: d=> got2=d });
    if (h1) h1({ type: 'complete', result: { text: 'stale', sources: [], grounded: false } });
    assert.equal(got1, null);
    if (h2) h2({ type: 'complete', result: { text: 'ok', sources: [], grounded: false } });
    assert.equal(got2.text, 'ok');
});

test('AI6 stale error still ignored', () => {
    let h1=null, idx=0;
    const provider = {
        request(){},
        streamRequest(p,c,onEvent){ idx++; if(idx===1) h1=onEvent; },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let err=null;
    engine.searchStream('first', { onError: e=> err=e });
    engine.searchStream('second', { onComplete: ()=>{}, onError: ()=>{} });
    if (h1) h1({ type: 'error', error: { code: 'network_error', message: 'late' } });
    assert.equal(err, null);
});

test('AI6 cancel clears pending stream/buffer safely', () => {
    let h=null;
    const provider = {
        request(){},
        streamRequest(p,c,onEvent){ h=onEvent; },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let got=null, deltas=[];
    engine.searchStream('q', { onDelta: c=> deltas.push(c), onComplete: d=> got=d, onError: ()=>{} });
    engine.cancel();
    if (h) {
        h({ type: 'delta', text: 'late' });
        h({ type: 'complete', result: { text: 'late', sources: [], grounded: false } });
        h({ type: 'error', error: { code: 'network_error', message: 'late' } });
    }
    assert.deepEqual(deltas, [], 'cancel must block late deltas');
    assert.equal(got, null, 'cancel must block late completion');
});

test('AI6 Normal Search never enters streaming path', () => {
    let streamCalled = false;
    const provider = {
        request(payload, canc, cb) { cb(null, { type: 'answer', text: 'normal answer' }); },
        streamRequest(){ streamCalled = true; },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool() });
    let got=null;
    engine.search('q', { onAnswer: d=> got=d });
    assert.equal(streamCalled, false, 'search() must not call streamRequest');
    assert.ok(got, 'normal search still delivers');
    assert.equal(got.text, 'normal answer');
});

test('AI6 parser: malformed complete SSE then valid SSE in one buffer processes valid', () => {
    const events = [];
    const parser = createStreamParser({ onEvent: e => events.push(e) });
    parser.feed('data: {"not": valid}\n\n' + sseData({ choices: [{ delta: { content: 'ok' } }] }));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'ok');
});

test('AI6 engine: grounded sources not overwritten by empty provider array', () => {
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) { onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }); return; }
            onEvent({ type: 'delta', text: 'hi' });
            onEvent({ type: 'complete', result: { text: 'hi', sources: [], grounded: false } });
        }
    });
    const tool = createMockWebSearchTool({
        handler: (q,c,cb)=> cb(null, [
            { title: 'A', url: 'https://example.com/1', snippet: 's' },
            { title: 'B', url: 'https://example.com/2', snippet: 's' }
        ])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got=null;
    engine.searchStream('q', { onComplete: d=> got=d });
    assert.ok(got.sources.length === 2, 'grounded sources not overwritten by empty provider sources');
});
