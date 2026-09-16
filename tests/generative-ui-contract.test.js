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
    const r = contract.parseGenerativeUIResponse(env('stock_chart', { data: { symbol: 'BBRI', title: 'BBRI', points: [{ label: 'Jan', value: 4000 }, { label: 'Feb', value: 4100 }] } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'stock_chart');
});

test('valid sports_card envelope (G7.1 schema)', () => {
    const r = contract.parseGenerativeUIResponse(JSON.stringify({ ui_type: 'sports_card', version: 1, summary: 'm',
        data: { title: 'T', league: 'L', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' } }));
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
    assert.ok(big.length > 16 * 1024);
    const r = contract.parseGenerativeUIResponse(big);
    assert.equal(r.valid, false);
});

test('utf8 multibyte payload measured in bytes not chars (GJS path, no Buffer)', () => {
    const saved = global.Buffer;
    try {
        delete global.Buffer;
        // 'é' = 2 bytes UTF-8: ~9068 chars but ~18068 bytes > 16KB -> must reject
        const big = env('text_only', { summary: 's', data: { blob: 'é'.repeat(9000) } });
        assert.ok(big.length < 16 * 1024, 'char count stays under limit');
        assert.equal(contract.parseGenerativeUIResponse(big).valid, false);
        // small unicode payload stays valid without Buffer
        assert.equal(contract.parseGenerativeUIResponse(env('text_only', { summary: 'Cuaca ☀️' })).valid, true);
    } finally {
        global.Buffer = saved;
    }
});

test('ascii payload size enforced without Buffer (GJS path)', () => {
    const saved = global.Buffer;
    try {
        delete global.Buffer;
        assert.equal(contract.parseGenerativeUIResponse(env('text_only')).valid, true);
        const big = env('text_only', { summary: 's', data: { blob: 'x'.repeat(17 * 1024) } });
        assert.equal(contract.parseGenerativeUIResponse(big).valid, false);
    } finally {
        global.Buffer = saved;
    }
});

// ── ROBUSTNESS ──
test('unknown extra fields ignored', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only', { future_field: 123, nested: { a: 1 } }));
    assert.equal(r.valid, true);
    assert.equal(r.value.future_field, undefined);
    assert.deepEqual(Object.keys(r.value).sort(), ['data', 'summary', 'ui_type', 'version']);
});

test('arbitrary URL stays inert data', () => {
    const r = contract.parseGenerativeUIResponse(env('text_only', { data: { url: 'https://evil.example/x' } }));
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

// ── G5.1 info_card ──
function infoEnv(overrides) {
    return JSON.stringify(Object.assign({
        ui_type: 'info_card',
        version: 1,
        summary: 'info',
        data: { title: 'Sys', items: [{ label: 'OS', value: 'Mint' }] }
    }, overrides || {}));
}

test('G5.1-1: valid info_card', () => {
    const r = contract.parseGenerativeUIResponse(infoEnv());
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'info_card');
});

test('G5.1-2: info_card without title invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { items: [{ label: 'a', value: 'b' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: '', items: [{ label: 'a', value: 'b' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 42, items: [{ label: 'a', value: 'b' }] } })).valid, false);
});

test('G5.1-3: items non-array invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: 'x' } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T' } })).valid, false);
});

test('G5.1-4: empty items invalid (min 1)', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [] } })).valid, false);
});

test('G5.1-5: over 6 items invalid', () => {
    const items = [];
    for (let i = 0; i < 7; i++) items.push({ label: 'l' + i, value: 'v' + i });
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: items } })).valid, false);
    const six = items.slice(0, 6);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: six } })).valid, true);
});

test('G5.1-6: item without label invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ value: 'v' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: '', value: 'v' }] } })).valid, false);
});

test('G5.1-7: item without value invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: 'l' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: 'l', value: '' }] } })).valid, false);
});

test('G5.1-8: non-string label/value invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: 1, value: 'v' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: 'l', value: 2 }] } })).valid, false);
});

test('G5.1-9: nested object/array in item rejected', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: 'l', value: { x: 1 } }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: [{ label: ['a'], value: 'v' }] } })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: { title: 'T', items: ['plain'] } })).valid, false);
});

test('G5.1-10: malformed info_card never throws', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv({ data: null })).valid, false);
    assert.equal(contract.validateGenerativeUI({ ui_type: 'info_card' }).valid, false);
});

test('G5.1-11: text_only regression still valid', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only')).valid, true);
});

// ── G6.1 stock_chart ──
function stockEnv(data) {
    return JSON.stringify({
        ui_type: 'stock_chart', version: 1, summary: 'stock',
        data: data || { symbol: 'BBRI', title: 'BBRI', points: [{ label: 'Jan', value: 4000 }, { label: 'Feb', value: 4100 }] }
    });
}
function pts(n, value) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ label: 'p' + i, value: value == null ? i : value });
    return out;
}
function stockObj(data) {
    return { ui_type: 'stock_chart', version: 1, summary: 'stock',
        data: data || { symbol: 'BBRI', title: 'BBRI', points: [{ label: 'Jan', value: 4000 }, { label: 'Feb', value: 4100 }] } };
}

