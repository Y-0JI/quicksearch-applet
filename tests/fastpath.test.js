// Fast Path round-count tests (Phase 13 latency fix). Verifies simple
// questions take ONE AI call (no tools) while tool-intent questions take the
// agent loop (tool call + final answer = 2 calls). Uses the REAL AgentManager
// + ToolRegistry with injected fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
const { createDefaultTools } = require('../providers/tools/index.js');
const { createQuestionRouter } = require('../providers/questionRouter.js');

function makeRegistry(over) {
    const deps = Object.assign({
        tryCalculate: q => null,
        detectUrl: () => null,
        openPath: () => true,
        openUri: () => true,
        fileProvider: { search: (q, c, cb) => cb([]) },
        webProvider: { search: (q, c, cb) => { deps._web = (deps._web || 0) + 1; cb([{ title: 'w', url: 'https://x', description: '' }]); } },
        appProvider: {
            searchApps: q => (/firefox/i.test(q) ? [{ appId: 'firefox.desktop', title: 'Firefox', action: () => { deps._launched = true; } }] : []),
            getApp: () => ({ launch: () => { deps._launched = true; } })
        },
        screenCapture: { capture: (cb) => cb(null, { image: 'data:image/png;base64,iVBORw0KGgo=' }) },
        computerControl: { typeText: (t, c, cb) => cb(null, { typed: t }) },
        timers: { after: (ms, fn) => setTimeout(fn, ms), clear: () => {} },
        LIMITS,
        validators: { validatePoint: () => null, validateKey: () => null, sanitizeText: s => s, validateScroll: () => ({ direction: 'up', amount: 1 }) }
    }, over || {});
    const reg = createToolRegistry();
    for (const t of createDefaultTools(deps)) reg.register(t);
    return { reg, deps };
}

// aiAsk that counts calls and inspects whether tools were sent.
// Web/app questions: first (tool-enabled) call returns a tool call, the next
// returns the final answer. Everything else is answered directly.
function makeAiAsk(calls) {
    return (q, ctx, cb) => {
        calls.push({ q, hasTools: !!(ctx.tools && ctx.tools.length) });
        const web = /berita|bMRI|cari/i.test(q);
        const app = /firefox/i.test(q);
        if ((web || app) && calls.length === 1) {
            if (web) cb(null, { toolCalls: [{ id: 't1', name: 'search_web', argsJson: JSON.stringify({ query: q }) }] });
            else cb(null, { toolCalls: [{ id: 't1', name: 'launch_app', argsJson: JSON.stringify({ app: 'Firefox' }) }] });
            return;
        }
        cb(null, { answer: 'final-answer' });
    };
}

function settle(agent, q) {
    return new Promise(res => agent.run(q, { messages: [{ role: 'user', content: q }] }, (err, r) => res({ err, r })));
}

const router = createQuestionRouter({
    detectUrl: () => null,
    appProvider: { searchApps: q => (/firefox/i.test(q) ? [{ appId: 'firefox.desktop' }] : []) },
    computerControl: {}, hasScreen: () => false
});

test('FAST: "Apa ibu kota Jepang?" -> 1 AI call, no tools', async () => {
    const calls = [];
    const { reg } = makeRegistry();
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: router });
    const { r } = await settle(agent, 'Apa ibu kota Jepang?');
    assert.equal(calls.length, 1, 'must be a single round');
    assert.equal(calls[0].hasTools, false, 'fast path sends no tool defs');
    assert.equal(r.answer, 'final-answer');
});

test('FAST: "Jelaskan plocate" -> 1 AI call, no tools', async () => {
    const calls = [];
    const { reg } = makeRegistry();
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: router });
    const { r } = await settle(agent, 'Jelaskan plocate');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hasTools, false);
    assert.equal(r.answer, 'final-answer');
});

test('AGENT: "Cari berita BMRI hari ini" -> web tool + final (2 calls)', async () => {
    const calls = [];
    const { reg, deps } = makeRegistry();
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: router });
    const { r } = await settle(agent, 'Cari berita BMRI hari ini');
    assert.equal(calls.length, 2, 'tool round + final round');
    assert.ok(calls[0].hasTools && calls[1].hasTools, 'agent loop always sends tools');
    assert.equal(deps._web, 1, 'search_web executed exactly once');
    assert.equal(r.answer, 'final-answer');
});

test('AGENT: "Buka Firefox" -> launch_app + final (2 calls)', async () => {
    const calls = [];
    const { reg, deps } = makeRegistry();
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: router });
    const { r } = await settle(agent, 'Buka Firefox');
    assert.equal(calls.length, 2);
    assert.ok(deps._launched, 'launch_app executed');
    assert.equal(r.answer, 'final-answer');
});

test('AUDIT5: a cancelled fast-path run does not pollute the next request', async () => {
    // async aiAsk (realistic network latency) so cancel can race the request
    const calls = [];
    const asyncAsk = (q, ctx, cb) => {
        calls.push({ q, hasTools: !!(ctx.tools && ctx.tools.length) });
        setTimeout(() => cb(null, { answer: 'final-answer' }), 0);
    };
    const { reg } = makeRegistry();
    const agent = createAgentManager({ aiAsk: asyncAsk, registry: reg, routeToAgent: router });
    let cbDone = 0;
    agent.run('Apa ibu kota Jepang?', { messages: [{ role: 'user', content: 'Apa ibu kota Jepang?' }] }, () => cbDone++);
    agent.cancel();                       // cancel mid-flight
    await new Promise(r => setTimeout(r, 5));
    assert.equal(cbDone, 0, 'cancelled run renders nothing');
    calls.length = 0;
    const { r } = await settle(agent, 'Jelaskan plocate'); // fresh run
    assert.equal(calls.length, 1, 'next run is independent (1 call)');
    assert.equal(r.answer, 'final-answer');
});

test('LEGACY: no router -> every question uses the agent loop', async () => {
    const calls = [];
    const { reg } = makeRegistry();
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg }); // no routeToAgent
    const { r } = await settle(agent, 'Apa ibu kota Jepang?');
    assert.equal(calls.length, 1); // single call but WITH tools (legacy unchanged behavior)
    assert.equal(calls[0].hasTools, true);
    assert.equal(r.answer, 'final-answer');
});
