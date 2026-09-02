const { test } = require('node:test');
const assert = require('node:assert');
const { formatSources, normalizeSource, isHttpUrl } = require('../ai/sourceFormatter.js');

// Phase AI-5: Source normalization with domain field

test('normalizeSource: extracts domain from URL', () => {
    const result = normalizeSource({ title: 'Example', url: 'https://example.com/article', snippet: 'test' });
    assert.ok(result);
    assert.equal(result.domain, 'example.com');
    assert.equal(result.url, 'https://example.com/article');
    assert.equal(result.title, 'Example');
});

test('normalizeSource: extracts domain from HTTP URL', () => {
    const result = normalizeSource({ title: 'Test', url: 'http://test.org/path', snippet: '' });
    assert.ok(result);
    assert.equal(result.domain, 'test.org');
});

test('normalizeSource: domain extraction handles subdomains', () => {
    const result = normalizeSource({ title: 'Sub', url: 'https://blog.example.co.uk/post', snippet: '' });
    assert.ok(result);
    assert.equal(result.domain, 'blog.example.co.uk');
});

test('normalizeSource: invalid URL returns null', () => {
    assert.equal(normalizeSource({ title: 'Bad', url: 'ftp://example.com' }), null);
    assert.equal(normalizeSource({ title: 'Bad', url: 'javascript:alert(1)' }), null);
    assert.equal(normalizeSource({ title: 'Bad', url: 'data:text/html,<h1>test</h1>' }), null);
    assert.equal(normalizeSource({ title: 'Bad', url: 'file:///etc/passwd' }), null);
});

test('normalizeSource: empty URL returns null', () => {
    assert.equal(normalizeSource({ title: 'Empty', url: '' }), null);
    assert.equal(normalizeSource({ title: 'Missing', url: undefined }), null);
});

test('normalizeSource: missing title returns null', () => {
    assert.equal(normalizeSource({ url: 'https://example.com' }), null);
    assert.equal(normalizeSource({ title: '', url: 'https://example.com' }), null);
});

test('formatSources: multiple sources with domains', () => {
    const input = [
        { title: 'First', url: 'https://first.com/a', snippet: '1' },
        { title: 'Second', url: 'https://second.org/b', snippet: '2' },
        { title: 'Third', url: 'https://third.net/c', snippet: '3' }
    ];
    const result = formatSources(input);
    assert.equal(result.length, 3);
    assert.equal(result[0].domain, 'first.com');
    assert.equal(result[1].domain, 'second.org');
    assert.equal(result[2].domain, 'third.net');
});

test('formatSources: invalid sources filtered out', () => {
    const input = [
        { title: 'Valid', url: 'https://valid.com', snippet: '' },
        { title: 'Bad URL', url: 'ftp://invalid.com', snippet: '' },
        { title: '', url: 'https://no-title.com', snippet: '' },
        null,
        { title: 'Also Valid', url: 'https://also-valid.com', snippet: '' }
    ];
    const result = formatSources(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].domain, 'valid.com');
    assert.equal(result[1].domain, 'also-valid.com');
});

test('formatSources: non-array returns empty array', () => {
    assert.deepEqual(formatSources(null), []);
    assert.deepEqual(formatSources(undefined), []);
    assert.deepEqual(formatSources('string'), []);
    assert.deepEqual(formatSources(123), []);
});

test('normalizeSource: URL validation rejects dangerous protocols', () => {
    // These should all be rejected
    assert.equal(isHttpUrl('javascript:alert(1)'), false);
    assert.equal(isHttpUrl('data:text/html,<script>alert(1)</script>'), false);
    assert.equal(isHttpUrl('file:///etc/passwd'), false);
    assert.equal(isHttpUrl('ftp://example.com'), false);
    assert.equal(isHttpUrl(''), false);
    assert.equal(isHttpUrl(null), false);
    assert.equal(isHttpUrl(undefined), false);
    
    // These should be accepted
    assert.equal(isHttpUrl('http://example.com'), true);
    assert.equal(isHttpUrl('https://example.com'), true);
    assert.equal(isHttpUrl('https://example.com/path?query=1#fragment'), true);
});

test('normalizeSource: preserves snippet content', () => {
    const result = normalizeSource({ 
        title: 'Test', 
        url: 'https://example.com', 
        snippet: 'This is a snippet with content' 
    });
    assert.ok(result);
    assert.equal(result.snippet, 'This is a snippet with content');
});

test('normalizeSource: handles missing snippet', () => {
    const result = normalizeSource({ title: 'Test', url: 'https://example.com' });
    assert.ok(result);
    assert.equal(result.snippet, '');
});

test('normalizeSource: snippet truncation at 500 chars', () => {
    const longSnippet = 'a'.repeat(600);
    const result = normalizeSource({ title: 'Test', url: 'https://example.com', snippet: longSnippet });
    assert.ok(result);
    assert.equal(result.snippet.length, 500);
});

test('normalizeSource: title truncation at 200 chars', () => {
    const longTitle = 'a'.repeat(250);
    const result = normalizeSource({ title: longTitle, url: 'https://example.com', snippet: '' });
    assert.ok(result);
    assert.equal(result.title.length, 200);
});

test('formatSources: handles mixed valid and invalid', () => {
    const input = [
        { title: 'Valid 1', url: 'https://valid1.com', snippet: '' },
        { title: 'Invalid', url: 'javascript:alert(1)', snippet: '' },
        { title: 'Valid 2', url: 'https://valid2.com', snippet: '' },
        { title: '', url: 'https://no-title.com', snippet: '' },
        { title: 'Valid 3', url: 'https://valid3.com', snippet: '' }
    ];
    const result = formatSources(input);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'Valid 1');
    assert.equal(result[1].title, 'Valid 2');
    assert.equal(result[2].title, 'Valid 3');
});
