// G7.5 runtime failure-injection audit tests (boundary-level, no network).
// Covers hostile/malformed inputs contract→resolver→renderer→factory,
// content integrity A-E, and side-effect freedom.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../ai/generativeUiContract.js');
const genUi = require('../ai/generativeUi.js');
const renderer = require('../ai/generativeUiRenderer.js');
const factory = require('../ai/aiFactory.js');

function fakeSt() {
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { return { set_line_wrap: function() {} }; };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    return { BoxLayout: FakeBox, Label: FakeLabel };
}
function validRaw(kind) {
    if (kind === 'info_card') return JSON.stringify({ ui_type: 'info_card', version: 1, summary: 'i', data: { title: 'T', items: [{ label: 'a', value: 'b' }] } });
    if (kind === 'stock_chart') return JSON.stringify({ ui_type: 'stock_chart', version: 1, summary: 's', data: { symbol: 'S', title: 'T', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] } });
    if (kind === 'sports_card') return JSON.stringify({ ui_type: 'sports_card', version: 1, summary: 'm', data: { title: 'T', league: 'L', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' } });
    return JSON.stringify({ ui_type: 'text_only', version: 1, summary: 'ok', data: {} });
}
function e2e(raw) {
    const ui = genUi.resolveAssistantUi(raw);
    if (!ui) return { ui: null, descriptor: null, actor: null };
    const d = renderer.describeGenerativeUi(ui);
    if (!d) return { ui: ui, descriptor: null, actor: null };
    return { ui: ui, descriptor: d, actor: factory.buildGenerativeUiActor(d, fakeSt()) };
}

// ── 1. CONTRACT hostile inputs → invalid, never throw ──
test('G7.5-C1: hostile envelope shapes fail closed', () => {
    const bad = [null, undefined, 42, true, [], [1], 'str',
        { ui_type: null }, { ui_type: 42 }, { ui_type: 'text_only', version: null },
        { ui_type: 'text_only', version: 1, summary: 42, data: {} },
        { ui_type: 'text_only', version: 1, summary: 's', data: 'str' }];
    for (const v of bad) {
        assert.strictEqual(contract.validateGenerativeUI(v).valid, false, String(v && v.ui_type));
    }
    // text_only is envelope-only by design: data shape unchecked (contrast info_card below)
    assert.strictEqual(contract.validateGenerativeUI({ ui_type: 'text_only', version: 1, summary: 's', data: { title: 'T', items: {} } }).valid, true);
    assert.strictEqual(contract.validateGenerativeUI({ ui_type: 'info_card', version: 1, summary: 's', data: { title: 'T', items: {} } }).valid, false);
});

test('G7.5-C2: extra hostile data fields ignored, never executed', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({
        ui_type: 'info_card', version: 1, summary: 's',
        data: { title: 'T', items: [{ label: 'a', value: 'b', __proto__: { x: 1 }, extra: [1, 2] }], series: [1], url: 'https://evil.example/' }
    }));
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.value.data.url, 'https://evil.example/');
    assert.strictEqual(({}).x, undefined, 'no prototype pollution');
});

test('G7.5-C3: oversized nested strings rejected by 16KB cap', () => {
    const raw = JSON.stringify({ ui_type: 'text_only', version: 1, summary: 's', data: { blob: 'y'.repeat(17 * 1024) } });
    assert.strictEqual(contract.parseGenerativeUIResponse(raw).valid, false);
});

// ── 2. RENDERER hostile descriptors → null, never throw, no partial ──
test('G7.5-R1: hostile descriptors return null', () => {
    const bad = [null, undefined, 42, 'x', [], {},
        { kind: 'text_only' }, { kind: 'text_only', summary: 42 },
        { kind: 'text_only', summary: 'x'.repeat(501) },
        { kind: 'info_card', title: 'T', items: 'nope' },
        { kind: 'stock_chart', symbol: 'S', title: 'T', points: [{ label: 'a', value: NaN }, { label: 'b', value: 1 }] },
        { kind: 'sports_card', title: 'T', league: 'L', home: null, away: null, status: 'FT' },
        { kind: 'nope', x: 1 }, { kind: 42 }];
    for (const d of bad) {
        assert.strictEqual(renderer.describeGenerativeUi(d), null, typeof d + ':' + String(d && d.kind));
    }
});

test('G7.5-R2: wrong-kind descriptor ignored, frozen input untouched', () => {
    const d = Object.freeze({ kind: 'mystery', summary: 'hi' });
    assert.strictEqual(renderer.describeGenerativeUi(d), null);
    const frozen = Object.freeze({ ui_type: 'text_only', version: 1, summary: 'hi', data: Object.freeze({}) });
    const out = renderer.describeGenerativeUi(frozen);
    assert.deepStrictEqual(out, { kind: 'text_only', summary: 'hi' });
    const actor = factory.buildGenerativeUiActor(out, fakeSt());
    assert.ok(actor);
});

