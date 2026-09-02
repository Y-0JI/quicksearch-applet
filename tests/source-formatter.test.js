const { test } = require('node:test');
const assert = require('node:assert');
const { formatSources, normalizeSource } = require('../ai/sourceFormatter.js');

test('formatSources: valid normalization', () => {
    const out = formatSources([{ title: 'T', url: 'https://example.com/a', snippet: 's' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://example.com/a');
});

test('formatSources: invalid ignored (fallback counts)', () => {
    const out = formatSources([
        { title: 'T', url: 'https://example.com', snippet: 's' },
        { title: 'bad', url: 'ftp://example.com' },
        { title: '', url: 'https://example.com/b' },
        null, 'string', {}
    ]);
    // empty title falls back to domain per AI-5 §4
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://example.com');
    assert.equal(out[1].url, 'https://example.com/b');
    assert.equal(out[1].title, 'example.com');
    assert.equal(out[1].domain, 'example.com');
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

test('formatSources: deduplicates duplicate URLs', () => {
    const dup = 'https://example.com/article';
    const out = formatSources([
        { title: 'Keep', url: dup, snippet: '1' },
        { title: 'Drop', url: dup, snippet: '2' }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'Keep');
});

test('normalizeSource: javascript/data/file rejected', () => {
    assert.equal(normalizeSource({ title: 'x', url: 'javascript:alert(1)' }), null);
    assert.equal(normalizeSource({ title: 'x', url: 'data:text/html,hi' }), null);
    assert.equal(normalizeSource({ title: 'x', url: 'file:///etc/passwd' }), null);
});
