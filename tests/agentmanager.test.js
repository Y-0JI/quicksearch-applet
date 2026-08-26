const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');

// ---- fakes ----

function makeRegistry() {
    const reg = createToolRegistry();
    reg.register({
        id: 'echo', name: 'Echo', description: 'echo text back', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (a, c, cb) => cb(null, { echo: a.text })
    });
    reg.register({
        id: 'slow_echo', name: 'Slow Echo', description: 'async echo', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (a, c, cb) => setTimeout(() => cb(null, { echo: a.text }), 0)
    });
    reg.register({
        id: 'fail_tool', name: 'Fail', description: 'returns normalized error', riskLevel: 'MEDIUM',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, c, cb) => cb({ error: 'boom-code', detail: 'x' })
    });
    reg.register({
        id: 'throw_tool', name: 'Throw', description: 'throws synchronously', riskLevel: 'HIGH',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: () => { throw new Error('kaboom-sync'); }
    });
    return reg;
}

// scripted AI: one entry per expected aiAsk call; last entry repeats if overrun
function scriptedAI(script) {
    const calls = [];
    return {
        calls: calls,
        aiAsk(question, ctx, cb) {
            calls.push({ question: question, ctx: ctx });
            const s = script[Math.min(calls.length - 1, script.length - 1)];
            setTimeout(() => {
                if (s.err) { cb(s.err, null); return; }
                cb(null, s);
            }, 0);
        }
    };
}

function makeAgent(script, extra) {
    const reg = makeRegistry();
    const ai = scriptedAI(script);
    const agent = createAgentManager(Object.assign({
        aiAsk: ai.aiAsk,
        registry: reg
    }, extra || {}));
    return { agent: agent, ai: ai, reg: reg };
}

const TC = (id, name, argsJson) => ({ id: id, name: name, argsJson: argsJson });

// promise wrapper so assertions can run AFTER the async loop settles
function settled(agent, question, ctx) {
    return new Promise(resolve => agent.run(question, ctx || { messages: [
        { role: 'user', content: String(question) }] }, (err, res) => resolve({ err: err, res: res })));
}

// ---- Phase 9 core loop ----

test('no-tool question -> final answer, exactly ONE ai call, tools offered', async () => {
    const { agent, ai } = makeAgent([{ answer: 'halo dunia' }]);
    const { err, res } = await settled(agent, 'apa itu plocate?', { messages: [
        { role: 'user', content: 'apa itu plocate?' }] });
    assert.equal(err, null);
    assert.deepEqual(res, { answer: 'halo dunia' });
    assert.equal(ai.calls.length, 1);
    const tools = ai.calls[0].ctx.tools;
    assert.ok(Array.isArray(tools) && tools.length >= 4, 'registered tools offered');
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].function.name, 'echo');
});

test('one-tool task: tool call -> tool message -> final answer', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('t1', 'echo', '{"text":"hi"}')] },
        { answer: 'selesai' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'selesai');
    assert.equal(ai.calls.length, 2);
    const msgs = ai.calls[1].ctx.messages;
    assert.equal(msgs[1].role, 'assistant');
    assert.deepEqual(msgs[1].tool_calls, [
        { id: 't1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }]);
    assert.equal(msgs[2].role, 'tool');
    assert.equal(msgs[2].tool_call_id, 't1');
    assert.equal(msgs[2].content, '{"echo":"hi"}');
});

test('multi-round: several tool rounds then final', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('a', 'slow_echo', '{"text":"1"}')] },
        { toolCalls: [TC('b', 'echo', '{"text":"2"}')] },
        { answer: 'jadi' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'jadi');
    assert.equal(ai.calls.length, 3);
});

test('multiple tool_calls in ONE response execute in order before next AI call', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('c1', 'echo', '{"text":"x"}'), TC('c2', 'slow_echo', '{"text":"y"}'), TC('c3', 'echo', '{"text":"z"}')] },
        { answer: 'done' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'done');
    assert.equal(ai.calls.length, 2);
    const msgs = ai.calls[1].ctx.messages;
    assert.equal(msgs[1].role, 'assistant');                      // ONE assistant turn...
    assert.equal(msgs.filter(m => m.role === 'tool').length, 3); // ...THREE tool results
    assert.deepEqual(msgs.slice(2).map(m => m.tool_call_id), ['c1', 'c2', 'c3']);
});

