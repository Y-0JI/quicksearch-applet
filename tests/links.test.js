const { test } = require('node:test');
const assert = require('node:assert');
const { extractUrls, splitTextAndUrls } = require('../utils.js');

test('no urls -> empty', () => {
    assert.deepEqual(extractUrls('teks biasa tanpa link'), []);
});

test('single url with query params (maps example)', () => {
    assert.deepEqual(
        extractUrls('Makam Bung Karno ada di Blitar.\nhttps://www.google.com/maps/search/?api=1&query=Makam+Bungkarno+Blitar'),
        ['https://www.google.com/maps/search/?api=1&query=Makam+Bungkarno+Blitar']
    );
});

test('two urls both captured in order', () => {
    assert.deepEqual(
        extractUrls('lihat https://a.com/x. dan https://b.com/y?'),
        ['https://a.com/x', 'https://b.com/y']
    );
});

test('unsafe schemes never captured (untrusted AI text)', () => {
    assert.deepEqual(extractUrls('javascript:alert(1) file:///etc/passwd data:text/html,x'), []);
});

test('trailing punctuation stripped, url kept', () => {
    assert.deepEqual(extractUrls('buka https://example.com/page.'), ['https://example.com/page']);
});

test('duplicate urls deduped, order preserved', () => {
    assert.deepEqual(
        extractUrls('https://a.com https://b.com https://a.com'),
        ['https://a.com', 'https://b.com']
    );
});

// ---- splitTextAndUrls: inline text/url sequence for AI chat rendering ----

test('split: no url -> single text segment', () => {
    assert.deepEqual(
        splitTextAndUrls('Link biografi Gusdur tidak tersedia.'),
        [{ type: 'text', value: 'Link biografi Gusdur tidak tersedia.' }]
    );
});

test('split: single url mid-sentence -> text/url/text', () => {
    const segs = splitTextAndUrls(
        'Link biografi Gusdur: https://id.wikipedia.org/wiki/Abdurrahman_Wahid silakan dibaca.'
    );
    assert.deepEqual(segs.map(s => s.type), ['text', 'url', 'text']);
    assert.equal(segs[1].value, 'https://id.wikipedia.org/wiki/Abdurrahman_Wahid');
    assert.equal(segs[0].value, 'Link biografi Gusdur: ');
    assert.equal(segs[2].value, ' silakan dibaca.');
});

test('split: two urls keep original positions and order', () => {
    const segs = splitTextAndUrls('lihat https://a.com/x dan https://b.com/y ya');
    assert.deepEqual(segs.map(s => s.type), ['text', 'url', 'text', 'url', 'text']);
    assert.deepEqual(segs.filter(s => s.type === 'url').map(s => s.value),
        ['https://a.com/x', 'https://b.com/y']);
});

test('split: url at end of response', () => {
    const segs = splitTextAndUrls('sumbernya https://example.com/page');
    assert.deepEqual(segs.map(s => s.type), ['text', 'url']);
    assert.equal(segs[1].value, 'https://example.com/page');
});

test('split: trailing punctuation stays in surrounding text', () => {
    const segs = splitTextAndUrls('buka https://example.com/page. lalu');
    assert.equal(segs[1].value, 'https://example.com/page');
    assert.equal(segs[2].value, '. lalu');
});

test('split: unsafe schemes never segmented as url (untrusted)', () => {
    assert.deepEqual(
        splitTextAndUrls('javascript:alert(1) file:///etc/passwd data:text/html,x'),
        [{ type: 'text', value: 'javascript:alert(1) file:///etc/passwd data:text/html,x' }]
    );
});

test('split: newlines preserved inside text segments', () => {
    const segs = splitTextAndUrls('baris satu\nhttps://a.com\nbaris tiga');
    assert.deepEqual(segs.map(s => s.type), ['text', 'url', 'text']);
    assert.equal(segs[0].value, 'baris satu\n');
    assert.equal(segs[2].value, '\nbaris tiga');
});

test('split: duplicate urls both kept at own positions (no dedupe)', () => {
    const segs = splitTextAndUrls('https://a.com lalu https://a.com lagi');
    assert.deepEqual(segs.filter(s => s.type === 'url').map(s => s.value),
        ['https://a.com', 'https://a.com']);
});

test('split: empty input -> empty sequence', () => {
    assert.deepEqual(splitTextAndUrls(''), []);
});
