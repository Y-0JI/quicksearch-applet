// AI naturalization phase — citation cleanup + source integrity regression tests.
// P1/P2  : raw "[1]" / "[1][2]" markers never appear in the visible answer text.
// P3/P4  : source metadata stays attached per response (Sources · N accuracy, no cross-talk).
// P13-15 : safe cleanup (no damage to prices/dates/percents/code/markdown) + naturalization prompt.
const { test } = require('node:test');
const assert = require('node:assert');
const { cleanAnswerCitations, MAX_CITATION_INDEX } = require('../ai/citationCleaner.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockAiProvider, createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
const convMod = require('../ai/conversationState.js');
const { buildSystemPrompt } = require('../ai/promptBuilder.js');

// ── P13-CASE A/B: single + stacked + comma-list citation markers are removed ──
test('citation cleanup: single marker removed', () => {
    assert.strictEqual(cleanAnswerCitations('Harga BMRI Rp4.450 [1]'), 'Harga BMRI Rp4.450');
});

test('citation cleanup: stacked and comma-list markers removed', () => {
    assert.strictEqual(cleanAnswerCitations('Harga naik [1][2][3]'), 'Harga naik');
    assert.strictEqual(cleanAnswerCitations('Data [1][3][5] dirangkum'), 'Data dirangkum');
    assert.strictEqual(cleanAnswerCitations('Rentang [1, 2] dan [1,2,3]'), 'Rentang dan');
});

// ── P13-CASE C: normal numbers / prices / percents never damaged ──
test('citation cleanup: prices, percents, years untouched', () => {
    const t = 'Harga Rp4.450 naik 4% pada tahun 2026, rentang Rp4.420\u2013Rp4.470';
    assert.strictEqual(cleanAnswerCitations(t), t);
});

// ── P13-CASE D: dates untouched ──
test('citation cleanup: dates untouched', () => {
    const t = 'Pada 4 September 2026 harga tercatat Rp4.450';
    assert.strictEqual(cleanAnswerCitations(t), t);
});

// ── P13-CASE E: non-citation brackets preserved ──
test('citation cleanup: non-citation bracket content preserved', () => {
    assert.strictEqual(cleanAnswerCitations('Kode [alpha] dan [beta] valid'), 'Kode [alpha] dan [beta] valid');
    assert.strictEqual(cleanAnswerCitations('Versi [1.5] dirilis'), 'Versi [1.5] dirilis');
    assert.strictEqual(cleanAnswerCitations('Total [10] item tersedia'), 'Total [10] item tersedia'); // > MAX_CITATION_INDEX
});

test('citation cleanup: code blocks and inline code preserved verbatim', () => {
    const fenced = '```js\nconst a = [1, 2, 3];\n```\nRingkasan [1]';
    assert.strictEqual(cleanAnswerCitations(fenced), '```js\nconst a = [1, 2, 3];\n```\nRingkasan');
    const inline = 'pakai `[1, 2]` sebagai data lalu selesai [3]';
    assert.strictEqual(cleanAnswerCitations(inline), 'pakai `[1, 2]` sebagai data lalu selesai');
});

test('citation cleanup: markdown link and escaped bracket preserved', () => {
    assert.strictEqual(cleanAnswerCitations('Lihat [1](https://example.com)'), 'Lihat [1](https://example.com)');
    assert.strictEqual(cleanAnswerCitations('Literal \\[1\\] tetap'), 'Literal \\[1\\] tetap');
});

test('citation cleanup: maxIndex option bounds removal; empty/no-op safe', () => {
    assert.strictEqual(cleanAnswerCitations('A [1] B [2] C [3]', { maxIndex: 2 }), 'A B C [3]');
    assert.strictEqual(cleanAnswerCitations(''), '');
    assert.strictEqual(cleanAnswerCitations(null), '');
    assert.strictEqual(MAX_CITATION_INDEX, 5);
});

// ── P13-CASE F + P3: grounded engine answer stripped, sources metadata intact ──
test('engine grounded answer: markers removed from text, sources + count intact', async () => {
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [
            { title: 'Source A', url: 'https://example.com/a', snippet: 'snippet a' },
            { title: 'Source B', url: 'https://example.com/b', snippet: 'snippet b' }
        ])
    });
    // P3 web-first: live query ('harga bmri') searches FIRST engine-side; the provider only
    // receives the single grounded payload and answers directly (no tool_call first leg).
    const provider = createMockAiProvider({
        responses: [
            { type: 'answer', text: 'Harga saham BMRI hari ini berada di sekitar Rp4.450 [1]. Pergerakan tipis dibanding penutupan sebelumnya [2].' }
        ]
    });
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true });
    const got = await new Promise((resolve) => {
        engine.search('harga bmri', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got, 'grounded answer delivered');
    assert.strictEqual(got.text, 'Harga saham BMRI hari ini berada di sekitar Rp4.450. Pergerakan tipis dibanding penutupan sebelumnya.');
    assert.strictEqual(got.grounded, true);
    assert.ok(Array.isArray(got.sources) && got.sources.length === 2, 'sources preserved, got ' + got.sources.length);
    assert.ok(got.sources.every(s => /^web-\d+$/.test(s.id)), 'canonical source ids kept');
});

// ── ungrounded answers are never altered (no numbered evidence -> not pipeline citations) ──
test('engine ungrounded answer: bracket content untouched', async () => {
    const provider = createMockAiProvider({
        responses: [{ type: 'answer', text: 'Langkah [1] selesai, total [10] item.' }]
    });
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'T', url: 'https://example.com/t', snippet: 's' }])
    });
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: false });
    const got = await new Promise((resolve) => {
        engine.search('q', { onAnswer: d => resolve(d), onError: () => resolve(null) });
    });
    assert.ok(got, 'answer delivered');
    assert.strictEqual(got.text, 'Langkah [1] selesai, total [10] item.');
    assert.strictEqual(got.grounded, false);
});