test('max-steps: stops at LIMITS.maxAgentSteps AI calls with clear status', async () => {
    const { agent, ai } = makeAgent([{ toolCalls: [TC('loop', 'echo', '{"text":"x"}')] }]);
    const { err } = await settled(agent, 'q');
    assert.equal(err.error, 'max-steps');
    assert.equal(err.steps, LIMITS.maxAgentSteps);
    assert.equal(ai.calls.length, LIMITS.maxAgentSteps, 'no AI call beyond the cap');
});

test('no automatic retry: AI error finishes the run immediately', async () => {
    const { agent, ai } = makeAgent([{ err: { error: 'http-500' } }]);
    const { err } = await settled(agent, 'q');
    assert.equal(err.error, 'http-500');
    assert.equal(ai.calls.length, 1, 'exactly one attempt, zero retries');
});

// ---- Phase 9 error paths + cancellation ----

test('unknown tool -> controlled payload, loop continues to final answer', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('u1', 'no_such_tool', '{"x":1}')] },
        { answer: 'tool tidak ada, maaf' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'tool tidak ada, maaf');
    const toolMsg = JSON.parse(ai.calls[1].ctx.messages[2].content);
    assert.equal(toolMsg.error, 'unknown-tool');
});

test('invalid arguments: unparseable JSON is a controlled tool message', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('b1', 'echo', 'not-json{')] },
        { answer: 'ok' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'ok');
    const toolMsg = JSON.parse(ai.calls[1].ctx.messages[2].content);
    assert.equal(toolMsg.error, 'invalid-arguments');
    assert.equal(toolMsg.reason, 'unparseable-json');
});

test('invalid arguments: schema failure (missing required) stays controlled', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('s1', 'echo', '{}')] },   // missing required "text"
        { answer: 'berhasil tetap lanjut' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'berhasil tetap lanjut');
    const toolMsg = JSON.parse(ai.calls[1].ctx.messages[2].content);
    assert.equal(toolMsg.error, 'invalid-arguments');
    assert.equal(toolMsg.reason, 'missing-required:text');
});

test('tool failure payload -> normalized message, run survives to final', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('f1', 'fail_tool', '{}')] },
        { answer: 'gagal tapi aman' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'gagal tapi aman');
    const toolMsg = JSON.parse(ai.calls[1].ctx.messages[2].content);
    assert.equal(toolMsg.error, 'boom-code');
});

test('throwing tool cannot crash the agent (registry normalizes)', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('x1', 'throw_tool', '{}')] },
        { answer: 'tetap hidup' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'tetap hidup');
    const toolMsg = JSON.parse(ai.calls[1].ctx.messages[2].content);
    assert.equal(toolMsg.error, 'tool-failed');
    assert.equal(toolMsg.message, 'kaboom-sync');
});

test('cancel(): whole run dies — cancellable hit, no further callbacks render', async () => {
    let cancelledCount = 0;
    const { agent, ai } = makeAgent([{ toolCalls: [TC('w', 'slow_echo', '{"text":"x"}')] },
                                     { answer: 'TIDAK BOLEH SAMPAI SINI' }]);
    // replace with a cancellable spy so we can observe the abort
    let released = false;
    const agentSpy = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: makeRegistry(),
        makeCancellable: () => ({ cancel: () => { cancelledCount++; released = true; } })
    });
    let cbCount = 0;
    agentSpy.run('q', { messages: [{ role: 'user', content: 'q' }] },
        () => { cbCount++; });   // would render stale output if ever called
    agentSpy.cancel();           // kill mid-flight (first AI call still pending)
    await new Promise(r => setTimeout(r, 10)); // let late timers fire
    assert.ok(released, 'run cancellable was cancelled');
    assert.equal(cbCount, 0, 'stale callbacks never render');
    assert.equal(ai.calls.length, 1, 'loop stopped after cancel');
});

