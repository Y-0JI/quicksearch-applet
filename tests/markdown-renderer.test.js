// AI response markdown rendering — pure parser regression tests.
// Covers: plain text, **bold**, inline bold, *italic*, unordered/ordered lists,
// multi-line structure, citation [1] passthrough, HTML-injection safety, malformed
// input without crash, fenced code verbatim.
const { test } = require('node:test');
const assert = require('node:assert');
const {
    parseInline,
    parseMarkdownBlocks,
    blockToMarkup,
    markdownToMarkup,
    blockToPlainText
} = require('../ai/markdownRenderer.js');

// ── inline ────────────────────────────────────────────────────────────────────
test('plain text stays a single plain span', () => {
    const spans = parseInline('Harga saham BMRI sekitar Rp4.450.');
    assert.deepStrictEqual(spans, [{ style: 'plain', text: 'Harga saham BMRI sekitar Rp4.450.' }]);
});

test('whole-line **bold** produces one bold span without markers', () => {
    const spans = parseInline('**Kiper (4):**');
    assert.deepStrictEqual(spans, [{ style: 'bold', text: 'Kiper (4):' }]);
});

test('bold in the middle of a sentence', () => {
    const spans = parseInline('Chelsea memiliki **28 pemain** musim ini.');
    assert.deepStrictEqual(spans, [
        { style: 'plain', text: 'Chelsea memiliki ' },
        { style: 'bold', text: '28 pemain' },
        { style: 'plain', text: ' musim ini.' }
    ]);
});

test('*italic* produces an italic span', () => {
    const spans = parseInline('Istilah *market cap* dipakai di sini.');
    assert.deepStrictEqual(spans, [
        { style: 'plain', text: 'Istilah ' },
        { style: 'italic', text: 'market cap' },
        { style: 'plain', text: ' dipakai di sini.' }
    ]);
});

test('bold and italic both on one line', () => {
    const spans = parseInline('**Harga:** naik *sedikit* hari ini');
    assert.deepStrictEqual(spans, [
        { style: 'bold', text: 'Harga:' },
        { style: 'plain', text: ' naik ' },
        { style: 'italic', text: 'sedikit' },
        { style: 'plain', text: ' hari ini' }
    ]);
});

test('asterisks in numbers/multiplication are not swallowed', () => {
    const spans = parseInline('Hasil 2 * 3 = 6 dan **x** tetap');
    assert.ok(spans.some(s => s.text.indexOf('2 * 3') !== -1), 'literal 2 * 3 kept');
});

// ── blocks ────────────────────────────────────────────────────────────────────
test('plain paragraphs stay paragraphs', () => {
    const blocks = parseMarkdownBlocks('Harga BMRI hari ini di sekitar Rp4.450.');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'paragraph');
});

test('unordered list becomes a list block with bullet items', () => {
    const blocks = parseMarkdownBlocks('- Robert Sánchez\n- Mike Penders\n- Filip Jørgensen');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].kind, 'list');
    assert.strictEqual(blocks[0].ordered, false);
    assert.strictEqual(blocks[0].items.length, 3);
    assert.strictEqual(blocks[0].items[0].num, null);
    assert.deepStrictEqual(blocks[0].items[0].spans, [{ style: 'plain', text: 'Robert Sánchez' }]);
    const mk = blockToMarkup(blocks[0]);
    assert.ok(mk.indexOf('\u2022') !== -1, 'bullet present');
    assert.ok(mk.split('\n').length === 3, 'one line per item');
});

test('ordered list preserves the numbers', () => {
    const blocks = parseMarkdownBlocks('1. Robert Sánchez\n2. Mike Penders\n3. Filip Jørgensen');
    assert.strictEqual(blocks[0].kind, 'list');
    assert.strictEqual(blocks[0].ordered, true);
    assert.strictEqual(blocks[0].items[1].num, '2.');
    assert.ok(blockToMarkup(blocks[0]).indexOf('2.') !== -1, 'number kept in markup');
});

