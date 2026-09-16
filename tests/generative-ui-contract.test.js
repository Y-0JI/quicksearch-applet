// G0 Generative UI structured-response contract tests.
// Pure Node, no Cinnamon deps. Contract: version 1, ui_type whitelist,
// bounded summary/data, 16KB payload cap, fail-closed with text fallback.
const { test } = require('node:test');
const assert = require('node:assert');
const contract = require('../ai/generativeUiContract.js');

function env(ui_type, overrides) {
    return JSON.stringify(Object.assign({
        ui_type: ui_type,
        version: 1,
        summary: 'ok',
        data: {}
    }, overrides || {}));
}

// ── VALID ──
test('valid text_only', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only'));
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'text_only');
});

test('valid weather_card envelope', () => {
    const r = contract.parseGenerativeUIResponse(env('weather_card', { data: { city: 'Jakarta' } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'weather_card');
});

test('valid stock_chart envelope', () => {
    const r = contract.parseGenerativeUIResponse(env('stock_chart', { data: { symbol: 'BBRI' } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'stock_chart');
});

test('valid sports_card envelope', () => {
    const r = contract.parseGenerativeUIResponse(env('sports_card', { data: { team: 'Chelsea' } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'sports_card');
});

// ── INVALID ──
test('invalid JSON', () => {
    const r = contract.parseGenerativeUIResponse('{not json');
    assert.equal(r.valid, false);
    assert.equal(r.value, null);
});

test('empty response', () => {
    assert.equal(contract.parseGenerativeUIResponse('').valid, false);
    assert.equal(contract.parseGenerativeUIResponse('   ').valid, false);
    assert.equal(contract.parseGenerativeUIResponse(null).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(undefined).valid, false);
});

test('JSON array', () => {
    const r = contract.parseGenerativeUIResponse('[]');
    assert.equal(r.valid, false);
});

test('JSON primitive', () => {
    assert.equal(contract.parseGenerativeUIResponse('"hi"').valid, false);
    assert.equal(contract.parseGenerativeUIResponse('42').valid, false);
    assert.equal(contract.parseGenerativeUIResponse('null').valid, false);
});

test('missing ui_type', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({ version: 1, summary: 's', data: {} }));
    assert.equal(r.valid, false);
});

test('unknown ui_type fails closed', () => {
    const r = contract.parseGenerativeUIResponse(env('unknown_widget'));
    assert.equal(r.valid, false);
    assert.equal(r.value, null);
});

test('missing version', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({ ui_type: 'text_only', summary: 's', data: {} }));
    assert.equal(r.valid, false);
});

test('unsupported version', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { version: 2 })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { version: '1' })).valid, false);
});

test('missing summary', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({ ui_type: 'text_only', version: 1, data: {} }));
    assert.equal(r.valid, false);
});

test('summary not string', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { summary: 42 })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { summary: null })).valid, false);
});

test('summary over 500 chars', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only', { summary: 'x'.repeat(501) }));
    assert.equal(r.valid, false);
});

test('missing data', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({ ui_type: 'text_only', version: 1, summary: 's' }));
    assert.equal(r.valid, false);
});

test('data null', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { data: null })).valid, false);
});

test('data array', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only', { data: [] })).valid, false);
});

test('payload over 16KB rejected', () => {
    const big = env('text_only', { summary: 's', data: { blob: 'x'.repeat(17 * 1024) } });
    assert.ok(Buffer.byteLength(big, 'utf8') > 16 * 1024);
    const r = contract.parseGenerativeUIResponse(big);
    assert.equal(r.valid, false);
});

// ── ROBUSTNESS ──
test('unknown extra fields ignored', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only', { future_field: 123, nested: { a: 1 } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.future_field, undefined);
    assert.deepEqual(Object.keys(r.value).sort(), ['data', 'summary', 'ui_type', 'version']);
});

test('arbitrary URL stays inert data', () => {
    const r = contract.parseGenerativeUIResponse(env('stock_chart', { data: { url: 'https://evil.example/x', symbol: 'BBRI' } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.data.url, 'https://evil.example/x');
});

test('HTML/Pango-looking summary stays plain data', () => {
    const s = '<b>hi</b> <span foreground="red">x</span> &amp; <script>alert(1)</script>';
    const r = contract.parseGenerativeUIResponse(env('text_only', { summary: s }));
    assert.equal(r.valid, true);
    assert.equal(r.value.summary, s);
});

test('unexpected nested data types pass through', () => {
    const r = contract.parseGenerativeUIResponse(env('weather_card', { data: { a: [1, 2], b: null, c: 42, d: { e: 'x' } } }));
    assert.equal(r.valid, true);
});

test('whitespace around valid JSON accepted', () => {
    const r = contract.parseGenerativeUIResponse('  \n\t' + env('text_only') + '\n  ');
    assert.equal(r.valid, true);
});

test('unicode content', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only', { summary: 'Cuaca Jakarta ☀️ こんにちは' }));
    assert.equal(r.valid, true);
});

test('markdown with JSON-looking text is not extracted', () => {
    const md = 'Here is some text\n```json\n' + env('text_only') + '\n```\nmore text';
    assert.equal(contract.parseGenerativeUIResponse(md).valid, false);
});

test('validateGenerativeUI rejects non-objects without throwing', () => {
    assert.equal(contract.validateGenerativeUI(null).valid, false);
    assert.equal(contract.validateGenerativeUI([]).valid, false);
    assert.equal(contract.validateGenerativeUI('x').valid, false);
});

test('original input never mutated', () => {
    const raw = env('text_only', { extra: 1 });
    contract.parseGenerativeUIResponse(raw);
    assert.equal(JSON.parse(raw).extra, 1);
});
