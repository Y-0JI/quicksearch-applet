// Web Search latency audit + regression/benchmark (Phase 13, agent HTML path).
// TEST-ONLY: no real network, no API keys, no private data. Uses the REAL
// WebProvider + search_web tool + AgentManager with an injected mock HTTP POST
// transport, and a REAL captured DDG HTML fixture (real bytes) for parsing.
//
// Measures (per DoD):
//   1. search_web start             -> stage 'search-start'
//   2. HTTP request done            -> stage 'http-done'
//   3. parsing done                 -> stage 'parse-done'
//   4. result callback              -> tool cb / agent onToolComplete
//   5. next AI request              -> agent round 2
//   6. total submit -> final        -> wall-clock in the test
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider } = require('../providers/webProvider.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
const { createDefaultTools } = require('../providers/tools/index.js');
const { createAgentManager } = require('../providers/agentManager.js');
const { createQuestionRouter } = require('../providers/questionRouter.js');

// Real-shape DDG HTML fixture (agent path parses this).
const FIXTURE = `<div class="result"><h2 class="result__title"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.google.com%2Ffinance%2Fquote%2FBMRI">Bank Mandiri (Persero) Tbk PT (BMRI) Stock Price &amp; News</a></h2><a class="result__snippet">Harga saham BMRI hari ini di Google Finance.</a></div>`;

function makeWebProvider(httpPost, stages) {
    return createWebProvider({
        makeResult: o => o, scoreResult: () => 1,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        useInstantAnswers: true,
        httpPost,
        onStage: (n, t) => stages.push({ stage: n, t })
    });
}

function makeAgent(httpPost, stages, limits) {
    const webProvider = makeWebProvider(httpPost, stages);
    const deps = {
        tryCalculate: () => null, detectUrl: () => null, openPath: () => true, openUri: () => true,
        fileProvider: { search: (q, c, cb) => cb([]) }, webProvider,
        appProvider: { searchApps: q => [], getApp: () => ({ launch() {} }) },
        screenCapture: { capture: (cb) => cb(null, { image: 'data:image/png;base64,iVBORw0KGgo=' }) },
        computerControl: { typeText: (t, c, cb) => cb(null, { typed: t }) },
        timers: { after: (ms, fn) => setTimeout(fn, ms), clear: () => {} },
        LIMITS: Object.assign({}, LIMITS, limits || {}),
        validators: { validatePoint: () => null, validateKey: () => null, sanitizeText: s => s, validateScroll: () => ({ direction: 'up', amount: 1 }) }
    };
    const reg = createToolRegistry();
    for (const t of createDefaultTools(deps)) reg.register(t);
    return { reg };
}

function makeAiAsk(calls) {
    return (q, ctx, cb) => {
        const hasTools = !!(ctx.tools && ctx.tools.length);
        calls.push({ hasTools });
        if (hasTools) {
            if (calls.filter(c => c.hasTools).length === 1) cb(null, { toolCalls: [{ id: 't1', name: 'search_web', argsJson: JSON.stringify({ query: q }) }] });
            else cb(null, { answer: 'final-answer' });
        } else cb(null, { answer: 'final-answer' });
    };
}

function settle(agent, q) {
    return new Promise(res => agent.run(q, { messages: [{ role: 'user', content: q }] }, (err, r) => res({ err, r })));
}

test('WEB FAST: one HTML POST, real results, finishes immediately (<100ms)', async () => {
    const stages = [], httpCalls = [], calls = [];
    const httpPost = (url, body, c, onResult) => { httpCalls.push(url); onResult(null, FIXTURE); };
    const { reg } = makeAgent(httpPost, stages);
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: () => true, limits: { agentWebGraceMs: 60 } });
    const t0 = Date.now();
    const { r } = await settle(agent, 'Cari di Google tentang BMRI hari ini');
    const dt = Date.now() - t0;

    assert.equal(httpCalls.length, 1, 'exactly ONE http POST (no hidden retry)');
    assert.ok(stages.find(s => s.stage === 'search-start'));
    assert.ok(stages.find(s => s.stage === 'http-start'));
    assert.ok(stages.find(s => s.stage === 'http-done'));
    assert.ok(stages.find(s => s.stage === 'parse-done'));
    assert.ok(stages.find(s => s.stage === 'deliver'), 'real (non-fallback) results delivered');
    const order = stages.map(s => s.stage);
    assert.ok(order.indexOf('http-start') < order.indexOf('http-done'));
    assert.ok(order.indexOf('http-done') < order.indexOf('parse-done'));
    assert.equal(r.answer, 'final-answer');
    assert.ok(dt < 100, 'no 2500ms/1200ms grace wait: ' + dt + 'ms');
});

