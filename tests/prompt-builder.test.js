const { test } = require('node:test');
const assert = require('node:assert');
const { buildSystemPrompt, buildGroundingContext, buildUserPrompt } = require('../ai/promptBuilder.js');

test('system prompt contains grounding rules', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('web_search'));
    assert.ok(s.includes('Do not invent'));
    assert.ok(s.includes('ground'));
});

test('system prompt: global adaptive response structure (not a finance template)', () => {
    const s = buildSystemPrompt();
    // length principle: short as necessary, detailed as needed
    assert.ok(s.includes('as short as necessary and as detailed as needed'), 'length principle present');
    assert.ok(s.includes('do not open with filler'), 'no robotic opener rule');
    // adaptive cases exist and are generic across topics
    assert.ok(s.includes('- Simple question or short definition:'), 'simple question case');
    assert.ok(s.includes('- Multiple facts, figures or data points:'), 'data case');
    assert.ok(s.includes('- Explicit list request'), 'full-list case');
    assert.ok(s.includes('- Explanation of a concept:'), 'concept case');
    assert.ok(s.includes('- Troubleshooting or error:'), 'troubleshooting case');
    assert.ok(s.includes('- Comparison:'), 'comparison case');
    assert.ok(s.includes('- Tutorial or how-to:'), 'tutorial case');
    assert.ok(s.includes('never a finance-only template'), 'explicitly not finance-only');
    assert.ok(!s.includes('trading sessions'), 'not anchored to a finance template');
});

test('system prompt: completeness rules (no fake truncation of full lists)', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('Provide the full list whenever the available data contains it'), 'full-list completeness');
    assert.ok(s.includes('dan lainnya'), 'lists dan lainnya explicitly forbidden');
    assert.ok(s.includes('say which part is missing'), 'incomplete data handled honestly');
});

test('system prompt: markdown subset rules match the safe renderer', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('use only the simple subset the client renders'), 'markdown subset rule');
    assert.ok(s.includes('**bold**'), 'bold mentioned');
    assert.ok(s.includes('*italic*'), 'italic mentioned');
    assert.ok(s.includes('Never use "#" headings, tables'), 'unsupported markdown banned');
    assert.ok(s.includes('do not bold every sentence'), 'no over-bold');
    assert.ok(s.includes('do not turn every answer into a list'), 'no list-everything');
});

test('system prompt: follow-up/multi-turn style stays natural', () => {
    const s = buildSystemPrompt();
    assert.ok(s.includes('In follow-ups and multi-turn conversation keep the same natural, adaptive style'), 'multi-turn rule');
    assert.ok(s.includes('without re-announcing or re-summarizing your previous answer'), 'no re-summary filler');
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
