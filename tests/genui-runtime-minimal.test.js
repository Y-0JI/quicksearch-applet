const { test } = require('node:test');
const assert = require('node:assert');
const genUi = require('../ai/generativeUi.js');
const { detectResponseIntent } = require('../ai/responseIntent.js');

function stockRaw() {
    return JSON.stringify({ ui_type: 'stock_chart', version: 1, summary: 'BBCA', data: { symbol: 'BBCA', title: 'BBCA', points: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] } });
}

test('FIX-B: single fenced JSON block resolves', () => {
    const raw = stockRaw();
    const fenced = '```json\n' + raw + '\n```';
    const ui = genUi.resolveAssistantUi(fenced);
    assert.ok(ui && ui.ui_type === 'stock_chart');
});

test('FIX-B: fenced with surrounding whitespace resolves', () => {
    const raw = stockRaw();
    const ui = genUi.resolveAssistantUi('  \n```json\n' + raw + '\n```\n  ');
    assert.ok(ui && ui.ui_type === 'stock_chart');
});

test('FIX-B: embedded JSON in prose stays null', () => {
    const raw = stockRaw();
    assert.strictEqual(genUi.resolveAssistantUi('Result: ' + raw + ' ok'), null);
    assert.strictEqual(genUi.resolveAssistantUi('Here is data:\n```json\n' + raw + '\n```\nDone.'), null);
});

test('FIX-C: temporal sports queries go current/live', () => {
    for (const q of ['Kapan Chelsea bermain berikutnya?', 'Kapan jadwal Chelsea?', 'Kapan pertandingan Chelsea?', 'Siapa lawan Chelsea berikutnya?']) {
        const r = detectResponseIntent(q);
        assert.strictEqual(r.flags.live, true, q);
        assert.strictEqual(r.primary, 'current', q);
    }
});

test('FIX-C: ordinary explanations stay untouched', () => {
    assert.strictEqual(detectResponseIntent('Bagaimana harga saham bekerja?').flags.live, false);
    assert.strictEqual(detectResponseIntent('Jelaskan sistem klasemen sepak bola').flags.live, false);
    assert.strictEqual(detectResponseIntent('Bagaimana jadwal pertandingan dibuat?').flags.live, false);
});
