const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeSearchEngine } = require('../utils.js');

test('valid ids pass through', () => {
    assert.equal(normalizeSearchEngine('ddgo'), 'ddgo');
    assert.equal(normalizeSearchEngine('google'), 'google');
    assert.equal(normalizeSearchEngine('bing'), 'bing');
});

test('legacy labels map to ids (case-insensitive)', () => {
    assert.equal(normalizeSearchEngine('DuckDuckGo'), 'ddgo');
    assert.equal(normalizeSearchEngine('Google'), 'google');
    assert.equal(normalizeSearchEngine('BING'), 'bing');
    assert.equal(normalizeSearchEngine('  google  '), 'google');
    assert.equal(normalizeSearchEngine('duckduckgo'), 'ddgo');
});

test('invalid values -> null (caller logs + applies default)', () => {
    assert.equal(normalizeSearchEngine('yahoo'), null);
    assert.equal(normalizeSearchEngine(''), null);
    assert.equal(normalizeSearchEngine(null), null);
});

test('searxng id and legacy label normalize to searxng', () => {
    assert.equal(normalizeSearchEngine('searxng'), 'searxng');
    assert.equal(normalizeSearchEngine('SearXNG (Local)'), 'searxng');
    assert.equal(normalizeSearchEngine('SEARXNG'), 'searxng');
});
