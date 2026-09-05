// NEXT IMPROVEMENT — AI ANSWER DEPTH / DETAIL DETECTION.
// Regression tests for the depth concept (concise | normal | detailed), which is kept SEPARATE
// from completeness:
//   completeness answers "give me ALL the items" (daftar lengkap, full list).
//   depth answers "how DEEP should the explanation go" (detail, rinci, mendalam, ...).
// - detectResponseIntent returns a depth field on every result.
// - "daftar lengkap pemain Chelsea" -> completeness, depth normal (NOT detailed).
// - Explicit depth requests ("detail", "secara mendalam", "secara detail dan lengkap") set
//   depth detailed and, in buildSystemPrompt, REPLACE the default brevity guidance
//   (explicit user depth request overrides default brevity guidance).
const { test } = require('node:test');
const assert = require('node:assert');
const { detectResponseIntent } = require('../ai/responseIntent.js');
const { buildSystemPrompt, INTENT_GUIDANCE, DETAILED_INTENT_GUIDANCE, DEPTH_DETAILED_GUIDANCE, CONCISE_GUIDANCE } = require('../ai/promptBuilder.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
const { createMockWebSearchTool } = require('../ai/webSearchTool.js');

// ── classifier: depth is present and defaults to normal ─────────────────────
test('depth: every detected intent carries a valid depth value', () => {
    const queries = [
        'Cara install aplikasi X',
        'Buat tutorial install Hermes Agent secara detail dan lengkap',
        'Daftar lengkap pemain Chelsea',
        'Jelaskan Docker secara mendalam',
        'Bandingkan Docker dan VM secara detail',
        'Harga saham BBRI hari ini',
        'Kenapa WiFi tidak connect?',
        'Apa itu Docker?'
    ];
    for (const q of queries) {
        const r = detectResponseIntent(q);
        assert.ok(['concise', 'normal', 'detailed'].includes(r.depth), q + ' depth valid, got ' + r.depth);
    }
});

// ── CASE A: plain howto stays depth normal ──────────────────────────────────
test('depth CASE A: "cara install aplikasi X" -> howto, depth normal', () => {
    const r = detectResponseIntent('cara install aplikasi X');
    assert.strictEqual(r.primary, 'howto');
    assert.strictEqual(r.depth, 'normal');
    assert.strictEqual(r.flags.completeness, false);
});

// ── CASE B: explicit "detail dan lengkap" tutorial -> howto, depth detailed ─
test('depth CASE B: "buat tutorial ... secara detail dan lengkap" -> howto, depth detailed', () => {
    const r = detectResponseIntent('buat tutorial cara install aplikasi X secara detail dan lengkap');
    assert.strictEqual(r.primary, 'howto');
    assert.strictEqual(r.depth, 'detailed');
});

// ── CASE C: "daftar lengkap" is completeness, NOT detailed depth ────────────
test('depth CASE C: "daftar lengkap pemain Chelsea" -> completeness, depth normal', () => {
    const r = detectResponseIntent('daftar lengkap pemain Chelsea');
    assert.strictEqual(r.primary, 'list');
    assert.strictEqual(r.flags.completeness, true);
    assert.strictEqual(r.depth, 'normal', 'bare "lengkap" in a list request is completeness, not depth');
});

// ── CASE D: "jelaskan ... secara mendalam" -> explanation, depth detailed ───
test('depth CASE D: "jelaskan Docker secara mendalam" -> explanation, depth detailed', () => {
    const r = detectResponseIntent('jelaskan Docker secara mendalam');
    assert.strictEqual(r.primary, 'explanation');
    assert.strictEqual(r.depth, 'detailed');
});

// ── CASE E: "bandingkan ... secara detail" -> comparison, depth detailed ────
test('depth CASE E: "bandingkan Docker dan VM secara detail" -> comparison, depth detailed', () => {
    const r = detectResponseIntent('bandingkan Docker dan VM secara detail');
    assert.strictEqual(r.primary, 'comparison');
    assert.strictEqual(r.depth, 'detailed');
});

// ── more ID + EN detail markers ─────────────────────────────────────────────
test('depth: additional explicit depth markers (ID + EN)', () => {
    const detailed = [
        'jelaskan cara kerja Docker lebih rinci',
        'bahas Linux Mint lebih lengkap',
        'tolong jangan terlalu singkat, jelaskan lengkap',
        'berikan penjelasan lengkap tentang cara kerja AI',
        'explain how Docker works in depth',
        'give me a comprehensive explanation of virtual machines',
        'explain fully how networking works',
        'write a step by step guide in detail'
    ];
    for (const q of detailed) {
        assert.strictEqual(detectResponseIntent(q).depth, 'detailed', 'expected detailed: ' + q);
    }
});

test('depth: completeness phrases never force detailed depth', () => {
    const normal = [
        'daftar lengkap pemain Chelsea',
        'daftar semua pemain Chelsea',
        'full list of Chelsea players',
        'complete list of Chelsea players',
        'seluruh skuad Chelsea'
    ];
    for (const q of normal) {
        const r = detectResponseIntent(q);
        assert.strictEqual(r.depth, 'normal', 'expected normal depth for list-completeness: ' + q);
        assert.strictEqual(r.flags.completeness, true, 'expected completeness flag: ' + q);
    }
});

test('depth: ordinary efficient queries keep depth normal', () => {
    const normal = [
        'cara install Docker di Linux Mint',
        'Harga saham BBRI hari ini',
        'Spesifikasi laptop ThinkPad X1',
        'Kenapa WiFi Linux Mint tidak connect?',
        'Apa itu Docker?',
        'Siapa presiden Indonesia?',
        'jadwal chelsea'
    ];
    for (const q of normal) {
        assert.strictEqual(detectResponseIntent(q).depth, 'normal', 'expected normal: ' + q);
    }
});

test('depth: explicit brevity requests -> concise (unless detail markers present)', () => {
    assert.strictEqual(detectResponseIntent('jawab singkat saja: siapa presiden Indonesia?').depth, 'concise');
    assert.strictEqual(detectResponseIntent('jelaskan secara singkat apa itu Docker').depth, 'concise');
    assert.strictEqual(detectResponseIntent('answer briefly: what is Docker?').depth, 'concise');
    // "detail" beats "singkat" when both appear (explicit depth request wins)
    assert.strictEqual(detectResponseIntent('jelaskan Docker secara detail, jangan terlalu singkat').depth, 'detailed');
});

// ── prompt builder: detailed guidance overrides default brevity ─────────────
test('depth guidance: detailed howto replaces brevity wording, no conflicts', () => {
    const s = buildSystemPrompt({ intent: { primary: 'howto', depth: 'detailed' } });
    assert.ok(s.includes('The user explicitly requested a detailed answer'), 'depth block present');
    assert.ok(s.includes('Explain each important step'), 'detailed howto step explanation present');
    assert.ok(!s.includes('briefly explain each step'), 'no default brevity step wording');
    assert.ok(!s.includes('Keep steps clear and minimal'), 'no "minimal" brevity wording');
    assert.ok(!s.includes('keep it minimal'), 'no conflicting brevity guidance');
    // normal mode keeps the previous guidance untouched
    const n = buildSystemPrompt({ intent: { primary: 'howto' } });
    assert.ok(n.includes('briefly explain each step'), 'normal howto guidance unchanged');
    assert.ok(!n.includes('The user explicitly requested a detailed answer'), 'no depth block for normal');
});

test('depth guidance: detailed simple/data/comparison all carry depth + no brevity conflict', () => {
    for (const primary of ['simple', 'data', 'comparison', 'explanation', 'current']) {
        const s = buildSystemPrompt({ intent: { primary, depth: 'detailed' } });
        assert.ok(s.includes('The user explicitly requested a detailed answer'), primary + ' depth block present');
        assert.ok(s.includes(DETAILED_INTENT_GUIDANCE[primary]), primary + ' detailed intent guidance present');
        assert.ok(!s.includes('Answer briefly and directly'), primary + ' no default simple brevity wording');
    }
});

test('depth guidance: concise mode appends concise block only', () => {
    const s = buildSystemPrompt({ intent: { primary: 'simple', depth: 'concise' } });
    assert.ok(s.includes('explicitly asked for a short answer'), 'concise block present');
    assert.ok(!s.includes('The user explicitly requested a detailed answer'), 'no detailed block for concise');
});

test('depth guidance: CASE C prompt carries completeness but never detailed depth', () => {
    const intent = detectResponseIntent('daftar lengkap pemain Chelsea');
    const s = buildSystemPrompt({ intent });
    assert.ok(s.includes('explicitly asked for completeness'), 'completeness guidance present');
    assert.ok(!s.includes('The user explicitly requested a detailed answer'), 'list-completeness is not detailed depth');
});

test('detailed intent guidance: every block stays lightweight soft guidance', () => {
    const intents = ['simple', 'explanation', 'data', 'list', 'troubleshooting', 'comparison', 'howto', 'current'];
    for (const name of intents) {
        const g = DETAILED_INTENT_GUIDANCE[name];
        assert.ok(g && g.length > 0, name + ' detailed guidance exists');
        assert.ok(g.length < 400, name + ' detailed guidance stays lightweight');
        assert.ok(!/^\s*(TITLE|SUMMARY|DETAILS|CONCLUSION|FORMAT|TEMPLATE)\b/i.test(g), name + ' is guidance, not a template');
    }
    assert.ok(DEPTH_DETAILED_GUIDANCE && DEPTH_DETAILED_GUIDANCE.length > 0, 'generic depth block exists');
    assert.ok(CONCISE_GUIDANCE && CONCISE_GUIDANCE.length > 0, 'concise block exists');
    assert.ok(!/keep it minimal/i.test(DEPTH_DETAILED_GUIDANCE), 'depth block never says keep it minimal');
});

test('depth guidance: engine carries depth guidance in the payload for a detailed query', async () => {
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
        engine.searchStream('buat tutorial install Hermes Agent secara detail dan lengkap', null, { onComplete: resolve, onError: () => resolve() });
    });
    assert.ok(seenPrompt.includes('The user explicitly requested a detailed answer'), 'detailed depth guidance in payload');
    assert.ok(seenPrompt.includes('Explain each important step'), 'detailed howto explanation in payload');
    assert.ok(!seenPrompt.includes('briefly explain each step'), 'no default brevity guidance in detailed payload');
});

test('depth guidance: engine keeps normal (brief) guidance for a plain query', async () => {
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
    assert.ok(seenPrompt.includes('briefly explain each step'), 'normal howto guidance in payload');
    assert.ok(!seenPrompt.includes('The user explicitly requested a detailed answer'), 'no depth block for plain query');
    assert.ok(INTENT_GUIDANCE.howto.includes('briefly explain each step'), 'INTENT_GUIDANCE normal mode kept');
});