// ── streaming grounded leg: deltas + complete cleaned, markers never reach the UI text ──
test('engine streaming grounded: cleaned deltas and final text, sources kept', async () => {
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [
            { title: 'A', url: 'https://example.com/a', snippet: 'sa' },
            { title: 'B', url: 'https://example.com/b', snippet: 'sb' }
        ])
    });
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            if (payload && payload.groundingContext) {
                onEvent({ type: 'start' });
                onEvent({ type: 'delta', text: 'Harga BMRI sekitar Rp4.450 [1].' });
                onEvent({ type: 'delta', text: ' Tutup sebelumnya Rp4.460 [2].' });
                onEvent({ type: 'complete', result: { text: 'Harga BMRI sekitar Rp4.450 [1]. Tutup sebelumnya Rp4.460 [2].', sources: [], grounded: false } });
            } else {
                onEvent({ type: 'tool_call', tool: 'web_search', arguments: { query: 'harga bmri' } });
            }
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true });
    const deltas = [];
    const got = await new Promise((resolve) => {
        engine.searchStream('harga bmri', null, {
            onDelta: (chunk, full) => deltas.push(full),
            onComplete: d => resolve(d),
            onError: () => resolve(null)
        });
    });
    assert.ok(got, 'streaming grounded complete');
    assert.deepStrictEqual(deltas, [
        'Harga BMRI sekitar Rp4.450.',
        'Harga BMRI sekitar Rp4.450. Tutup sebelumnya Rp4.460.'
    ]);
    assert.strictEqual(got.text, 'Harga BMRI sekitar Rp4.450. Tutup sebelumnya Rp4.460.');
    assert.ok(Array.isArray(got.sources) && got.sources.length === 2, 'grounded sources kept');
});

// ── P3 (AI Pipeline V3): no ungrounded first-answer fallback for live queries anymore ──
test('engine live query: grounded AI failure surfaces as error (no hidden draft fallback)', async () => {
    const webTool = createMockWebSearchTool({
        handler: (query, cancellable, cb) => cb(null, [{ title: 'T', url: 'https://example.com/t', snippet: 's' }])
    });
    const provider = createMockAiProvider({
        handler: (payload, cb) => {
            const e = new Error('grounded leg failed');
            e.code = 'provider_error';
            return cb(e);
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: webTool, enableGrounding: true });
    let errCode = null;
    const got = await new Promise((resolve) => {
        engine.search('harga bitcoin terbaru', { onAnswer: d => resolve(d), onError: (e) => { errCode = e && e.code; resolve(null); } });
    });
    assert.strictEqual(got, null, 'no ungrounded draft answer delivered on grounded failure');
    assert.strictEqual(errCode, 'provider_error', 'existing error policy surfaces');
});

// ── P14: sources stay isolated per assistant message (A=5, B=3, A unchanged) ──
test('P14 source isolation: each assistant message keeps exactly its own sources', () => {
    function srcSet(n, tag) {
        return Array.from({ length: n }, (_, k) => ({
            id: 'web-' + (k + 1),
            title: tag + ' ' + (k + 1),
            url: 'https://' + tag + '.example.com/' + (k + 1),
            domain: tag + '.example.com',
            snippet: 's' + (k + 1)
        }));
    }
    const conv = convMod.createConversation();
    let s = convMod.rapidSend(conv, 'Request A');
    convMod.completeAssistant(conv, s.assistantId, 'Answer A', srcSet(5, 'a'));
    s = convMod.rapidSend(conv, 'Request B');
    convMod.completeAssistant(conv, s.assistantId, 'Answer B', srcSet(3, 'b'));

    const msgs = convMod.getMessages(conv);
    const a = msgs.find(m => m.role === 'assistant' && m.content === 'Answer A');
    const b = msgs.find(m => m.role === 'assistant' && m.content === 'Answer B');
    assert.ok(a && b, 'both assistant answers present');
    assert.strictEqual(a.sources.length, 5, 'A keeps 5 sources');
    assert.strictEqual(b.sources.length, 3, 'B keeps 3 sources');
    assert.strictEqual(a.sources[0].url, 'https://a.example.com/1', 'A source not overwritten by B');
    // no shared mutable array: mutating B must not affect A
    b.sources.push({ id: 'web-4', title: 'x', url: 'https://x.example.com/', domain: 'x.example.com', snippet: 'x' });
    assert.strictEqual(a.sources.length, 5, 'A unaffected after B mutation');
});

// ── P9/P15: system prompt forbids visible markers + keeps naturalization rules ──
test('system prompt: no visible citation markers, naturalization + interpretation rules', () => {
    const s = buildSystemPrompt();
    assert.ok(!s.includes('Prefer citation at the end of the relevant paragraph'), 'old inline-citation instruction gone');
    assert.ok(!s.includes('Avoid excessive stacks like [1][2][3][4]'), 'marker-stack instruction gone');
    assert.ok(s.includes('do not print citation markers'), 'no visible markers rule present');
    assert.ok(s.includes('Do not expose internal search indexes'), 'no internal metadata rule present');
    assert.ok(s.includes('visible answer'), 'visible answer concept present');
    assert.ok(s.includes('unsupported facts'), 'no unsupported facts rule present');
    assert.ok(s.includes('Distinguish factual data from interpretation'), 'interpretation rule present');
    assert.ok(s.includes('buy/sell or market predictions'), 'no-prediction guard present');
});
