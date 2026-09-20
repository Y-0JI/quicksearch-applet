// tests/ai-tradingview-transport.test.js — MCP Streamable HTTP transport (mock-first)
const { test } = require('node:test');
const assert = require('node:assert');
const { parseSseFrames } = require('../ai/marketData/sseParser.js');

test('T1 SSE: data frames parsed, comments ignored', () => {
    const raw = ': ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"v":2}}\n\n';
    const frames = parseSseFrames(raw);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].id, 1);
    assert.deepEqual(frames[0].result, { ok: true });
    assert.equal(frames[1].id, 2);
});

test('T2 SSE: error frame surfaces code/message', () => {
    const raw = 'data: {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found"}}\n\n';
    const frames = parseSseFrames(raw);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].error.code, -32601);
    assert.equal(frames[0].error.message, 'Method not found');
});

test('T3 SSE: malformed data line dropped, valid kept', () => {
    const raw = 'data: not-json\n\ndata: {"jsonrpc":"2.0","id":4,"result":{}}\n\n';
    const frames = parseSseFrames(raw);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].id, 4);
});

test('T4 SSE: server notification frame flagged, not a result', () => {
    const raw = 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n';
    const frames = parseSseFrames(raw);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].notification, true);
    assert.equal(frames[0].method, 'notifications/progress');
});

test('T5 SSE: empty input yields no frames', () => {
    assert.deepEqual(parseSseFrames(''), []);
    assert.deepEqual(parseSseFrames(null), []);
});
