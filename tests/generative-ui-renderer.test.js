// G2 Generative UI renderer tests (AI-only, Search frozen).
// describeGenerativeUi(ui): pure descriptor, Node-testable, no St/Network.
// buildGenerativeUiActor: runtime St.* actor (factory boundary, AI-only).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const renderer = require('../ai/generativeUiRenderer.js');

function textOnly(summary) {
    return { ui_type: 'text_only', version: 1, summary: summary == null ? 'ok' : summary, data: {} };
}

// 1. null ui → fallback
test('G2-1: null ui returns null (fallback)', () => {
    assert.strictEqual(renderer.describeGenerativeUi(null), null);
    assert.strictEqual(renderer.describeGenerativeUi(undefined), null);
});

// 2. valid text_only → renderable descriptor
test('G2-2: valid text_only describes renderable result', () => {
    const d = renderer.describeGenerativeUi(textOnly('hello'));
    assert.ok(d && typeof d === 'object');
    assert.strictEqual(d.kind, 'text_only');
    assert.strictEqual(d.summary, 'hello');
    assert.strictEqual(d.valid, undefined);
    assert.strictEqual(d.reason, undefined);
});

// 3. weather_card unsupported → fallback, no network
test('G2-3: weather_card unsupported falls back', () => {
    const d = renderer.describeGenerativeUi({ ui_type: 'weather_card', version: 1, summary: 'w', data: {} });
    assert.strictEqual(d, null);
    assert.ok(renderer.describeGenerativeUi.toString().indexOf('http') === -1, 'no URLs in renderer');
    assert.ok(renderer.describeGenerativeUi.toString().indexOf('Soup') === -1, 'no Soup in renderer');
});

// 4. stock_chart unsupported → fallback
test('G2-4: stock_chart unsupported falls back', () => {
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'stock_chart', version: 1, summary: 's', data: {} }), null);
});

// 5. sports_card unsupported → fallback
test('G2-5: sports_card unsupported falls back', () => {
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'sports_card', version: 1, summary: 's', data: {} }), null);
});

// 6. malformed → no crash
test('G2-6: malformed ui never throws', () => {
    assert.strictEqual(renderer.describeGenerativeUi({}), null);
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 42 }), null);
    assert.strictEqual(renderer.describeGenerativeUi('text'), null);
    assert.strictEqual(renderer.describeGenerativeUi([]), null);
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'text_only', version: 2, summary: 'x', data: {} }), null);
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'text_only', version: 1, summary: 'x'.repeat(501), data: {} }), null);
});

// 7. renderer does not mutate msg.content
test('G2-7: describe never mutates input', () => {
    const ui = textOnly('keep');
    const frozen = JSON.stringify(ui);
    renderer.describeGenerativeUi(ui);
    assert.strictEqual(JSON.stringify(ui), frozen);
});

// 8. normal Markdown without ui → existing path (null descriptor)
test('G2-8: absent ui means Markdown fallback', () => {
    const msg = { role: 'assistant', content: '# Hi\n\nSome **text**.', status: 'complete' };
    assert.strictEqual(renderer.describeGenerativeUi(msg.ui), null);
    assert.strictEqual(msg.content, '# Hi\n\nSome **text**.');
});

// 9. completion additive: content + ui both survive
test('G2-9: completion keeps content, ui additive', () => {
    const raw = JSON.stringify({ ui_type: 'text_only', version: 1, summary: 'hi', data: {} });
    const convMod = require('../ai/conversationState.js');
    const genUi = require('../ai/generativeUi.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.completeAssistant(conv, aId, raw, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, raw);
    const d = renderer.describeGenerativeUi(msg.ui);
    assert.strictEqual(d.kind, 'text_only');
});

// 10. factory boundary: no direct renderer require in applet, actor built via factory
test('G2-10: applet builds actor via factory only, never onDelta', () => {
    const appletSrc = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    assert.ok(appletSrc.indexOf("require('./ai/generativeUiRenderer") === -1, 'no direct renderer require');
    assert.ok(appletSrc.indexOf('aiFactoryMod.buildGenerativeUiActor') !== -1, 'actor built via factory');
    const runFn = appletSrc.slice(appletSrc.indexOf('_runAIRequestStream'));
    const onDeltaIdx = runFn.indexOf('onDelta: function');
    assert.ok(onDeltaIdx !== -1);
    let depth = 0, end = -1;
    const open = runFn.indexOf('{', onDeltaIdx);
    for (let i = open; i < runFn.length; i++) {
        if (runFn[i] === '{') depth++;
        else if (runFn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const deltaBody = runFn.slice(open, end + 1);
    assert.ok(deltaBody.indexOf('buildGenerativeUiActor') === -1, 'onDelta never builds actor');
    assert.ok(deltaBody.indexOf('describeGenerativeUi') === -1, 'onDelta never describes ui');
    const factorySrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiFactory.js'), 'utf8');
    assert.ok(factorySrc.indexOf('buildGenerativeUiActor') !== -1, 'factory exposes actor builder');
});

test('G2-11: factory builder pure-St-injected, text_only only, never throws', () => {
    const factory = require('../ai/aiFactory.js');
    assert.strictEqual(typeof factory.describeGenerativeUi, 'function');
    assert.strictEqual(typeof factory.buildGenerativeUiActor, 'function');
    assert.strictEqual(factory.buildGenerativeUiActor(null, null), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'weather_card' }, null), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'text_only', summary: 'x' }, null), null);
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { return { set_line_wrap: function() {} }; };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    const St = { BoxLayout: FakeBox, Label: FakeLabel };
    const actor = factory.buildGenerativeUiActor({ kind: 'text_only', summary: 'hello' }, St);
    assert.ok(actor);
    assert.strictEqual(actor.props.style_class, 'ai-generative-ui ai-generative-ui-text-only');
    assert.strictEqual(actor.children.length, 1);
    assert.strictEqual(actor.children[0].props.text, 'hello');
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'text_only', summary: '' }, St), null);
});