// ── 3. FACTORY hostile St → null, never throw ──
test('G7.5-F1: broken St toolkit fails closed per kind', () => {
    function ThrowLabel() { throw new Error('ctor'); }
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    const badSt = { BoxLayout: FakeBox, Label: ThrowLabel };
    const kinds = [
        { kind: 'text_only', summary: 'x' },
        { kind: 'info_card', title: 'T', items: [{ label: 'a', value: 'b' }] },
        { kind: 'stock_chart', symbol: 'S', title: 'T', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] },
        { kind: 'sports_card', title: 'T', league: 'L', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' }
    ];
    for (const k of kinds) {
        assert.strictEqual(factory.buildGenerativeUiActor(k, badSt), null, k.kind);
        assert.strictEqual(factory.buildGenerativeUiActor(k, null), null, k.kind);
        assert.strictEqual(factory.buildGenerativeUiActor(k, {}), null, k.kind);
    }
});

test('G7.5-F2: throwing clutter_text still renders', () => {
    function FakeLabel(props) { this.props = props; }
    FakeLabel.prototype.get_clutter_text = function() { throw new Error('ct'); };
    function FakeBox(props) { this.props = props; this.children = []; }
    FakeBox.prototype.add_child = function(c) { this.children.push(c); };
    const St = { BoxLayout: FakeBox, Label: FakeLabel };
    assert.ok(factory.buildGenerativeUiActor({ kind: 'text_only', summary: 'x' }, St));
});

// ── 4+5. BOUNDARY + CONTENT INTEGRITY A-E ──
test('G7.5-B1: full chain per kind, content intact', () => {
    for (const kind of ['text_only', 'info_card', 'stock_chart', 'sports_card']) {
        const raw = validRaw(kind);
        const r = e2e(raw);
        assert.ok(r.actor, kind + ' renders');
        assert.strictEqual(raw, validRaw(kind), kind + ' content intact (A)');
    }
});

test('G7.5-B2: invalid/failed layers preserve content, no partial actor', () => {
    const cases = ['{bad json', '{"ui_type":"nope","version":1,"summary":"s","data":{}}',
        JSON.stringify({ ui_type: 'text_only', version: 1, summary: 's', data: {} }).slice(0, 20)];
    for (const raw of cases) {
        const r = e2e(raw);
        assert.strictEqual(r.actor, null, 'no partial for ' + raw.slice(0, 30));
        assert.strictEqual(typeof raw, 'string', 'content untouched (B)');
    }
    const convMod = require('../ai/conversationState.js');
    const conv = convMod.createConversation();
    convMod.appendUser(conv, 'Q');
    const aId = convMod.appendAssistant(conv);
    const malformed = '{not valid json';
    convMod.completeAssistant(conv, aId, malformed, [], null);
    const msg = convMod.findMessage(conv, aId);
    msg.ui = genUi.resolveAssistantUi(msg.content);
    assert.strictEqual(msg.content, malformed, 'content intact (C/D/E)');
    assert.strictEqual(msg.ui, null);
    assert.strictEqual(renderer.describeGenerativeUi(msg.ui), null);
});

// ── 6. SIDE EFFECTS ──
test('G7.5-S1: no network/async/fs/global/Search side effects in source', () => {
    for (const f of ['generativeUiContract.js', 'generativeUiRenderer.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'ai', f), 'utf8');
        for (const s of ['require(', 'imports.', 'new Soup', 'Soup.', 'fetch(', 'XMLHttp', 'setTimeout(', 'setInterval(', 'new Promise', 'Gio.', 'readFile', 'writeFile']) {
            assert.ok(src.indexOf(s) === -1, f + ' free of ' + s);
        }
    }
    // generativeUi.js is the G1 loader by design: only candidate-path requires, nothing else
    const gsrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'generativeUi.js'), 'utf8');
    assert.ok(gsrc.indexOf('./ai/generativeUiContract.js') !== -1, 'loader tries applet-root path');
    for (const s of ['imports.', 'new Soup', 'Soup.', 'fetch(', 'XMLHttp', 'setTimeout(', 'new Promise', 'Gio.']) {
        assert.ok(gsrc.indexOf(s) === -1, 'generativeUi.js free of ' + s);
    }
    const fsrc = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiFactory.js'), 'utf8');
    const start = fsrc.indexOf('function buildGenerativeUiActor');
    const end = fsrc.indexOf('function _trim');
    const builders = fsrc.slice(start, end);
    for (const s of ['Soup', 'fetch(', 'XMLHttp', 'setTimeout', 'Promise', 'Gio.']) {
        assert.ok(builders.indexOf(s) === -1, 'builders free of ' + s);
    }
});

test('G7.5-S2: frozen inputs never mutated across layers', () => {
    const raw = validRaw('info_card');
    const ui = genUi.resolveAssistantUi(raw);
    const frozen = JSON.parse(JSON.stringify(ui));
    Object.freeze(ui); Object.freeze(ui.data); Object.freeze(ui.data.items);
    const d = renderer.describeGenerativeUi(ui);
    assert.ok(d);
    assert.strictEqual(JSON.stringify(ui), JSON.stringify(frozen));
    factory.buildGenerativeUiActor(d, fakeSt());
    assert.strictEqual(JSON.stringify(ui), JSON.stringify(frozen));
});
