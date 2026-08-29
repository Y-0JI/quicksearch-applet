const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry, LIMITS } = require('../providers/toolRegistry.js');
const { OPEN_URL } = require('../providers/questionRouter.js');

// ---- fakes ----

function makeRegistry(spy) {
    const reg = createToolRegistry();
    reg.register({
        id: 'search_web', name: 'Search Web', description: 'Web search returning titles, URLs and summaries.', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: (a, c, cb) => { if (spy) spy.search++; cb(null, { query: a.query, count: 2, results: [
            { title: 'A', url: 'https://a.com/1', summary: 'ringkasan a' },
            { title: 'B', url: 'https://b.com/2', summary: 'ringkasan b' }
        ] }); }
    });
    reg.register({
        id: 'open_url', name: 'Open URL', description: 'Open an http(s) URL in the default browser.', riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        execute: (a, c, cb) => { if (spy) spy.open.push(a.url); cb(null, { opened: a.url }); }
    });
    return reg;
}

function scriptedAI(script) {
    const calls = [];
    return {
        calls,
        aiAsk(question, ctx, cb) {
            calls.push({ question, ctx });
            const s = script[Math.min(calls.length - 1, script.length - 1)];
            setTimeout(() => { if (s.err) cb(s.err, null); else cb(null, s); }, 0);
        }
    };
}

function makeAgent(script, spy, extra) {
    const reg = makeRegistry(spy);
    const ai = scriptedAI(script);
    const agent = createAgentManager(Object.assign({
        aiAsk: ai.aiAsk,
        registry: reg
    }, extra || {}));
    return { agent, ai, reg };
}

const TC = (id, name, argsJson) => ({ id, name, argsJson });
function settled(agent, question, ctx) {
    return new Promise(res => agent.run(question, ctx || { messages: [{ role: 'user', content: String(question) }] },
        (err, r) => res({ err, r })));
}
function namesOf(aiCall) { return (aiCall.ctx.tools || []).map(t => t.function.name); }
// count actual search_web EXECUTIONS via the assistant tool_calls in a given ai call
function searchExecsIn(aiCall) {
    const msgs = aiCall.ctx.messages || [];
    let n = 0;
    for (const m of msgs) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) if (tc.function && tc.function.name === 'search_web') n++;
        }
    }
    return n;
}

// ---- intent detector (mirrors router OPEN_URL) ----

test('OPEN_URL regex: explicit open intent detected', () => {
    assert.ok(OPEN_URL.test('buka artikel investor asing borong BMRI'));
    assert.ok(OPEN_URL.test('kunjungi website example.com'));
    assert.ok(OPEN_URL.test('buka link ini'));
    assert.ok(OPEN_URL.test('tampilkan di browser'));
});

test('OPEN_URL regex: research questions NOT detected as open intent', () => {
    assert.ok(!OPEN_URL.test('carikan daftar transfer pemain Chelsea 2026'));
    assert.ok(!OPEN_URL.test('carikan berita BMRI minggu ini'));
    assert.ok(!OPEN_URL.test('rangkum informasi terbaru'));
    assert.ok(!OPEN_URL.test('berapa harga emas hari ini'));
});

// ---- 1 & 2: web research uses search_web, NOT open_url ----

test('web research: open_url tool is NOT offered to the model', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"transfer Chelsea 2026"}')] },
        { answer: 'Berikut daftar transfer...\nSumber:\n- https://a.com/1\n- https://b.com/2' }
    ], spy);
    const { err, r } = await settled(agent, 'carikan daftar transfer pemain Chelsea 2026');
    assert.equal(err, null);
    assert.ok(r.answer.includes('transfer'));
    const offered = namesOf(ai.calls[0]);
    assert.ok(offered.includes('search_web'), 'search_web offered');
    assert.ok(!offered.includes('open_url'), 'open_url must be hidden for research');
});

test('web research: model cannot open result URLs (backstop)', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] },
        // model wrongly tries to open a result URL even on research question
        { toolCalls: [TC('o1', 'open_url', '{"url":"https://a.com/1"}')] },
        { answer: 'jawaban' }
    ], spy);
    const { err } = await settled(agent, 'carikan berita BMRI minggu ini');
    assert.equal(err, null);
    assert.equal(spy.open.length, 0, 'no browser opened for research question');
    // model received a not-requested tool message, not a success
    const toolMsgs = ai.calls[2].ctx.messages.filter(m => m.role === 'tool');
    assert.ok(toolMsgs.some(m => m.content.includes('open-url-not-requested')));
});

