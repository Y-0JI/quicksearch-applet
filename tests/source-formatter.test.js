const { test } = require('node:test');
const assert = require('node:assert');
const { formatSources, normalizeSource } = require('../ai/sourceFormatter.js');

test('formatSources: valid normalization', () => {
    const out = formatSources([{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://example.com/a');
});

test('formatSources: invalid ignored', () => {
    const out = formatSources([
        { title: 'T', url: 'https://example.com', snippet: 's' },
        { title: 'bad', url: 'ftp://example.com' },
        { title: '', url: 'https://example.com/b' },
        null, 'string', {}
    ]);
    assert.equal(out.length, 1);
});

test('formatSources: missing url handled', () => {
    assert.deepEqual(formatSources([{ title: 'T', snippet: 's' }]), []);
    assert.deepEqual(formatSources([{ title: 'T', url: '' }]), []);
});

test('formatSources: multiple preserved', () => {
    const out = formatSources([
        { title: 'A', url: 'https://a.com', snippet: '1' },
        { title: 'B', url: 'https://b.com', snippet: '2' }
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].url, 'https://b.com');
});

test('normalizeSource: http and https only', () => {
    assert.equal(normalizeSource({ title: 'T', url: 'javascript:alert(1)' }), null);
    assert.ok(normalizeSource({ title: 'T', url: 'http://example.com' }));
    assert.ok(normalizeSource({ title: 'T', url: 'https://example.com' }));
});

test('formatSources: non-array returns []', () => {
    assert.deepEqual(formatSources(null), []);
    assert.deepEqual(formatSources('x'), []);
});
