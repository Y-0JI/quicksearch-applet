const { test } = require('node:test');
const assert = require('node:assert');
const { detectUrl } = require('../providers/urlProvider.js');

test('explicit scheme', () => {
    assert.equal(detectUrl('https://github.com'), 'https://github.com');
    assert.equal(detectUrl('http://example.com/page?x=1'), 'http://example.com/page?x=1');
});

test('bare domain gets https', () => {
    assert.equal(detectUrl('github.com'), 'https://github.com');
    assert.equal(detectUrl('www.linuxmint.com'), 'https://www.linuxmint.com');
});

test('path and port preserved', () => {
    assert.equal(detectUrl('github.com/yoji/repo'), 'https://github.com/yoji/repo');
    assert.equal(detectUrl('localhost:8080/admin'), 'https://localhost:8080/admin');
});

test('spaces never a URL', () => {
    assert.equal(detectUrl('best linux site dot com'), null);
    assert.equal(detectUrl('github com'), null);
});

test('random words rejected', () => {
    assert.equal(detectUrl('firefox'), null);
    assert.equal(detectUrl('document.pdf'), null);
    assert.equal(detectUrl('2+2'), null);
    assert.equal(detectUrl('file.txt'), null);
    assert.equal(detectUrl(''), null);
});
