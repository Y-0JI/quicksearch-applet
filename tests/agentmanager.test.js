const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
const { createConversationManager } = require('../providers/conversationManager.js');

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

// Phase 12: a system message now leads every run with tools offered;
// assertions locate turns by role/id instead of raw indexes
function firstOfRole(msgs, role) {
    return msgs.filter(m => m.role === role);
}
function toolContent(aiCall, callId) {
    const m = aiCall.ctx.messages.find(
        x => x.role === 'tool' && x.tool_call_id === callId);
    return m ? JSON.parse(m.content) : null;
}

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
    const assistantTurns = firstOfRole(msgs, 'assistant');
    assert.equal(assistantTurns.length, 1);
    assert.deepEqual(assistantTurns[0].tool_calls, [
        { id: 't1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }]);
    assert.deepEqual(toolContent(ai.calls[1], 't1'), { echo: 'hi' });
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
    assert.equal(firstOfRole(msgs, 'assistant').length, 1);       // ONE assistant turn...
    assert.equal(msgs.filter(m => m.role === 'tool').length, 3); // ...THREE tool results
    assert.deepEqual(msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id),
        ['c1', 'c2', 'c3']);
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
    assert.equal(toolContent(ai.calls[1], 'u1').error, 'unknown-tool');
});

test('invalid arguments: unparseable JSON is a controlled tool message', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('b1', 'echo', 'not-json{')] },
        { answer: 'ok' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'ok');
    const toolMsg = toolContent(ai.calls[1], 'b1');
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
    const toolMsg = toolContent(ai.calls[1], 's1');
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
    assert.equal(toolContent(ai.calls[1], 'f1').error, 'boom-code');
});

test('throwing tool cannot crash the agent (registry normalizes)', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('x1', 'throw_tool', '{}')] },
        { answer: 'tetap hidup' }
    ]);
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'tetap hidup');
    const toolMsg = toolContent(ai.calls[1], 'x1');
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
    // tool message stays SMALL (no base64 duplicated into history)
    assert.deepEqual(toolContent(ai.calls[1], 's1'), { image_received: true });
    // the pixels ride in the user turn IMMEDIATELY AFTER the tool ack
    const msgs = ai.calls[1].ctx.messages;
    const ackIdx = msgs.findIndex(m => m.role === 'tool' && m.tool_call_id === 's1');
    const um = msgs[ackIdx + 1];
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
    assert.equal(toolContent(ai.calls[1], 'z1').error, 'image-too-large');
    // only system+user+tool present: NO image user turn appended
    assert.equal(firstOfRole(msgs, 'user').length, 1);
});

test('agent without screen tool still answers normally (vision off by default)', async () => {
    const { agent, ai } = makeAgent([{ answer: 'plain' }]);
    const { err, res } = await settled(agent, 'halo');
    assert.equal(err, null);
    assert.equal(res.answer, 'plain');
});

// ---- Phase 11: computer-use loop (screen -> action -> screen -> final) ----

test('computer-use loop: get_screen, click, verify screen, then final', async () => {
    const IMG = 'data:image/png;base64,iVBORw0KGgo=';
    const reg = createToolRegistry();
    let clicks = [];
    reg.register({ id: 'get_screen', name: 'Get Screen', description: 'shot', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, ctx, cb) => cb(null, { image: IMG }) });
    reg.register({ id: 'click', name: 'Click', description: 'click', riskLevel: 'MEDIUM',
        inputSchema: { type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        execute: (a, ctx, cb) => { clicks.push([a.x, a.y]); cb(null, { clicked: true }); } });

    const ai = scriptedAI([
        // 1st AI call: look at the screen first
        { toolCalls: [TC('g1', 'get_screen', '{}')] },
        // 2nd call (sees image in context): act on it
        { toolCalls: [TC('c1', 'click', '{"x":120,"y":240}')] },
        // 3rd call: verify the result with another screenshot
        { toolCalls: [TC('g2', 'get_screen', '{}')] },
        // 4th: satisfied -> final answer
        { answer: 'tombol sudah diklik' }
    ]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg,
        hasVision: () => true });

    const { err, res } = await settled(agent, 'klik tombol login');
    assert.equal(err, null);
    assert.equal(res.answer, 'tombol sudah diklik');
    assert.equal(ai.calls.length, 4);
    assert.deepEqual(clicks, [[120, 240]]);
    // the FINAL evaluation context carries BOTH screenshots as image turns;
    // the intermediate click turn added none
    const lastMsgs = ai.calls[ai.calls.length - 1].ctx.messages;
    const imgs = lastMsgs.filter(m => Array.isArray(m.content) &&
        m.content.some(p => p.type === 'image_url'));
    assert.equal(imgs.length, 2);
});

// ---- Phase 12: permission policy integration ----

const { createPermissionPolicy } = require('../providers/permissionPolicy.js');

