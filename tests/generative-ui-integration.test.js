// G1 Generative UI integration tests (AI Search only, Search frozen).
// - ai/generativeUi.js: resolveAssistantUi(text) -> value|null, never throws
// - applet.js wiring: parse ONLY after complete, never in onDelta,
//   msg.content unchanged, msg.ui = value|null (no {valid,reason} stored).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const genUi = require('../ai/generativeUi.js');

function env(ui_type, overrides) {
    return JSON.stringify(Object.assign({
        ui_type: ui_type,
        version: 1,
        summary: 'ok',
        data: {}
    }, overrides || {}));
}

// ── A. Normal Markdown response → null, text path stays ──
test('G1-A: normal Markdown resolves to null', () => {
    assert.strictEqual(genUi.resolveAssistantUi('Hello, this is a normal answer.'), null);
    assert.strictEqual(genUi.resolveAssistantUi('# Title\n\nSome **bold** text with `code`.'), null);
});

// ── B. Valid text_only envelope → value attached, content untouched ──
test('G1-B: valid envelope resolves to renderable value only', () => {
    const raw = env('text_only', { summary: 'hi', data: { city: 'Jakarta' } });
    const ui = genUi.resolveAssistantUi(raw);
    assert.ok(ui && typeof ui === 'object');
    assert.strictEqual(ui.ui_type, 'text_only');
    assert.strictEqual(ui.version, 1);
    assert.strictEqual(ui.summary, 'hi');
    assert.deepStrictEqual(ui.data, { city: 'Jakarta' });
    assert.strictEqual(ui.valid, undefined, 'no valid flag stored');
    assert.strictEqual(ui.reason, undefined, 'no reason stored');
});

// ── C. Invalid JSON → null, no throw ──
test('G1-C: invalid JSON resolves to null without throwing', () => {
    assert.strictEqual(genUi.resolveAssistantUi('{not json'), null);
    assert.strictEqual(genUi.resolveAssistantUi(''), null);
    assert.strictEqual(genUi.resolveAssistantUi(null), null);
    assert.strictEqual(genUi.resolveAssistantUi(undefined), null);
    assert.strictEqual(genUi.resolveAssistantUi(42), null);
});

// ── D. Markdown containing JSON-looking text → null, no extraction ──
test('G1-D: markdown with JSON block is not extracted', () => {
    const md = 'Here is data:\n```json\n' + env('weather_card') + '\n```\nDone.';
    assert.strictEqual(genUi.resolveAssistantUi(md), null);
    assert.strictEqual(genUi.resolveAssistantUi('Result: ' + env('text_only') + ' ok'), null);
});

// ── E. completion-path contract: content preserved, ui additive ──
test('G1-E: simulated completion keeps content, attaches ui additively', () => {
    const convMod = require('../ai/conversationState.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    const raw = env('stock_chart', { data: { symbol: 'BBRI' } });
    convMod.completeAssistant(conv, aId, raw, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, raw, 'content unchanged');
    assert.strictEqual(msg.ui.ui_type, 'stock_chart');
    const hist = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(hist, [], 'history excludes current user; ui never leaks into context');
    const ctx = convMod.getContextMessages(conv, 10);
    assert.ok(ctx.every(m => m.ui === undefined), 'no ui field leaks into context messages');
});

// ── G1.1 loader hardening ──
test('G1.1-1: contract loader finds parser via candidate paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'generativeUi.js'), 'utf8');
    assert.ok(src.indexOf('./ai/generativeUiContract.js') !== -1, 'applet-root path tried');
    assert.ok(src.indexOf('./generativeUiContract.js') !== -1, 'sibling path tried');
    assert.ok(src.indexOf("require('./generativeUiContract.js')") === -1, 'single-path require gone');
    const genUi = require('../ai/generativeUi.js');
    const d = genUi.diagnoseAssistantUi(JSON.stringify({ ui_type: 'text_only', version: 1, summary: 's', data: {} }));
    assert.strictEqual(d.parserLoaded, true, 'parser loads in Node');
});

test('G1.1-2: valid text_only resolves to validated value', () => {
    const genUi = require('../ai/generativeUi.js');
    const ui = genUi.resolveAssistantUi(env('text_only', { summary: 'hi' }));
    assert.strictEqual(ui.ui_type, 'text_only');
    assert.strictEqual(ui.version, 1);
});

test('G1.1-3: bad JSON stays null', () => {
    assert.strictEqual(require('../ai/generativeUi.js').resolveAssistantUi('{nope'), null);
});