// ---- 3: explicit "buka artikel" still offers open_url ----

test('explicit open request: open_url IS offered and executes', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('o1', 'open_url', '{"url":"https://example.com/artikel"}')] },
        { answer: 'dibuka' }
    ], spy);
    const { err } = await settled(agent, 'buka artikel investor asing borong BMRI');
    assert.equal(err, null);
    assert.ok(namesOf(ai.calls[0]).includes('open_url'), 'open_url offered for explicit request');
    assert.deepEqual(spy.open, ['https://example.com/artikel'], 'browser opened exactly once');
});

// ---- 4: search result becomes the answer input ----

test('web research: exactly one search_web execution, no open_url rounds', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"transfer Chelsea"}')] },
        { answer: 'Hasil: Chelsea merekrut pemain X. Sumber: https://a.com/1' }
    ], spy);
    const { r } = await settled(agent, 'carikan daftar transfer pemain Chelsea 2026');
    assert.equal(spy.search, 1, 'single search_web execution');
    assert.equal(spy.open.length, 0, 'no open_url execution');
    assert.ok(r.answer.includes('https://a.com/1'));
});

// ---- 5: multiple search_web allowed if first insufficient ----

test('web research: multiple search_web calls allowed (refined query)', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"transfer Chelsea 2026"}')] },
        { toolCalls: [TC('w2', 'search_web', '{"query":"Chelsea transfers summer 2026 confirmed"}')] },
        { answer: 'gabungan hasil' }
    ], spy);
    const { err, r } = await settled(agent, 'carikan daftar transfer pemain Chelsea 2026');
    assert.equal(err, null);
    assert.equal(r.answer, 'gabungan hasil');
    assert.equal(spy.search, 2, 'multiple search_web allowed');
    assert.equal(spy.open.length, 0, 'still no open_url');
});

// ---- 6: agent does not burn steps opening many URLs ----

test('web research: model cannot spam open_url (guardrail stops browser, run finishes)', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] },
        { toolCalls: [TC('o1', 'open_url', '{"url":"https://a.com/1"}')] },
        { toolCalls: [TC('o2', 'open_url', '{"url":"https://b.com/2"}')] },
        { answer: 'jawaban akhir' }
    ], spy);
    const { err } = await settled(agent, 'carikan berita BMRI minggu ini');
    assert.equal(err, null);
    assert.equal(spy.open.length, 0, 'no URL opened despite repeated open_url attempts');
});

// ---- 7: source URLs remain in answer (clickable handled by UI) ----

test('web research: answer retains source URLs as text', async () => {
    const spy = { search: 0, open: [] };
    const { agent, ai } = makeAgent([
        { toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] },
        { answer: 'Info. Sumber:\n- https://a.com/1\n- https://b.com/2' }
    ], spy);
    const { r } = await settled(agent, 'carikan informasi harga saham BMRI');
    assert.ok(r.answer.includes('https://a.com/1'));
    assert.ok(r.answer.includes('https://b.com/2'));
});

// ---- 8/9: cancellation + max-steps still work ----

test('cancellation still safe with guardrail', async () => {
    const spy = { search: 0, open: [] };
    const ai = scriptedAI([{ toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] }, { answer: 'n' }]);
    let released = false;
    const agent = createAgentManager({
        aiAsk: ai.aiAsk, registry: makeRegistry(spy),
        makeCancellable: () => ({ cancel: () => { released = true; } })
    });
    let cb = 0;
    agent.run('cari berita', { messages: [{ role: 'user', content: 'cari berita' }] }, () => cb++);
    agent.cancel();
    await new Promise(r => setTimeout(r, 10));
    assert.ok(released);
    assert.equal(cb, 0);
});

test('max-steps still enforced with guardrail', async () => {
    const spy = { search: 0, open: [] };
    const ai = scriptedAI([{ toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: makeRegistry(spy) });
    const { err } = await settled(agent, 'cari berita');
    assert.equal(err.error, 'max-steps');
    assert.equal(err.steps, LIMITS.maxAgentSteps);
});
