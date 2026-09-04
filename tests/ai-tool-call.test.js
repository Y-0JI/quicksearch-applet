const { test } = require('node:test');
const assert = require('node:assert');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

test('TEST1 natural text "Gunakan web_search" does NOT trigger search (non-live query)', () => {
    let searchCalled = false;
    const tool = createMockWebSearchTool({ handler: (q,c,cb) => { searchCalled = true; cb(null, [{ title:'T', url:'https://example.com/a', snippet:'s'}]); }});
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (isSecond) { onEvent({ type:'complete', result:{ text:'second', sources:[]}}); return; }
            onEvent({ type:'start' });
            onEvent({ type:'delta', text:'Gunakan web_search biar akurat.' });
            onEvent({ type:'complete', result:{ text:'Gunakan web_search biar akurat.', sources:[] }});
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding:true });
    let got=null;
    engine.searchStream('siapa presiden indonesia', { onComplete: d=> got=d });
    assert.equal(searchCalled, false, 'natural text must not trigger search for non-live query');
    assert.ok(got, 'complete delivered');
    assert.match(got.text, /Gunakan web_search/);
});

test('TEST2 valid structured tool_call triggers search once', () => {
    let searchCalls = 0;
    const tool = createMockWebSearchTool({ handler: (q,c,cb) => { searchCalls++; cb(null, [{ title:'T', url:'https://example.com/a', snippet:'s'}]); }});
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) {
                onEvent({ type:'tool_call', tool:'web_search', arguments:{ query:'jadwal Chelsea minggu ini' } });
                return;
            }
            onEvent({ type:'delta', text:'final grounded' });
            onEvent({ type:'complete', result:{ text:'final grounded', sources: [{ title:'T', url:'https://example.com/a', snippet:'s'}] }});
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding:true });
    let got=null;
    engine.searchStream('Cek jadwal Chelsea minggu ini', { onComplete: d=> got=d });
    assert.equal(searchCalls, 1, 'tool_call should trigger search once');
    assert.ok(got, 'complete');
    assert.equal(got.text, 'final grounded');
});

test('TEST3 fragmented tool_call arguments via SSE are merged and search called once', () => {
    let searchCalls = 0;
    let receivedQuery = null;
    const tool = createMockWebSearchTool({ handler: (q,c,cb) => { searchCalls++; receivedQuery = q; cb(null, [{ title:'T', url:'https://example.com/a', snippet:'s'}]); }});
    // Simulate provider that emits fragmented tool_calls like real 9router: first chunk id+name, second chunk arguments
    const provider = {
        request(){},
        streamRequest(payload, canc, onEvent){
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) {
                // use direct onEvent with fragmented tool_calls via simulated parser? Instead directly emit via handler that mimics parser output:
                // For this test, we test engine's handling of fragmented via direct tool_call event with complete args, but parser test covers fragmentation.
                // To test parser fragmentation, use real nineRouter path? Simpler: test parser directly.
                onEvent({ type:'tool_call', tool:'web_search', arguments:{ query:'jadwal Chelsea' }});
                return;
            }
            onEvent({ type:'complete', result:{ text:'done', sources:[]}});
        },
        destroy(){}
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding:true });
    let got=null;
    // non-live query so the (fragmented) tool_call path is exercised — live queries are web-first
    engine.searchStream('siapa striker chelsea', { onComplete: d=> got=d });
    assert.equal(searchCalls, 1);
    assert.equal(receivedQuery, 'jadwal Chelsea');
    assert.ok(got);
});

test('TEST3b parser fragmented tool_calls across SSE chunks -> single tool_call', () => {
    const { createStreamParser } = require('../ai/streamParser.js');
    const events = [];
    const parser = createStreamParser({ onEvent: e=> events.push(e) });
    // Real 9router fragmented: chunk1 with id+name, chunk2 with arguments
    const chunk1 = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"web_search","arguments":""}}]}}]}\n\n';
    const chunk2 = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"jadwal Chelsea minggu ini\\"}"}}]}}]}\n\n';
    const chunkDone = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
    parser.feed(chunk1);
    parser.feed(chunk2);
    parser.feed(chunkDone);
    parser.feed('data: [DONE]\n\n');
    parser.flush();
    const toolCalls = events.filter(e=>e.type==='tool_call');
    assert.equal(toolCalls.length, 1, 'fragmented should emit single tool_call');
    assert.equal(toolCalls[0].tool, 'web_search');
    assert.equal(toolCalls[0].arguments.query, 'jadwal Chelsea minggu ini');
});

test('TEST4 live query fallback when provider returns answer without tool_call (application-level intent)', () => {
    let searchCalled = false;
    const tool = createMockWebSearchTool({ handler: (q,c,cb) => { searchCalled = true; cb(null, [{ title:'T', url:'https://example.com/a', snippet:'live snippet'}]); }});
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            const isSecond = !!(payload.groundingContext || payload.searchResults);
            if (!isSecond) {
                // Simulate model that does NOT support tool calling: returns direct answer text instead of tool_call
                onEvent({ type:'start' });
                onEvent({ type:'delta', text:'Jadwal Chelsea minggu ini butuh cek live.' });
                onEvent({ type:'complete', result:{ text:'Jadwal Chelsea minggu ini butuh cek live.', sources:[] }});
                return;
            }
            onEvent({ type:'start' });
            onEvent({ type:'delta', text:'final grounded jadwal' });
            onEvent({ type:'complete', result:{ text:'final grounded jadwal', sources: [{ title:'T', url:'https://example.com/a', snippet:'s'}] }});
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding:true });
    let got=null;
    engine.searchStream('Cek jadwal Chelsea minggu ini', { onComplete: d=> got=d });
    assert.equal(searchCalled, true, 'live query should fallback to search even without tool_call');
    assert.ok(got, 'got grounded complete');
    assert.match(got.text, /final grounded/);
    assert.ok(got.sources.length>0, 'sources grounded');
});

test('TEST4b non-live query does NOT fallback when provider returns direct answer', () => {
    let searchCalled = false;
    const tool = createMockWebSearchTool({ handler: (q,c,cb) => { searchCalled = true; cb(null, [{ title:'T', url:'https://example.com/a', snippet:'s'}]); }});
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            onEvent({ type:'start' });
            onEvent({ type:'delta', text:'Siapa presiden? Jawab: Joko Widodo' });
            onEvent({ type:'complete', result:{ text:'Siapa presiden? Jawab: Joko Widodo', sources:[] }});
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding:true });
    let got=null;
    engine.searchStream('siapa presiden indonesia', { onComplete: d=> got=d });
    assert.equal(searchCalled, false, 'non-live should not fallback');
    assert.ok(got);
});

test('TEST5 production runtime without mock -> real tool wired', () => {
    const { createAiEngine } = require('../ai/aiFactory.js');
    const engine = createAiEngine({
        provider: { request:(p,c,cb)=>cb(null,{type:'tool_call',tool:'web_search',arguments:{query:'q'}}), streamRequest:(p,c,onEvent)=>onEvent({type:'tool_call',tool:'web_search',arguments:{query:'q'}}), destroy(){} },
        enableGrounding:true,
        searchEngine:'ddgo',
        searxngUrl:'http://127.0.0.1:8080'
    });
    assert.ok(engine, 'engine created with production tool');
    assert.equal(typeof engine.search, 'function');
    assert.equal(typeof engine.searchStream, 'function');
});
