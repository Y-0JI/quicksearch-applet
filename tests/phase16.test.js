// Phase 16 behavior tests: the agent must FEEL like a model-driven
// conversational assistant, not a rigid search workflow. These tests assert
// BEHAVIOR (tool result actually used in the answer, multi-step when needed,
// URLs not auto-opened, computer control still gated by permission) — not just
// that a tool call succeeded.
//
// Run under node --test. All platform effects are faked; no network, no shell.

const { test } = require('node:test');
const assert = require('node:assert');
const { createAgentManager } = require('../providers/agentManager.js');
const { createToolRegistry } = require('../providers/toolRegistry.js');

// ---- realistic fakes for the Phase 16 tool set ----

function makeRegistry() {
    const reg = createToolRegistry();
    const seen = { open_url: 0, search_web: 0, launch_app: 0, get_screen: 0, click: 0 };
    reg._seen = seen;

    reg.register({
        id: 'search_web', name: 'Search Web', description: 'web search',
        riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        execute: (a, c, cb) => {
            seen.search_web++;
            // a realistic snippet payload the model must READ and synthesize from
            cb(null, {
                query: a.query,
                count: 2,
                results: [
                    { title: 'BMRI Naik', url: 'https://例.com/bmri', summary: 'BMRI naik 2% hari ini menurut riset X.' },
                    { title: 'BBCA Stabil', url: 'https://例.com/bbca', summary: 'BBCA stabil di level 9.000.' }
                ]
            });
        }
    });
    reg.register({
        id: 'open_url', name: 'Open URL', description: 'open a url',
        riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        execute: (a, c, cb) => {
            seen.open_url++;
            const ok = /^https?:\/\//i.test(String(a.url));
            if (!ok) { cb({ error: 'invalid-url' }); return; }
            cb(null, { opened: a.url });
        }
    });
    reg.register({
        id: 'launch_app', name: 'Launch App', description: 'launch app',
        riskLevel: 'MEDIUM',
        inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
        execute: (a, c, cb) => {
            seen.launch_app++;
            cb(null, { launched: a.app });
        }
    });
    reg.register({
        id: 'click', name: 'Click', description: 'click',
        riskLevel: 'MEDIUM',
        inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
        execute: (a, c, cb) => {
            seen.click++;
            cb(null, { clicked: true, x: a.x, y: a.y });
        }
    });
    reg.register({
        id: 'get_screen', name: 'Get Screen', description: 'screenshot',
        riskLevel: 'LOW',
        inputSchema: { type: 'object', properties: {}, required: [] },
        execute: (a, c, cb) => {
            seen.get_screen++;
            if (!(c && c.capabilities && c.capabilities.vision)) {
                cb({ error: 'vision-not-supported' }); return;
            }
            cb(null, { image: 'data:image/png;base64,AAAA' });
        }
    });
    return reg;
}

// scripted model: one canned response per aiAsk call (last entry repeats)
function scriptedAI(script) {
    const calls = [];
    return {
        calls,
        aiAsk: (question, ctx, cb) => {
            calls.push({ question, ctx });
            const s = script[Math.min(calls.length - 1, script.length - 1)];
            setTimeout(() => { s.err ? cb(s.err, null) : cb(null, s); }, 0);
        }
    };
}

const TC = (id, name, argsJson) => ({ id, name, argsJson });

function settled(agent, question, ctx) {
    return new Promise(resolve => agent.run(question, ctx || { messages: [
        { role: 'user', content: String(question) }] }, (err, res) => resolve({ err, res })));
}

function toolMsgs(aiCall) {
    return aiCall.ctx.messages.filter(m => m.role === 'tool');
}
// tool calls the model actually issued, deduped by id (the conversation
// history repeats earlier assistant turns, so counting raw turns over-counts)
function calledToolNames(ai) {
    const byId = new Map();
    for (const c of ai.calls) {
        const a = c.ctx.messages.filter(m => m.role === 'assistant');
        for (const m of a) for (const tc of (m.tool_calls || [])) byId.set(tc.id, tc.function.name);
    }
    return [...byId.values()];
}

