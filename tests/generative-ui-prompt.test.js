// G3 structured-response generation guidance tests (static, no network).
// Prompt must offer text_only as OPTIONAL mode, never force JSON.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const promptBuilder = require('../ai/promptBuilder.js');
const contract = require('../ai/generativeUiContract.js');
const genUi = require('../ai/generativeUi.js');

function fullPrompt() {
    return promptBuilder.buildSystemPrompt({ intent: { primary: 'simple', flags: {}, depth: 'normal' } });
}

// G3-1: normal Markdown fallback untouched
test('G3-1: core prompt keeps Markdown default', () => {
    const p = fullPrompt();
    assert.ok(p.indexOf('Markdown') !== -1, 'Markdown guidance present');
    assert.ok(promptBuilder.CORE_SYSTEM_PROMPT.indexOf('Markdown') !== -1, 'core keeps Markdown');
});

// G3-2: valid text_only envelope matches G0 contract
test('G3-2: text_only example parses via G0/G1', () => {
    const raw = JSON.stringify({ ui_type: 'text_only', version: 1, summary: 'Done in 3 steps.', data: {} });
    assert.strictEqual(contract.parseGenerativeUIResponse(raw).valid, true);
    assert.strictEqual(genUi.resolveAssistantUi(raw).ui_type, 'text_only');
});

// G3-3: prompt never forces JSON
test('G3-3: prompt does not force all responses to JSON', () => {
    const p = fullPrompt().toLowerCase();
    assert.ok(p.indexOf('always respond with json') === -1);
    assert.ok(p.indexOf('always respond in json') === -1);
    assert.ok(p.indexOf('all responses must') === -1);
    assert.ok(p.indexOf('respond only in json') === -1);
    assert.ok(promptBuilder.STRUCTURED_UI_GUIDANCE, 'guidance exported');
});

// G3-4: generation limited to text_only
test('G3-4: prompt restricts structured UI to text_only', () => {
    const g = String(promptBuilder.STRUCTURED_UI_GUIDANCE);
    assert.ok(g.indexOf('text_only') !== -1);
    assert.ok(/only\s+("text_only"|'text_only'|text_only)/i.test(g) || /do not use (weather|stock|sports)/i.test(g),
        'text_only is the only generatable type');
    for (const t of ['weather_card', 'stock_chart', 'sports_card']) {
        assert.ok(g.indexOf(t) === -1 || /do not use|not yet|unsupported|only text_only/i.test(g),
            t + ' must not be offered as generatable');
    }
});

// G3-5: no Markdown fence for structured output
test('G3-5: prompt forbids fences around structured JSON', () => {
    const g = String(promptBuilder.STRUCTURED_UI_GUIDANCE).toLowerCase();
    assert.ok(g.indexOf('fence') !== -1 || g.indexOf('```') !== -1, 'fence rule present');
    assert.ok(/no .*fence|without .*fence|never .*fence|do not .*fence/i.test(g), 'fences forbidden');
});

// G3-6: Markdown preserved for conversational/tutorial/coding/troubleshooting
test('G3-6: prompt keeps Markdown for long-form answers', () => {
    const g = String(promptBuilder.STRUCTURED_UI_GUIDANCE).toLowerCase();
    for (const w of ['markdown', 'tutorial', 'troubleshoot', 'code']) {
        assert.ok(g.indexOf(w) !== -1, w + ' mentioned');
    }
});

// G3-7: malformed JSON still fail-closed via G0/G1
test('G3-7: malformed structured output fails closed', () => {
    assert.strictEqual(contract.parseGenerativeUIResponse('{bad').valid, false);
    assert.strictEqual(genUi.resolveAssistantUi('{bad'), null);
    assert.strictEqual(genUi.resolveAssistantUi('text ' + JSON.stringify({ ui_type: 'text_only', version: 1, summary: 's', data: {} })), null);
});

// G3-8: no Generative UI parsing in onDelta
test('G3-8: onDelta has no structured parsing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    const runFn = src.slice(src.indexOf('_runAIRequestStream'));
    const open = runFn.indexOf('{', runFn.indexOf('onDelta: function'));
    let depth = 0, end = -1;
    for (let i = open; i < runFn.length; i++) {
        if (runFn[i] === '{') depth++;
        else if (runFn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const deltaBody = runFn.slice(open, end + 1);
    for (const s of ['resolveAssistantUi', 'describeGenerativeUi', 'buildGenerativeUiActor', 'parseGenerativeUIResponse']) {
        assert.ok(deltaBody.indexOf(s) === -1, 'onDelta free of ' + s);
    }
});