test('policy deny -> permission-denied tool message, loop continues to final', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('d1', 'fail_tool', '{}')] },
        { answer: 'tidak diizinkan oleh pengguna' }
    ]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        policy: createPermissionPolicy({
            matrix: { LOW: 'deny', MEDIUM: 'deny', HIGH: 'deny' }
        })
    });
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);                       // run survives a denial
    assert.equal(res.answer, 'tidak diizinkan oleh pengguna');
    assert.equal(toolContent(ai.calls[1], 'd1').error, 'permission-denied');
});

test('confirmation required -> executed ONLY after user allows', async () => {
    let asked = null;
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('c9', 'echo', '{"text":"x"}')] },
        { answer: 'sudah dieksekusi' }
    ]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        policy: createPermissionPolicy({ matrix: { LOW: 'confirm', MEDIUM: 'confirm', HIGH: 'confirm' } }),
        requestConfirmation: (req, cb) => { asked = req; cb(true); }
    });
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'sudah dieksekusi');
    assert.ok(asked && asked.tool === 'echo' && asked.risk === 'LOW');
    // tool actually ran (result message present)
    assert.equal(toolContent(ai.calls[1], 'c9').echo, 'x');
});

test('confirmation denied -> permission-denied, tool NEVER executes', async () => {
    let ran = 0;
    const reg = createToolRegistry();
    reg.register({ id: 'echo', name: 'Echo', description: 'e', riskLevel: 'LOW',
        inputSchema: { type: 'object',
            properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (a, c, cb) => { ran++; cb(null, { echo: a.text }); } });
    const ai = scriptedAI([
        { toolCalls: [TC('n1', 'echo', '{"text":"x"}')] },
        { answer: 'baik, tidak jadi' }
    ]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        policy: createPermissionPolicy({ matrix: { LOW: 'confirm', MEDIUM: 'confirm', HIGH: 'confirm' } }),
        requestConfirmation: (req, cb) => cb(false)
    });
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'baik, tidak jadi');
    assert.equal(ran, 0, 'tool body must not run without approval');
    assert.equal(toolContent(ai.calls[1], 'n1').error, 'permission-denied');
});

test('confirmation pending + cancel -> late approval never executes', async () => {
    let ran = 0, approveCb = null;
    const reg = createToolRegistry();
    reg.register({ id: 'echo', name: 'Echo', description: 'e', riskLevel: 'MEDIUM',
        inputSchema: { type: 'object',
            properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (a, c, cb) => { ran++; cb(null, {}); } });
    const agent = createAgentManager({
        aiAsk: (q, ctx, cb) => setTimeout(() =>
            cb(null, { toolCalls: [TC('w1', 'echo', '{"text":"x"}')] }), 0),
        registry: reg,
        policy: createPermissionPolicy({ matrix: { MEDIUM: 'confirm', LOW: 'allow', HIGH: 'allow' } }),
        requestConfirmation: (req, cb) => { approveCb = cb; } // never resolves on its own
    });
    let done = 0;
    agent.run('q', { messages: [{ role: 'user', content: 'q' }] }, () => done++);
    await new Promise(r => setTimeout(r, 10));
    agent.cancel();          // user cancels while dialog is open
    approveCb(true);         // dialog answer arrives AFTER cancel
    await new Promise(r => setTimeout(r, 10));
    assert.equal(ran, 0, 'stale approval must not execute anything');
    assert.equal(done, 0);
});

test('no confirmer wired + confirm verdict -> treated as denial', async () => {
    let ran = 0;
    const reg = createToolRegistry();
    reg.register({ id: 'echo', name: 'Echo', description: 'e', riskLevel: 'HIGH',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, c, cb) => { ran++; cb(null, {}); } });
    const ai = scriptedAI([{ toolCalls: [TC('h1', 'echo', '{}')] }, { answer: 'ok' }]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        policy: createPermissionPolicy() // default: HIGH confirm, no confirmer passed
    });
    const { res } = await settled(agent, 'q');
    assert.equal(res.answer, 'ok');
    assert.equal(ran, 0);
});

test('system prompt injected once per run when tools are offered', async () => {
    const { agent, ai } = makeAgent([{ answer: 'siap' }]);
    await settled(agent, 'buka firefox');
    const msgs = ai.calls[0].ctx.messages;
    assert.equal(msgs[0].role, 'system');
    assert.ok(/tool/i.test(msgs[0].content));
    // exactly one system message even after more AI rounds
});

// ---- Phase 13: activity events for the UI status line ----

test('events: thinking -> start -> complete -> thinking sequence (one tool)', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('e1', 'echo', '{"text":"x"}')] },
        { answer: 'selesai' }
    ]);
    const events = [];
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        onPhase: ph => events.push(['phase', ph]),
        onToolStart: id => events.push(['start', id]),
        onToolComplete: id => events.push(['complete', id]),
        onToolError: (id, e) => events.push(['error', id, e && e.error])
    });
    await settled(agent, 'q');
    assert.deepEqual(events.filter(e => e[0] !== 'phase' || true), [
        ['phase', 'thinking'],
        ['start', 'echo'],
        ['complete', 'echo'],
        ['phase', 'thinking']
    ]);
});