// =====================================================================
// 1. Normal question WITHOUT tool -> one response, no tool called
// =====================================================================
test('P16: general question -> final answer, no tool calls', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([{ answer: 'Fotosintesis adalah proses tanaman membuat makanan.' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const { err, res } = await settled(agent, 'Jelaskan fotosintesis.');
    assert.equal(err, null);
    assert.equal(res.answer, 'Fotosintesis adalah proses tanaman membuat makanan.');
    assert.equal(ai.calls.length, 1);
    assert.deepEqual(calledToolNames(ai), []);
});

// =====================================================================
// 2. Question needs web search -> result READ and USED in final answer
// =====================================================================
test('P16: web search result is fed back and actually used in the answer', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('w1', 'search_web', '{"query":"berita BMRI hari ini"}')] },
        // final answer must incorporate the snippet the tool returned
        { answer: 'Berdasarkan hasil: BMRI naik 2% hari ini (riset X).' }
    ]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const { err, res } = await settled(agent, 'cari berita BMRI hari ini');
    assert.equal(err, null);
    // answer references the tool payload -> model read it, not a raw URL dump
    assert.ok(/BMRI naik 2%/.test(res.answer), 'answer must use search result content');
    // the tool result was present in the context the model saw on its 2nd turn
    const toolResults = toolMsgs(ai.calls[1]);
    assert.equal(toolResults.length, 1);
    assert.ok(/BMRI naik 2%/.test(toolResults[0].content), 'tool result carried the snippet');
    assert.equal(reg._seen.search_web, 1);
});

// =====================================================================
// 3. Search result SUFFICIENT -> model does NOT auto-open URLs
// =====================================================================
test('P16: sufficient search result -> open_url never called (no auto-open)', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('w1', 'search_web', '{"query":"harga emas"}')] },
        { answer: 'Harga emas hari ini naik. Sumber: https://例.com/bmri' }
    ]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const { err, res } = await settled(agent, 'harga emas hari ini?');
    assert.equal(err, null);
    assert.deepEqual(calledToolNames(ai), ['search_web']);
    assert.equal(reg._seen.open_url, 0, 'open_url must NOT be auto-called from search results');
});

// =====================================================================
// 4. Search result INSUFFICIENT but page genuinely needed -> open_url used
//    (correction: this is a scenario where the page is required; the
//     DECISION stays with the model, not a rule that "insufficient => open")
// =====================================================================
test('P16: when a page is genuinely required, model opens it (decision on model)', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('w1', 'search_web', '{"query":"artikel BMRI"}')] },
        // model decides the snippet is not enough AND the user asked to open it
        { toolCalls: [TC('o1', 'open_url', '{"url":"https://例.com/bmri"}')] },
        { answer: 'Dari artikel tersebut: BMRI melaporkan kenaikan laba 2%.' }
    ]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const { err, res } = await settled(agent, 'buka artikel pertama dan jelaskan isinya');
    assert.equal(err, null);
    assert.deepEqual(calledToolNames(ai), ['search_web', 'open_url']);
    assert.equal(reg._seen.open_url, 1, 'open_url used only because the task needs the page');
    assert.equal(reg._seen.search_web, 1);
    const opened = toolMsgs(ai.calls[2]).find(m => m.tool_call_id === 'o1');
    assert.ok(opened && /opened/.test(opened.content));
    assert.ok(/kenaikan laba 2%/.test(res.answer), 'answer uses the opened page content');
});

// =====================================================================
// 5. Multi-step search: search -> refine search -> answer
// =====================================================================
test('P16: multi-step search runs when the model needs more info', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('w1', 'search_web', '{"query":"transfer Chelsea"}')] },
        { toolCalls: [TC('w2', 'search_web', '{"query":"Chelsea pemain baru resmi"}')] },
        { answer: 'Chelsea resmi mendatangkan dua pemain baru musim ini.' }
    ]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const { err, res } = await settled(agent, 'carikan daftar transfer Chelsea terbaru');
    assert.equal(err, null);
    assert.deepEqual(calledToolNames(ai), ['search_web', 'search_web']);
    assert.equal(reg._seen.search_web, 2, 'model ran two search steps before answering');
    assert.equal(res.answer, 'Chelsea resmi mendatangkan dua pemain baru musim ini.');
});

