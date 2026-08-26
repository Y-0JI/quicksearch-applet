// Runtime regression tests for Phase 13 bugs 2 & 3:
//  - BUG 2: type_text permission gated by "Allow computer control"
//  - BUG 3: agent activity event ordering (toolStart before execute,
//           toolComplete after, toolError still emits, cancel clears status)
//
// Uses the REAL AgentManager + ToolRegistry + default tools with injected
// (non-Cinnamon) fakes, so it exercises the production loop end-to-end.

const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
const { createDefaultTools } = require('../providers/tools/index.js');
const { createPermissionPolicy } = require('../providers/permissionPolicy.js');

const TC = (id, name, args) => ({ id, name, argsJson: JSON.stringify(args || {}) });
function scripted(rounds) {
    let n = 0;
    return (q, ctx, cb) => {
        const r = rounds[Math.min(n, rounds.length - 1)];
        n++;
        setTimeout(() => cb(null, r), 0);
    };
}
function settled(agent, question, ctx) {
    return new Promise(res => agent.run(question, ctx || { messages: [{ role: 'user', content: question }] },
        (err, r) => res({ err, r })));
}
function makeRegistry(overDeps) {
    const deps = Object.assign({
        tryCalculate: q => null,
        detectUrl: u => (/^https?:\/\//i.test(u) ? u : null),
        openPath: () => true,
        openUri: () => true,
        fileProvider: { search: (q, c, cb) => cb([]) },
        webProvider: { search: (q, c, cb) => cb([]) },
        appProvider: { searchApps: () => [], getApp: () => ({ launch: () => {} }) },
        screenCapture: { capture: (cb) => cb(null, { image: 'data:image/png;base64,iVBORw0KGgo=' }) },
        computerControl: { typeText: (t, c, cb) => cb(null, { typed: t }) },
        timers: { after: (ms, fn) => setTimeout(fn, ms), clear: () => {} },
        LIMITS,
        validators: {
            validatePoint: () => null, validateKey: () => null,
            sanitizeText: s => s, validateScroll: () => ({ direction: 'up', amount: 1 })
        }
    }, overDeps || {});
    const reg = createToolRegistry();
    for (const t of createDefaultTools(deps)) reg.register(t);
    return reg;
}

// ---- BUG 2: type_text permission ----

test('BUG2 policy: type_text denied when computer control OFF', () => {
    const p = createPermissionPolicy({ isComputerControlAllowed: () => false });
    assert.equal(p.decide('type_text', 'MEDIUM'), 'deny');
});

test('BUG2 policy: type_text allowed when computer control ON', () => {
    const p = createPermissionPolicy({ isComputerControlAllowed: () => true });
    assert.equal(p.decide('type_text', 'MEDIUM'), 'allow');
});

test('BUG2 agent: type_text NOT executed when computer control OFF', async () => {
    let ran = 0;
    const reg = makeRegistry({ computerControl: { typeText: (t, c, cb) => { ran++; cb(null, { typed: t }); } } });
    const ai = scripted([{ toolCalls: [TC('t1', 'type_text', { text: 'hello' })] }, { answer: 'done' }]);
    const agent = createAgentManager({
        aiAsk: ai, registry: reg,
        policy: createPermissionPolicy({ isComputerControlAllowed: () => false })
    });
    const { r } = await settled(agent, 'ketik hello');
    assert.equal(ran, 0, 'tool body must not run without approval');
    assert.equal(r.answer, 'done');
});

test('BUG2 agent: type_text EXECUTES when computer control ON', async () => {
    let ran = 0, typed = null;
    const reg = makeRegistry({ computerControl: { typeText: (...a) => { ran++; typed = a[0]; a[2](null, { typed: a[0] }); } } });
    const ai = scripted([{ toolCalls: [TC('t1', 'type_text', { text: 'hello' })] }, { answer: 'done' }]);
    const agent = createAgentManager({
        aiAsk: ai, registry: reg,
        policy: createPermissionPolicy({ isComputerControlAllowed: () => true })
    });
    const { r } = await settled(agent, 'ketik hello');
    assert.equal(ran, 1, 'tool body must run when allowed');
    assert.equal(typed, 'hello');
    assert.equal(r.answer, 'done');
});

// ---- BUG 3: activity event ordering ----

test('BUG3: toolStart fires BEFORE tool execute; toolComplete AFTER', async () => {
    const order = [];
    // the tool's body runs synchronously inside computerControl.typeText,
    // which executes after onToolStart and before onToolComplete
    const reg = makeRegistry({
        computerControl: { typeText: (t, c, cb) => { order.push('exec'); cb(null, { typed: t }); } }
    });
    const ai = scripted([{ toolCalls: [TC('t1', 'type_text', { text: 'x' })] }, { answer: 'ok' }]);
    const agent = createAgentManager({
        aiAsk: ai, registry: reg,
        policy: createPermissionPolicy({ isComputerControlAllowed: () => true }),
        onToolStart: id => order.push('start:' + id),
        onToolComplete: id => order.push('complete:' + id),
        onToolError: (id, e) => order.push('error:' + id)
    });
    await settled(agent, 'q');
    const startIdx = order.indexOf('start:type_text');
    const execIdx = order.indexOf('exec');
    const completeIdx = order.indexOf('complete:type_text');
    assert.ok(startIdx !== -1 && execIdx !== -1 && completeIdx !== -1,
        'missing events: ' + JSON.stringify(order));
    assert.ok(startIdx < execIdx, 'toolStart must precede execute: ' + JSON.stringify(order));
    assert.ok(execIdx < completeIdx, 'execute must precede toolComplete: ' + JSON.stringify(order));
});

test('BUG3: failing tool still emits toolError (status/error UI path)', async () => {
    const reg = makeRegistry({ computerControl: { typeText: (t, c, cb) => cb({ error: 'boom' }) } });
    const ai = scripted([{ toolCalls: [TC('t1', 'type_text', { text: 'x' })] }, { answer: 'gagal' }]);
    const events = [];
    const agent = createAgentManager({
        aiAsk: ai, registry: reg,
        policy: createPermissionPolicy({ isComputerControlAllowed: () => true }),
        onToolStart: id => events.push('start:' + id),
        onToolError: (id, e) => events.push('error:' + id)
    });
    const { r } = await settled(agent, 'q');
    assert.ok(events.includes('start:type_text'), 'status show begin');
    assert.ok(events.some(e => e.indexOf('error:type_text') === 0), 'error UI fired');
    assert.equal(r.answer, 'gagal');
});

test('BUG3: cancellation clears active tool status (no late onToolStart)', async () => {
    const starts = [];
    const reg = makeRegistry();
    const ai = scripted([{ toolCalls: [TC('t1', 'type_text', { text: 'x' })] }, { answer: 'never' }]);
    let released = false;
    const agent = createAgentManager({
        aiAsk: ai, registry: reg,
        policy: createPermissionPolicy({ isComputerControlAllowed: () => true }),
        makeCancellable: () => ({ cancel: () => { released = true; } }),
        onToolStart: id => starts.push(id)
    });
    let cbCount = 0;
    agent.run('q', { messages: [{ role: 'user', content: 'q' }] }, () => cbCount++);
    agent.cancel();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(released, 'run cancelled');
    assert.equal(cbCount, 0, 'no stale render');
    assert.equal(starts.length, 0, 'no tool started after cancel');
});
