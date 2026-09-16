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

test('G2-12: complete branch renders gen actor instead of raw JSON Markdown', () => {
    const appletSrc = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    const idx = appletSrc.indexOf("} else if (msg.status === 'complete') {");
    assert.ok(idx !== -1, 'complete branch found');
    let depth = 0, end = -1;
    const open = appletSrc.indexOf('{', idx);
    for (let i = open; i < appletSrc.length; i++) {
        if (appletSrc[i] === '{') depth++;
        else if (appletSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = appletSrc.slice(open, end + 1);
    const genPos = body.indexOf('_buildGenerativeUiActorForMessage(msg)');
    const mdPos = body.indexOf('_buildAiAnswerActor(String(msg.content');
    assert.ok(genPos !== -1 && mdPos !== -1, 'both builders present');
    assert.ok(genPos < mdPos, 'gen actor attempted before Markdown');
    assert.ok(body.indexOf('genShown') !== -1, 'Markdown gated on gen failure');
});

test('G2-13: complete branch never strips or mutates msg.content', () => {
    const appletSrc = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    const idx = appletSrc.indexOf("} else if (msg.status === 'complete') {");
    let depth = 0, end = -1;
    const open = appletSrc.indexOf('{', idx);
    for (let i = open; i < appletSrc.length; i++) {
        if (appletSrc[i] === '{') depth++;
        else if (appletSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = appletSrc.slice(open, end + 1);
    assert.ok(body.indexOf('msg.content =') === -1, 'no content assignment');
    assert.ok(body.indexOf('msg.content=') === -1, 'no content assignment');
    assert.ok(body.indexOf('.replace(') === -1, 'no content stripping');
});

test('G2-11: factory builder pure-St-injected, text_only only, never throws', () => {    const factory = require('../ai/aiFactory.js');
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
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'text_only', summary: '' }, St), null);
});

test('G4-1: card shows badge + summary, hides contract metadata', () => {
    const factory = require('../ai/aiFactory.js');
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { return { set_line_wrap: function() {} }; };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    const St = { BoxLayout: FakeBox, Label: FakeLabel };
    const actor = factory.buildGenerativeUiActor({ kind: 'text_only', summary: 'hello' }, St);
    assert.strictEqual(actor.children.length, 2, 'badge + summary');
    assert.strictEqual(actor.children[0].props.style_class, 'ai-generative-ui-badge');
    assert.strictEqual(actor.children[1].props.style_class, 'ai-generative-ui-summary');
    assert.strictEqual(actor.children[1].props.text, 'hello');
    const dumped = JSON.stringify(actor);
    for (const leak of ['ui_type', 'version', 'text_only', '"data"', '{}']) {
        assert.ok(dumped.indexOf(leak) === -1, 'no metadata leak: ' + leak);
    }
});

test('G4-2: card CSS stays AI-only', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'stylesheet.css'), 'utf8');
    assert.ok(css.indexOf('.ai-generative-ui-badge') !== -1, 'badge style exists');
    const badgeIdx = css.indexOf('.ai-generative-ui-badge');
    const head = css.slice(Math.max(0, badgeIdx - 400), badgeIdx);
    assert.ok(head.indexOf('quicksearch-row') === -1, 'no Search selector adjacency');
});

// ── G5.2 info_card ──
function infoUi(overrides) {
    return Object.assign({
        ui_type: 'info_card', version: 1, summary: 'info',
        data: { title: 'Sys', items: [{ label: 'OS', value: 'Mint' }] }
    }, overrides || {});
}
function fakeSt() {
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { return { set_line_wrap: function() {} }; };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    return { BoxLayout: FakeBox, Label: FakeLabel };
}

test('G5.2-1: valid info_card describes actor descriptor', () => {
    const d = renderer.describeGenerativeUi(infoUi());
    assert.ok(d);
    assert.strictEqual(d.kind, 'info_card');
});

test('G5.2-2: title present and correct', () => {
    assert.strictEqual(renderer.describeGenerativeUi(infoUi({ data: { title: 'Spec', items: [{ label: 'a', value: 'b' }] } })).title, 'Spec');
});

test('G5.2-3: one item renders label + value', () => {
    const factory = require('../ai/aiFactory.js');
    const d = renderer.describeGenerativeUi(infoUi());
    const actor = factory.buildGenerativeUiActor(d, fakeSt());
    assert.ok(actor);
    const dumped = JSON.stringify(actor);
    assert.ok(dumped.indexOf('OS') !== -1 && dumped.indexOf('Mint') !== -1);
});

test('G5.2-4: six items accepted', () => {
    const items = [];
    for (let i = 0; i < 6; i++) items.push({ label: 'l' + i, value: 'v' + i });
    const d = renderer.describeGenerativeUi(infoUi({ data: { title: 'T', items: items } }));
    assert.ok(d && d.items.length === 6);
    assert.ok(require('../ai/aiFactory.js').buildGenerativeUiActor(d, fakeSt()));
});

