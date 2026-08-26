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
