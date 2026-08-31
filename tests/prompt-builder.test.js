const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, buildGroundingContext, buildUserPrompt } = require('../ai/promptBuilder.js');

test('system prompt contains grounding rules', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('web_search'));
    assert.ok(s.includes('Do not invent'));
    assert.ok(s.includes('ground'));
});

test('grounding context formats results', () => {
    const c = buildGroundingContext([{ title: 'T', url: 'https://example.com', snippet: 'snip' }]);
    assert.ok(c.includes('https://example.com'));
    assert.ok(c.includes('T'));
});

test('grounding empty -> empty string', () => {
    assert.equal(buildGroundingContext([]), '');
    assert.equal(buildGroundingContext(null), '');
});

test('user prompt appends grounding', () => {
    const p = buildUserPrompt('q?', [{ title: 'T', url: 'https://example.com', snippet: 's' }]);
    assert.ok(p.startsWith('q?'));
    assert.ok(p.includes('https://example.com'));
});