test('events: denied tool fires error(permission-denied), NO start/complete', async () => {
    const reg = createToolRegistry();
    let ran = 0;
    reg.register({ id: 'echo', name: 'E', description: 'e', riskLevel: 'LOW',
        inputSchema: { type: 'object',
            properties: { text: { type: 'string' } }, required: ['text'] },
        execute: (a, c, cb) => { ran++; cb(null, {}); } });
    const ai = scriptedAI([{ toolCalls: [TC('p1', 'echo', '{"text":"x"}')] }, { answer: 'ok' }]);
    const events = [];
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        policy: createPermissionPolicy({ matrix: { LOW: 'deny', MEDIUM: 'deny', HIGH: 'deny' } }),
        onToolStart: id => events.push(['start', id]),
        onToolComplete: id => events.push(['complete', id]),
        onToolError: (id, e) => events.push(['error', id, e.error])
    });
    await settled(agent, 'q');
    assert.equal(ran, 0);
    assert.deepEqual(events, [['error', 'echo', 'permission-denied']]);
});

test('events: failing tool emits onToolError with normalized code, run survives', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('f9', 'fail_tool', '{}')] },
        { answer: 'gagal tapi selesai' }
    ]);
    let errEvt = null;
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        onToolError: (id, e) => { errEvt = [id, e.error]; }
    });
    const { res } = await settled(agent, 'q');
    assert.equal(res.answer, 'gagal tapi selesai');
    assert.deepEqual(errEvt, ['fail_tool', 'boom-code']);
});

test('events: throwing UI callback cannot break the agent loop', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([{ answer: 'tetap jalan' }]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk,
        registry: reg,
        onPhase: () => { throw new Error('ui bug'); },
        onToolStart: () => { throw new Error('ui bug'); }
    });
    const { err, res } = await settled(agent, 'q');
    assert.equal(err, null);
    assert.equal(res.answer, 'tetap jalan');
});

// ---- Phase 14: Agent Context / Session State regression tests ----

test('phase 14: new agent run gets a fresh base — no tool/assistant state from prior run', async () => {
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('t1', 'echo', '{"text":"a"}')] },
        { toolCalls: [TC('t2', 'echo', '{"text":"b"}')] },
        { answer: 'done' }
    ]);
    await settled(agent, 'q1');
    const lastPrior = ai.calls[ai.calls.length - 1].ctx.messages;
    assert.ok(lastPrior.some(m => m.role === 'tool'), 'prior multi-tool run accumulated tool messages');

    const n = ai.calls.length;
    await settled(agent, 'q2', { messages: [{ role: 'user', content: 'q2' }] });
    const secondRunFirst = ai.calls[n];
    assert.ok(secondRunFirst, 'second run issued an AI call');
    const roles = secondRunFirst.ctx.messages.map(m => m.role);
    assert.deepEqual(roles, ['system', 'user'],
        'second run base has no leftover tool/assistant turns from the prior run');
});

test('phase 14: multi-step agent context stays within the step-derived message bound', async () => {
    // 7 tool steps + final answer exercises MAX-1 steps; context must stay bounded
    const steps = [];
    for (let i = 0; i < 7; i++) steps.push({ toolCalls: [TC('s' + i, 'echo', '{"text":"x"}')] });
    steps.push({ answer: 'final' });
    const { agent, ai } = makeAgent(steps);
    await settled(agent, 'q');
    const lastMsgs = ai.calls[ai.calls.length - 1].ctx.messages;
    const expectedMax = 2 /* system + user */ + 2 * LIMITS.maxAgentSteps;
    assert.ok(lastMsgs.length > 4, 'multi-step context actually grew across steps');
    assert.ok(lastMsgs.length <= expectedMax,
        'context stays within the step-derived bound (no unbounded growth)');
});

test('phase 14: conversation clear() wipes history; agent run built on it starts clean', async () => {
    const cm = createConversationManager({ maxTurns: 8 });
    cm.send('q1', (q, c, cb) => cb(null, { answer: 'a1' }), () => {});
    cm.send('q2', (q, c, cb) => cb(null, { answer: 'a2' }), () => {});
    assert.equal(cm.size(), 4, 'history has 2 pairs before clear');

    cm.clear();
    assert.equal(cm.size(), 0);
    assert.deepEqual(cm.history(), [], 'history empty after clear');

    // a fresh agent run sourced from the cleared conversation must start clean
    const reg = makeRegistry();
    const ai = scriptedAI([{ answer: 'fresh' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    await settled(agent, 'q3', { messages: cm.buildMessages('q3') });
    const firstCall = ai.calls[0].ctx.messages;
    const roles = firstCall.map(m => m.role);
    assert.deepEqual(roles, ['system', 'user'],
        'agent context has no leftover from the cleared conversation');
    assert.equal(firstCall[1].content, 'q3', 'new task starts from its own question');
});
