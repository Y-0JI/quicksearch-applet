const { test } = require('node:test');
const assert = require('node:assert');
const { extractUrls } = require('../utils.js');

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