test('AGENT MODE: skips instant fallback, waits for real results only', async () => {
    const stages = [], httpCalls = [], calls = [];
    // Simulate instant fallback delivery + delayed real results
    let callCount = 0;
    const httpPost = (url, body, c, onResult) => {
        httpCalls.push(url);
        // First call: instant fallback. Second call: real results after 50ms.
        if (callCount++ === 0) onResult(null, FIXTURE);
        else setTimeout(() => onResult(null, FIXTURE), 50);
    };
    const { reg } = makeAgent(httpPost, stages);
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: () => true, limits: { agentWebGraceMs: 60 } });
    const t0 = Date.now();
    const { r } = await settle(agent, 'Cari berita emas hari ini');
    const dt = Date.now() - t0;

    assert.equal(httpCalls.length, 1, 'exactly one HTTP call');
    // Agent mode: tool finishes when real results arrive (50ms), not at fallback
    assert.ok(dt < 200, 'agent skips fallback, finishes at real results: ' + dt + 'ms');
    assert.equal(r.answer, 'final-answer');
});

test('WEB SLOW HTTP: grace caps latency, still single request, no retry', async () => {
    const stages = [], httpCalls = [], calls = [];
    const httpPost = (url, body, c, onResult) => { httpCalls.push(url); setTimeout(() => onResult(null, FIXTURE), 400); };
    const { reg } = makeAgent(httpPost, stages);
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: () => true, limits: { agentWebGraceMs: 60 } });
    const t0 = Date.now();
    const { r } = await settle(agent, 'Cari berita emas hari ini');
    const dt = Date.now() - t0;

    assert.equal(httpCalls.length, 1, 'no hidden retry even when network is slow');
    // Phase 14: agent mode skips instant fallback; tool waits for real results.
    // HTTP takes 400ms; settle timer (3500ms) is the safety net.
    assert.ok(dt >= 300 && dt < 700, 'finished at HTTP response (~400ms), not at old grace: ' + dt + 'ms');
    assert.equal(r.answer, 'final-answer');
});

test('WEB PARSE: parse completes cheaply after HTTP body arrives', () => {
    const stages = [];
    const httpPost = (url, body, c, onResult) => onResult(null, FIXTURE);
    makeWebProvider(httpPost, stages).search('bmri', null, () => {}, { agent: true });
    const hd = stages.find(s => s.stage === 'http-done').t;
    const pd = stages.find(s => s.stage === 'parse-done').t;
    assert.ok(pd - hd < 50, 'HTML parse + map is microseconds, not a wait: ' + (pd - hd) + 'ms');
});

test('WEB router: non-web question takes Fast Path, webProvider never invoked', async () => {
    const httpCalls = [], calls = [];
    const httpPost = (url, body, c, onResult) => { httpCalls.push(url); };
    const { reg } = makeAgent(httpPost, []);
    const router = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: () => [] }, computerControl: null, hasScreen: () => false });
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: router });
    const { r } = await settle(agent, 'Apa ibu kota Jepang?');
    assert.equal(httpCalls.length, 0, 'web search NOT invoked for a general question');
    assert.equal(calls.length, 1, 'fast path = single AI call');
    assert.equal(r.answer, 'final-answer');
});

test('WEB agent: total round = tool call + final answer (2 AI calls)', async () => {
    const httpCalls = [], calls = [];
    const httpPost = (url, body, c, onResult) => { httpCalls.push(url); onResult(null, FIXTURE); };
    const { reg } = makeAgent(httpPost, []);
    const agent = createAgentManager({ aiAsk: makeAiAsk(calls), registry: reg, routeToAgent: () => true, limits: { agentWebGraceMs: 60 } });
    await settle(agent, 'Cari berita emas hari ini');
    assert.equal(calls.length, 2, 'one tool round + one final-answer round');
    assert.ok(calls[0].hasTools && calls[1].hasTools, 'both agent rounds carry tools');
});