test('G5.2-5: over six items rejected to fallback', () => {
    const items = [];
    for (let i = 0; i < 7; i++) items.push({ label: 'l' + i, value: 'v' + i });
    assert.strictEqual(renderer.describeGenerativeUi(infoUi({ data: { title: 'T', items: items } })), null);
});

test('G5.2-6: empty label/value rejected', () => {
    assert.strictEqual(renderer.describeGenerativeUi(infoUi({ data: { title: 'T', items: [{ label: '', value: 'v' }] } })), null);
    assert.strictEqual(renderer.describeGenerativeUi(infoUi({ data: { title: 'T', items: [{ label: 'l', value: '' }] } })), null);
});

test('G5.2-7: nested item data rejected', () => {
    assert.strictEqual(renderer.describeGenerativeUi(infoUi({ data: { title: 'T', items: [{ label: 'l', value: { x: 1 } }] } })), null);
});

test('G5.2-8: no contract metadata in visible UI', () => {
    const factory = require('../ai/aiFactory.js');
    const actor = factory.buildGenerativeUiActor(renderer.describeGenerativeUi(infoUi()), fakeSt());
    const dumped = JSON.stringify(actor);
    for (const leak of ['ui_type', 'info_card', '"version"', 'valid', 'reason']) {
        assert.ok(dumped.indexOf(leak) === -1, 'no leak: ' + leak);
    }
});

test('G5.2-9: raw JSON never shown for valid info_card', () => {
    const raw = JSON.stringify(infoUi());
    const genUi = require('../ai/generativeUi.js');
    const ui = genUi.resolveAssistantUi(raw);
    const d = renderer.describeGenerativeUi(ui);
    assert.strictEqual(d.kind, 'info_card');
    const actor = require('../ai/aiFactory.js').buildGenerativeUiActor(d, fakeSt());
    assert.ok(actor);
    assert.ok(JSON.stringify(actor).indexOf(raw.slice(0, 30)) === -1);
});

test('G5.2-10: weather/sports still fallback', () => {
    for (const t of ['weather_card', 'sports_card']) {
        assert.strictEqual(renderer.describeGenerativeUi({ ui_type: t, version: 1, summary: 's', data: {} }), null);
    }
});

test('G5.2-11: normal Markdown stays Markdown (null descriptor)', () => {
    assert.strictEqual(renderer.describeGenerativeUi(null), null);
    assert.strictEqual(renderer.describeGenerativeUi(undefined), null);
});

test('G5.2-12: builder failure never throws', () => {
    const factory = require('../ai/aiFactory.js');
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'info_card' }, fakeSt()), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'info_card', title: 'T', items: [] }, fakeSt()), null);
    assert.strictEqual(factory.buildGenerativeUiActor(null, fakeSt()), null);
});

test('G5.2-13: msg.content intact after ui attach', () => {
    const raw = JSON.stringify(infoUi());
    const convMod = require('../ai/conversationState.js');
    const genUi = require('../ai/generativeUi.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.completeAssistant(conv, aId, raw, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, raw);
    assert.strictEqual(msg.ui.ui_type, 'info_card');
});

test('G5.2-14: onDelta free of info_card rendering', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'applet.js'), 'utf8');
    const runFn = src.slice(src.indexOf('_runAIRequestStream'));
    const open = runFn.indexOf('{', runFn.indexOf('onDelta: function'));
    let depth = 0, end = -1;
    for (let i = open; i < runFn.length; i++) {
        if (runFn[i] === '{') depth++;
        else if (runFn[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const deltaBody = runFn.slice(open, end + 1);
    assert.ok(deltaBody.indexOf('info_card') === -1);
    assert.ok(deltaBody.indexOf('buildGenerativeUiActor') === -1);
});

test('G5.2-15: info_card CSS is AI-only', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'stylesheet.css'), 'utf8');
    assert.ok(css.indexOf('.ai-generative-ui-info') !== -1, 'info card style exists');
    assert.ok(css.indexOf('.ai-generative-ui-row') !== -1, 'row style exists');
});
test('G4-3: unsupported still falls back, content intact', () => {
    const factory = require('../ai/aiFactory.js');
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { return { set_line_wrap: function() {} }; };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    const St = { BoxLayout: FakeBox, Label: FakeLabel };
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'weather_card', summary: 'w' }, St), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'sports_card', summary: 's' }, St), null);
    const raw = JSON.stringify({ ui_type: 'text_only', version: 1, summary: 'hi', data: {} });
    const convMod = require('../ai/conversationState.js');
    const genUi = require('../ai/generativeUi.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.completeAssistant(conv, aId, raw, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, raw, 'content intact');
});

