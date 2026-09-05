// FINAL REFINEMENT — natural language, contextual explanation & human-like answers.
// Regression tests for the natural-response style guidance in the prompt builder:
// - CORE carries the "assistant directly helping a person" guidance (complete sentences,
//   connected ideas, no telegram-style fragments) on every request.
// - Per-intent guidance is soft style guidance, not output templates: natural conclusion for
//   data, explained steps for howto, paragraph-first for simple/explanation.
// - The refined guidance actually reaches the provider payload (engine integration).
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, CORE_SYSTEM_PROMPT, INTENT_GUIDANCE } = require('../ai/promptBuilder.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

// ── CORE: human-assistant naturalness guidance is present for every request ──
test('core prompt: answers like an assistant helping a person, with natural flowing sentences', () => {
    for (const opts of [{}, { intent: { primary: 'list' } }, { intent: { primary: 'current' }, grounded: true }]) {
        const s = buildSystemPrompt(opts);
        assert.ok(s.includes('assistant who is directly helping a person'), 'human-assistant persona guidance present');
        assert.ok(s.includes('complete, natural sentences'), 'complete-sentence guidance present');
        assert.ok(s.includes('connect related ideas'), 'connect-info guidance present');
        assert.ok(s.includes('telegram style'), 'no-fragment (telegram style) rule present');
    }
});

test('core prompt: formatting stays restraint-first — paragraphs preferred, lists reserved for value', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('Use readable formatting only when useful'), 'formatting restraint rule kept');
    assert.ok(s.includes('prefer natural paragraphs'), 'paragraphs preferred for explanations/tutorials');
    assert.ok(s.includes('use a simple list only for items, steps, comparisons or numbers'), 'lists reserved for real value');
});

// ── INTENT guidance: soft style guidance, not forced templates ──
test('intent guidance: simple stays paragraph-first and list-free', () => {
    const g = INTENT_GUIDANCE.simple;
    assert.ok(g.includes('Answer briefly and directly'), 'direct-answer marker kept');
    assert.ok(g.includes('short, natural paragraph'), 'paragraph-first guidance');
    assert.ok(!/use a (clear )?list/i.test(g), 'simple never instructs a list');
});

test('intent guidance: explanation teaches connections (what → why → how)', () => {
    const g = INTENT_GUIDANCE.explanation;
    assert.ok(g.includes('Answer with a natural core explanation first'), 'explanation marker kept');
    assert.ok(g.includes('how the pieces connect'), 'explains relations, not just facts');
    assert.ok(g.includes('what, why, how'), 'Apa → Kenapa → Bagaimana flow');
});

test('intent guidance: data opens with a natural conclusion, not a data dump', () => {
    const g = INTENT_GUIDANCE.data;
    assert.ok(g.includes('Open with one short natural conclusion'), 'natural conclusion first');
    assert.ok(g.includes('Harga BMRI hari ini berada di Rp4.450'), 'concrete natural example');
    assert.ok(/use a list only for numbers/i.test(g), 'bullets only for numbers/items');
});

test('intent guidance: howto explains each step, not just bare commands', () => {
    const g = INTENT_GUIDANCE.howto;
    assert.ok(g.includes('ordered steps numbered 1. 2. 3.'), 'numbered steps marker kept');
    assert.ok(g.includes('briefly explain each step'), 'steps carry explanation');
});

test('intent guidance: every block stays lightweight soft guidance (no template shapes)', () => {
    const intents = ['simple', 'explanation', 'data', 'list', 'troubleshooting', 'comparison', 'howto', 'current'];
    for (const name of intents) {
        const g = INTENT_GUIDANCE[name];
        assert.ok(g && g.length > 0, name + ' guidance exists');
        assert.ok(g.length < 400, name + ' guidance stays lightweight');
        assert.ok(!/^\s*(TITLE|SUMMARY|DETAILS|CONCLUSION|FORMAT|TEMPLATE)\b/i.test(g), name + ' is guidance, not a template');
        // final refinement: guidance must not read like a forced rulebook of uppercase directives
        assert.ok(!/WAJIB|HARUS|SELALU\b/i.test(g), name + ' has no forced-template wording');
    }
});

// ── Engine integration: refined guidance reaches the real provider payload ──
test('engine: howto query payload carries the explained-steps guidance', async () => {
    let seenPrompt = '';
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            seenPrompt = payload.systemPrompt || '';
            onEvent({ type: 'start' });
            onEvent({ type: 'complete', result: { text: 'ok', sources: [], grounded: false } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool(), enableGrounding: false });
    await new Promise((resolve) => {
        engine.searchStream('Cara install Docker di Linux Mint', null, { onComplete: resolve, onError: () => resolve() });
    });
    assert.ok(seenPrompt.includes('ordered steps numbered'), 'howto guidance in payload');
    assert.ok(seenPrompt.includes('briefly explain each step'), 'explained-steps guidance in payload');
    assert.ok(seenPrompt.includes('assistant who is directly helping a person'), 'core naturalness in payload');
});

test('engine: data query payload opens with a natural conclusion, not a raw table', async () => {
    let seenPrompt = '';
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            seenPrompt = payload.systemPrompt || '';
            onEvent({ type: 'start' });
            onEvent({ type: 'complete', result: { text: 'ok', sources: [], grounded: false } });
        }
    });
    const engine = createAISearchEngine({ provider, webSearchTool: createMockWebSearchTool(), enableGrounding: false });
    await new Promise((resolve) => {
        engine.searchStream('Spesifikasi laptop ThinkPad X1', null, { onComplete: resolve, onError: () => resolve() });
    });
    assert.ok(seenPrompt.includes('Open with one short natural conclusion'), 'data guidance in payload');
    assert.ok(seenPrompt.includes(CORE_SYSTEM_PROMPT), 'core always present in payload');
});