test('late completion after cancel is dropped silently', async () => {
    const { agent, ai } = makeAgent([{ answer: 'late' }]);
    let cbCount = 0;
    agent.run('q', { messages: [{ role: 'user', content: 'q' }] }, () => { cbCount++; });
    agent.cancel();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cbCount, 0);
    assert.equal(ai.calls.length, 1);
    // agent usable again after cancel
    const { err, res } = await settled(agent, 'lagi');
    assert.equal(err, null);
    assert.equal(res.answer, 'late');
});

test('stale run: starting a newer run supersedes the older one', async () => {
    const { agent, ai } = makeAgent([{ answer: 'B' }]);
    let oldCalls = 0, newResult = null;
    agent.run('lama', { messages: [{ role: 'user', content: 'lama' }] }, () => { oldCalls++; });
    const { err, res } = await settled(agent, 'baru');
    newResult = res;
    await new Promise(r => setTimeout(r, 10));
    assert.equal(oldCalls, 0, 'superseded run never renders');
    assert.equal(err, null);
    assert.deepEqual(newResult, { answer: 'B' });
});

// ---- Phase 10: vision capability + image handling ----

test('capabilities.vision flows from hasVision() into tool execution context', async () => {
    let seenCtx = null;
    const reg = createToolRegistry();
    reg.register({ id: 'spy', name: 'Spy', description: 'captures ctx', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, ctx, cb) => { seenCtx = ctx; cb(null, { ok: 1 }); } });
    const ai = scriptedAI([{ toolCalls: [TC('v1', 'spy', '{}')] }, { answer: 'ya' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg,
        hasVision: () => true });
    await settled(agent, 'q');
    assert.ok(seenCtx && seenCtx.capabilities && seenCtx.capabilities.vision === true);
});

test('image-bearing tool result becomes compact tool msg + user multimodal turn', async () => {
    const IMG = 'data:image/png;base64,iVBORw0KGgo=';
    const reg = createToolRegistry();
    reg.register({ id: 'shot', name: 'Shot', description: 'returns screen', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, ctx, cb) => cb(null, { image: IMG }) });
    const ai = scriptedAI([{ toolCalls: [TC('s1', 'shot', '{}')] }, { answer: 'layar terlihat' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg,
        hasVision: () => true });
    await settled(agent, 'lihat layar');
    assert.equal(ai.calls.length, 2);
    const msgs = ai.calls[1].ctx.messages;
    // tool message stays SMALL (no base64 duplicated into history)
    assert.deepEqual(JSON.parse(msgs[2].content), { image_received: true });
    // the pixels ride in the following user turn as multimodal content
    const um = msgs[3];
    assert.equal(um.role, 'user');
    assert.ok(Array.isArray(um.content));
    assert.equal(um.content[0].type, 'text');
    assert.equal(um.content[1].type, 'image_url');
    assert.equal(um.content[1].image_url.url, IMG);
});

test('oversized image -> controlled image-too-large, no giant payload sent', async () => {
    const BIG = 'data:image/png;base64,' + 'A'.repeat(LIMITS.maxImageDataUrlChars + 10);
    const reg = createToolRegistry();
    reg.register({ id: 'shot_big', name: 'BigShot', description: 'huge', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, ctx, cb) => cb(null, { image: BIG }) });
    const ai = scriptedAI([{ toolCalls: [TC('z1', 'shot_big', '{}')] }, { answer: 'oke' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg,
        hasVision: () => true });
    await settled(agent, 'q');
    const msgs = ai.calls[1].ctx.messages;
    const toolMsg = JSON.parse(msgs[2].content);
    assert.equal(toolMsg.error, 'image-too-large');
    // no user turn carrying the oversized image was appended
    assert.equal(msgs.length, 3);
});

test('agent without screen tool still answers normally (vision off by default)', async () => {
    const { agent, ai } = makeAgent([{ answer: 'plain' }]);
    const { err, res } = await settled(agent, 'halo');
    assert.equal(err, null);
    assert.equal(res.answer, 'plain');
});