test('G6.1-A: valid stock_chart simple', () => {
    const r = contract.parseGenerativeUIResponse(stockEnv());
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'stock_chart');
});

test('G6.1-B: two points valid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: pts(2) })).valid, true);
});

test('G6.1-C: fifty points valid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: pts(50) })).valid, true);
});

test('G6.1-D: under two points invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [] })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: pts(1) })).valid, false);
});

test('G6.1-E: over fifty points invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: pts(51) })).valid, false);
});

test('G6.1-F: empty symbol invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: '', title: 'T', points: pts(2) })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ title: 'T', points: pts(2) })).valid, false);
});

test('G6.1-G: empty title invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: '', points: pts(2) })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', points: pts(2) })).valid, false);
});

test('G6.1-H: empty label invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: '', value: 1 }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-I: non-number value invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: 'a', value: null }, { label: 'b', value: 2 }] })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: 'a' }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-J: string number rejected', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: 'a', value: '4500' }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-K: NaN rejected', () => {
    assert.equal(contract.validateGenerativeUI(stockObj({ symbol: 'S', title: 'T', points: [{ label: 'a', value: NaN }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-L: Infinity rejected', () => {
    assert.equal(contract.validateGenerativeUI(stockObj({ symbol: 'S', title: 'T', points: [{ label: 'a', value: Infinity }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-M: -Infinity rejected', () => {
    assert.equal(contract.validateGenerativeUI(stockObj({ symbol: 'S', title: 'T', points: [{ label: 'a', value: -Infinity }, { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-N: nested point data rejected', () => {
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: 'a', value: { x: 1 } }, { label: 'b', value: 2 }] })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: [{ label: ['a'], value: 1 }, { label: 'b', value: 2 }] })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: ['plain', { label: 'b', value: 2 }] })).valid, false);
});

test('G6.1-O: array data invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(JSON.stringify({ ui_type: 'stock_chart', version: 1, summary: 's', data: [] })).valid, false);
});

test('G6.1-P: oversize payload invalid', () => {
    const big = stockEnv({ symbol: 'S', title: 'T', points: pts(2) });
    const padded = big.slice(0, -1) + ',"pad":"' + 'x'.repeat(17 * 1024) + '"}';
    assert.ok(padded.length > 16 * 1024);
    assert.equal(contract.parseGenerativeUIResponse(padded).valid, false);
});

test('G6.1-Q: unknown fields excluded from value', () => {
    const r = contract.parseGenerativeUIResponse(stockEnv({ symbol: 'S', title: 'T', points: pts(2), series: [1], color: 'red' }));
    assert.equal(r.valid, true);
    assert.deepEqual(Object.keys(r.value).sort(), ['data', 'summary', 'ui_type', 'version']);
});

test('G6.1-R: info_card regression still valid', () => {
    assert.equal(contract.parseGenerativeUIResponse(infoEnv()).valid, true);
});

test('G6.1-S: existing G0/G5.1 tests unaffected (text_only valid)', () => {
    assert.equal(contract.parseGenerativeUIResponse(env('text_only')).valid, true);
});

// ── G7.1 sports_card schema ──
function sportEnv(data) {
    return JSON.stringify({ ui_type: 'sports_card', version: 1, summary: 'match',
        data: data || { title: 'Chelsea vs Arsenal', league: 'Premier League',
            home: { name: 'Chelsea', score: '2' }, away: { name: 'Arsenal', score: '1' }, status: 'FT' } });
}

test('G7.1-C1: valid sports_card', () => {
    const r = contract.parseGenerativeUIResponse(sportEnv());
    assert.equal(r.valid, true);
    assert.equal(r.value.ui_type, 'sports_card');
});

test('G7.1-C2: missing title invalid', () => {
    const d = { league: 'L', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' };
    assert.equal(contract.parseGenerativeUIResponse(sportEnv(d)).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv(Object.assign({}, d, { title: '' }))).valid, false);
});

test('G7.1-C3: missing league invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' })).valid, false);
});

test('G7.1-C4: missing home/away invalid', () => {
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', league: 'L', away: { name: 'A', score: '0' }, status: 'FT' })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', league: 'L', home: { name: 'H', score: '1' }, status: 'FT' })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', league: 'L', home: 'H', away: { name: 'A', score: '0' }, status: 'FT' })).valid, false);
});

test('G7.1-C5: empty name/score/status invalid', () => {
    const base = { title: 'T', league: 'L', home: { name: 'H', score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' };
    assert.equal(contract.parseGenerativeUIResponse(sportEnv(Object.assign({}, base, { home: { name: '', score: '1' } }))).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv(Object.assign({}, base, { away: { name: 'A', score: '' } }))).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv(Object.assign({}, base, { status: '' }))).valid, false);
});

test('G7.1-C6: nested invalid object rejected', () => {
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', league: 'L', home: { name: { x: 1 }, score: '1' }, away: { name: 'A', score: '0' }, status: 'FT' })).valid, false);
    assert.equal(contract.parseGenerativeUIResponse(sportEnv({ title: 'T', league: 'L', home: ['H'], away: { name: 'A', score: '0' }, status: 'FT' })).valid, false);
});