test('G1.1-4: non-string stays null', () => {
    const genUi = require('../ai/generativeUi.js');
    assert.strictEqual(genUi.resolveAssistantUi(null), null);
    assert.strictEqual(genUi.resolveAssistantUi(42), null);
});

test('G1.1-5: total loader failure stays null without throwing', () => {
    const Module = require('module');
    const orig = Module.prototype.require;
    Module.prototype.require = function(p) {
        if (String(p).indexOf('generativeUiContract') !== -1) throw new Error('blocked');
        return orig.apply(this, arguments);
    };
    try {
        delete require.cache[require.resolve('../ai/generativeUi.js')];
        const iso = require('../ai/generativeUi.js');
        assert.strictEqual(iso.resolveAssistantUi(env('text_only')), null);
        const d = iso.diagnoseAssistantUi(env('text_only'));
        assert.strictEqual(d.parserLoaded, false);
        assert.strictEqual(d.reason, 'no-parser');
    } finally {
        Module.prototype.require = orig;
        delete require.cache[require.resolve('../ai/generativeUi.js')];
        require('../ai/generativeUi.js');
    }
});

test('G1.1-6: public API stays compatible', () => {
    const genUi = require('../ai/generativeUi.js');
    assert.strictEqual(typeof genUi.resolveAssistantUi, 'function');
    assert.strictEqual(genUi.resolveAssistantUi.length, 1);
});

// ── F. applet.js wiring: via factory only, onComplete only, never onDelta ──
test('G1-F: applet wires resolveAssistantUi via factory on completion paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    assert.ok(src.indexOf('aiFactoryMod.resolveAssistantUi') !== -1, 'applet calls resolver via factory');
    assert.ok(src.indexOf("require('./ai/generativeUi") === -1, 'no direct require bypassing factory');
    assert.ok(src.indexOf("require('./ai/generativeUiContract") === -1, 'no direct contract require');
    const runFn = src.slice(src.indexOf('_runAIRequestStream'));
    assert.ok(runFn.length > 1000, 'completion runner found');
    // Extract the exact onDelta function body via brace counting so the
    // assertion can never spill into onComplete/onAnswer/onDone.
    function _extractFnBody(hay, marker) {
        const mIdx = hay.indexOf(marker);
        assert.ok(mIdx !== -1, 'marker found: ' + marker);
        const openIdx = hay.indexOf('{', mIdx);
        assert.ok(openIdx !== -1, 'body opens: ' + marker);
        let depth = 0;
        for (let i = openIdx; i < hay.length; i++) {
            if (hay[i] === '{') depth++;
            else if (hay[i] === '}') {
                depth--;
                if (depth === 0) return hay.slice(openIdx, i + 1);
            }
        }
        assert.fail('unbalanced braces after: ' + marker);
        return '';
    }
    const deltaBody = _extractFnBody(runFn, 'onDelta: function');
    assert.ok(deltaBody.indexOf('resolveAssistantUi') === -1, 'onDelta must not parse');
    assert.ok(deltaBody.indexOf('_attachGenerativeUi') === -1, 'onDelta must not attach ui');
    assert.ok(deltaBody.indexOf('generativeUi') === -1, 'onDelta must not touch generative UI');
    assert.ok(deltaBody.indexOf('updateAssistant') !== -1, 'onDelta keeps existing streaming update');
    // Completion paths DO attach: onComplete + onAnswer + onDone bodies each reference it.
    for (const marker of ['onComplete: function', 'onAnswer: (data)', 'onDone: (err, data)']) {
        const body = _extractFnBody(runFn, marker);
        assert.ok(body.indexOf('_attachGenerativeUi(conv, assistantId') !== -1, marker + ' attaches ui');
    }
});

// ── G. factory boundary: resolver exposed, no concrete requires ──
test('G1-G: factory exposes resolveAssistantUi without breaking boundary', () => {
    const fSrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiFactory.js'), 'utf8');
    assert.ok(fSrc.indexOf('resolveAssistantUi') !== -1, 'factory exposes resolver');
    const factory = require('../ai/aiFactory.js');
    assert.strictEqual(typeof factory.resolveAssistantUi, 'function');
    assert.strictEqual(factory.resolveAssistantUi('plain text'), null);
    const ui = factory.resolveAssistantUi(env('text_only'));
    assert.strictEqual(ui.ui_type, 'text_only');
});