// =====================================================================
// 6. Follow-up uses conversation context ("mana yang paling penting?")
// =====================================================================
test('P16: follow-up question receives prior conversation as context', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([{ answer: 'Yang paling penting: BMRI naik 2% hari ini.' }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg });
    const ctx = { messages: [
        { role: 'user', content: 'cari berita BMRI hari ini' },
        { role: 'assistant', content: 'BMRI naik 2%, BBCA stabil.' },
        { role: 'user', content: 'mana yang paling penting?' }
    ] };
    const { err, res } = await settled(agent, 'mana yang paling penting?', ctx);
    assert.equal(err, null);
    // the agent must forward the prior turns into the model context
    const sent = ai.calls[0].ctx.messages;
    assert.equal(sent[0].role, 'system');
    assert.equal(sent[1].content, 'cari berita BMRI hari ini');
    assert.equal(sent[2].content, 'BMRI naik 2%, BBCA stabil.');
    assert.equal(sent[3].content, 'mana yang paling penting?');
    assert.ok(/BMRI naik 2%/.test(res.answer));
});

// =====================================================================
// 7. Computer Control selection + permission still applies
// =====================================================================
test('P16: computer control chosen for "buka browser", gated by permission', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('l1', 'launch_app', '{"app":"Firefox"}')] },
        { answer: 'Browser sudah saya buka.' }
    ]);
    let confirmed = null;
    const agent = createAgentManager({
        aiAsk: ai.aiAsk, registry: reg,
        policy: { decide: () => 'confirm' },
        requestConfirmation: (req, approve) => { confirmed = req; approve(true); }
    });
    const { err, res } = await settled(agent, 'Buka browser');
    assert.equal(err, null);
    assert.deepEqual(calledToolNames(ai), ['launch_app']);
    assert.ok(confirmed && confirmed.tool === 'launch_app', 'confirmation requested');
    assert.equal(reg._seen.launch_app, 1, 'tool executed only after approval');
    assert.equal(reg._seen.open_url, 0, 'open_url not used for a plain app launch');
    assert.ok(/browser/i.test(res.answer));
});

// =====================================================================
// 8. Computer Control DENIED -> tool never executes, model still answers
// =====================================================================
test('P16: denied computer control -> tool never runs, loop continues', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('l1', 'launch_app', '{"app":"Firefox"}')] },
        { answer: 'Maaf, aksi membuka browser ditolak.' }
    ]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk, registry: reg,
        policy: { decide: () => 'confirm' },
        requestConfirmation: (req, approve) => approve(false)
    });
    const { err, res } = await settled(agent, 'Buka browser');
    assert.equal(err, null);
    assert.equal(reg._seen.launch_app, 0, 'denied -> never executed');
    assert.ok(/ditolak/.test(res.answer));
});

// =====================================================================
// 9. Vision + Computer Control: get_screen -> click
// =====================================================================
test('P16: vision + computer control loop works when screen is needed', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([
        { toolCalls: [TC('s1', 'get_screen', '{}')] },
        { toolCalls: [TC('c1', 'click', '{"x":100,"y":200}')] },
        { answer: 'Sudah saya klik tombol login di layar.' }
    ]);
    const agent = createAgentManager({
        aiAsk: ai.aiAsk, registry: reg,
        hasVision: () => true,
        policy: { decide: () => 'allow' }
    });
    const { err, res } = await settled(agent, 'lihat layar dan klik tombol login');
    assert.equal(err, null);
    assert.deepEqual(calledToolNames(ai), ['get_screen', 'click']);
    assert.equal(reg._seen.get_screen, 1);
    assert.equal(reg._seen.click, 1);
    assert.equal(reg._seen.open_url, 0, 'no page opened during screen+control flow');
    assert.ok(/klik/.test(res.answer));
});

// =====================================================================
// 10. Safety limit -> clear max-steps error (readable upstream)
// =====================================================================
test('P16: runaway tool loop hits safety limit with max-steps error', async () => {
    const reg = makeRegistry();
    const ai = scriptedAI([{ toolCalls: [TC('w1', 'search_web', '{"query":"x"}')] }]);
    const agent = createAgentManager({ aiAsk: ai.aiAsk, registry: reg, maxSteps: 4 });
    const { err, res } = await settled(agent, 'loop terus');
    assert.equal(err && err.error, 'max-steps');
    assert.equal(res, null);
});