test('multi-line response: bold heading + list are separate blocks in order', () => {
    const text = '**Kiper (4):**\n- Emiliano Martínez\n- Mike Penders\n\n**Bek (12):**\n- Josh Acheampong\n- Aaron Anselmino';
    const blocks = parseMarkdownBlocks(text);
    assert.strictEqual(blocks.length, 4, 'heading, list, heading, list');
    assert.strictEqual(blocks[0].kind, 'paragraph');
    assert.strictEqual(blocks[1].kind, 'list');
    assert.strictEqual(blocks[2].kind, 'paragraph');
    assert.strictEqual(blocks[3].kind, 'list');
    // heading paragraph is a bold span; no literal ** anywhere in the markup
    const all = blocks.map(blockToMarkup).join('\n');
    assert.ok(all.indexOf('**') === -1, 'no raw ** markers left');
    assert.ok(all.indexOf('<b>Kiper (4):</b>') !== -1, 'heading is bold');
});

test('citation markers [1] pass through untouched', () => {
    const text = 'Harga saham Rp4.450 [1] dan penutupan sebelumnya [2][3].';
    const blocks = parseMarkdownBlocks(text);
    const mk = blockToMarkup(blocks[0]);
    assert.ok(mk.indexOf('[1]') !== -1);
    assert.ok(mk.indexOf('[2][3]') !== -1);
});

// ── security ──────────────────────────────────────────────────────────────────
test('raw HTML is escaped, never executable', () => {
    const text = 'Jawaban <script>alert(1)</script> dan <img src=x onerror=alert(2)> **tebal**';
    const mk = markdownToMarkup(text);
    assert.ok(mk.indexOf('<script>') === -1, 'no raw script tag');
    assert.ok(mk.indexOf('<img') === -1, 'no raw img tag');
    assert.ok(mk.indexOf('&lt;script&gt;') !== -1, 'script escaped');
    assert.ok(mk.indexOf('&lt;img') !== -1, 'img escaped');
    assert.ok(mk.indexOf('<b>tebal</b>') !== -1, 'own bold tag still emitted');
});

test('markdown-looking text inside ** is escaped too', () => {
    const mk = markdownToMarkup('**<b>x</b>**');
    assert.ok(mk.indexOf('&lt;b&gt;') !== -1, 'inner html escaped');
    assert.ok(mk.indexOf('<b>&lt;b&gt;x&lt;/b&gt;</b>') !== -1, 'wrapped safely');
});

// ── robustness ────────────────────────────────────────────────────────────────
test('malformed emphasis does not crash and keeps literal asterisks', () => {
    for (const bad of ['**unclosed', '*unclosed', 'a ** b', '***', '*****', '**a**b**c**', '']) {
        const spans = parseInline(bad);
        assert.ok(Array.isArray(spans), 'spans for: ' + JSON.stringify(bad));
        const blocks = parseMarkdownBlocks(bad + '\nmore');
        assert.ok(Array.isArray(blocks), 'blocks for: ' + JSON.stringify(bad));
    }
    const spans = parseInline('**unclosed');
    assert.ok(spans.some(s => s.text.indexOf('**') !== -1), 'literal ** retained when unbalanced');
});

test('fenced code stays verbatim (no inline parse, no style)', () => {
    const text = 'Contoh:\n```\n**not bold**\n- not a list\n```\nSetelahnya **tebal**.';
    const blocks = parseMarkdownBlocks(text);
    const kinds = blocks.map(b => b.kind);
    assert.deepStrictEqual(kinds, ['paragraph', 'code', 'paragraph']);
    assert.deepStrictEqual(blocks[1].lines, ['**not bold**', '- not a list']);
    const mk = blockToMarkup(blocks[1]);
    assert.ok(mk.indexOf('**not bold**') !== -1, 'fence content verbatim');
    assert.ok(mk.indexOf('<b>') === -1, 'no bold inside fence');
});

test('plain fallback text drops markers but keeps content', () => {
    const blocks = parseMarkdownBlocks('**Kiper:**\n- A\n1. B\n\nTeks **tebal** biasa.');
    const plain = blocks.map(blockToPlainText).join('\n');
    assert.ok(plain.indexOf('Kiper:') !== -1);
    assert.ok(plain.indexOf('**') === -1, 'no markers in plain fallback');
    assert.ok(plain.indexOf('Teks tebal biasa.') !== -1);
});

test('empty input produces no blocks without crashing', () => {
    assert.deepStrictEqual(parseMarkdownBlocks(''), []);
    assert.deepStrictEqual(parseMarkdownBlocks(null), []);
    assert.deepStrictEqual(parseMarkdownBlocks(undefined), []);
    assert.strictEqual(markdownToMarkup(''), '');
});
