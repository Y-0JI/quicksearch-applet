const { test } = require('node:test');
const assert = require('node:assert');
const { createMockAiProvider, normalizeResult } = require('../ai/aiProvider.js');

test('provider: normal answer', () => {
    const p = createMockAiProvider({ responses: [{ type: 'answer', text: 'hello' }] });
    p.request({ query: 'hi' }, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.type, 'answer');
        assert.equal(res.text, 'hello');
    });
});

test('provider: web_search tool_call', () => {
    const p = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'web_search', arguments: { query: 'q' } }] });
    p.request({ query: 'hi' }, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.type, 'tool_call');
        assert.equal(res.arguments.query, 'q');
    });
});

test('provider: unknown tool rejected', () => {
    const p = createMockAiProvider({ responses: [{ type: 'tool_call', tool: 'exec', arguments: { query: 'q' } }] });
    p.request({ query: 'hi' }, (err) => {
        assert.ok(err);
        assert.equal(err.code, 'unsupported_tool');
    });
});

test('provider: malformed response handled', () => {
    const p = createMockAiProvider({ responses: [{ type: 'answer' }] });
    p.request({ query: 'hi' }, (err) => {
        assert.ok(err);
        assert.equal(err.code, 'invalid_response');
    });
});

test('provider: does not expose raw', () => {
    const p = createMockAiProvider({ responses: [{ type: 'answer', text: 'ok', _raw: { secret: 1 } }] });
    p.request({ query: 'hi' }, (err, res) => {
        assert.equal(res._raw, undefined);
    });
});

test('normalizeResult: invalid returns error', () => {
    assert.equal(normalizeResult(null).type, 'error');
    assert.equal(normalizeResult({}).type, 'error');
    assert.equal(normalizeResult({ type: 'tool_call', tool: 'exec', arguments: { query: 'x' } }).code, 'unsupported_tool');
});