// ── G6.2 stock_chart ──
function stockUi(symbol, points) {
    return { ui_type: 'stock_chart', version: 1, summary: 'stock',
        data: { symbol: symbol || 'BBRI', title: (symbol || 'BBRI') + ' chart',
            points: points || [{ label: 'Jan', value: 4000 }, { label: 'Feb', value: 4100 }] } };
}

test('G6.2-A: valid stock_chart describes render descriptor', () => {
    const d = renderer.describeGenerativeUi(stockUi());
    assert.ok(d);
    assert.strictEqual(d.kind, 'stock_chart');
});

test('G6.2-B: symbol/title/points follow descriptor', () => {
    const d = renderer.describeGenerativeUi(stockUi('TLKM'));
    assert.strictEqual(d.symbol, 'TLKM');
    assert.ok(d.title.indexOf('TLKM') !== -1);
    assert.strictEqual(d.points.length, 2);
    assert.deepStrictEqual(d.points[0], { label: 'Jan', value: 4000 });
});

test('G6.2-C: two points render', () => {
    const d = renderer.describeGenerativeUi(stockUi());
    assert.ok(require('../ai/aiFactory.js').buildGenerativeUiActor(d, fakeSt()));
});

test('G6.2-D: many points render without error', () => {
    const pts = [];
    for (let i = 0; i < 50; i++) pts.push({ label: 'p' + i, value: 100 + i });
    const actor = require('../ai/aiFactory.js').buildGenerativeUiActor(renderer.describeGenerativeUi(stockUi('X', pts)), fakeSt());
    assert.ok(actor);
});

test('G6.2-E: invalid descriptor falls back', () => {
    const factory = require('../ai/aiFactory.js');
    assert.strictEqual(renderer.describeGenerativeUi(stockUi('S', [])), null);
    assert.strictEqual(renderer.describeGenerativeUi(stockUi('S', [{ label: 'a', value: 'x' }, { label: 'b', value: 1 }])), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'stock_chart' }, fakeSt()), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'stock_chart', symbol: '', title: 'T', points: [] }, fakeSt()), null);
});

test('G6.2-F: non-stock kind not hijacked', () => {
    const factory = require('../ai/aiFactory.js');
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'weather_card', version: 1, summary: 's', data: {} }), null);
    assert.strictEqual(factory.buildGenerativeUiActor({ kind: 'mystery', x: 1 }, fakeSt()), null);
    assert.strictEqual(renderer.describeGenerativeUi(stockUi()).kind, 'stock_chart');
});

test('G6.2-G: info_card regression intact', () => {
    const d = renderer.describeGenerativeUi(infoUi());
    assert.strictEqual(d.kind, 'info_card');
    assert.ok(require('../ai/aiFactory.js').buildGenerativeUiActor(d, fakeSt()));
});

test('G6.2-H: raw JSON absent from rendered actor', () => {
    const raw = JSON.stringify(stockUi());
    const ui = require('../ai/generativeUi.js').resolveAssistantUi(raw);
    const actor = require('../ai/aiFactory.js').buildGenerativeUiActor(renderer.describeGenerativeUi(ui), fakeSt());
    assert.ok(actor);
    assert.ok(JSON.stringify(actor).indexOf('"ui_type"') === -1);
});

test('G6.2-I: renderer source has no network', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'generativeUiRenderer.js'), 'utf8');
    for (const s of ['Soup', 'Gio.', 'imports.gi', 'fetch(', 'XMLHttp', 'eval(', 'Function(']) {
        assert.ok(src.indexOf(s) === -1, 'renderer free of ' + s);
    }
    const fsrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiFactory.js'), 'utf8');
    const bIdx = fsrc.indexOf('function _buildStockChart');
    assert.ok(bIdx !== -1);
    const bBody = fsrc.slice(bIdx, bIdx + 2500);
    for (const s of ['Soup', 'Gio.', 'fetch(', 'XMLHttp', 'eval(']) {
        assert.ok(bBody.indexOf(s) === -1, 'builder free of ' + s);
    }
});

test('G6.2-J: renderer never calls contract parser', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'generativeUiRenderer.js'), 'utf8');
    for (const s of ['parseGenerativeUIResponse', 'validateGenerativeUI', 'require(']) {
        assert.ok(src.indexOf(s) === -1, 'renderer free of ' + s);
    }
});

test('G6.2-K: msg.content unchanged', () => {
    const raw = JSON.stringify(stockUi());
    const convMod = require('../ai/conversationState.js');
    const genUi = require('../ai/generativeUi.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    convMod.completeAssistant(conv, aId, raw, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, raw);
    assert.strictEqual(msg.ui.ui_type, 'stock_chart');
});

test('G6.2-L: G0/G5.1 behavior intact', () => {
    assert.strictEqual(renderer.describeGenerativeUi({ ui_type: 'text_only', version: 1, summary: 's', data: {} }).kind, 'text_only');
    assert.strictEqual(renderer.describeGenerativeUi(infoUi()).kind, 'info_card');
});
