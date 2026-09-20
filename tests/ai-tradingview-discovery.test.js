// tests/ai-tradingview-discovery.test.js — tools/list validation + read-only policy
const { test } = require('node:test');
const assert = require('node:assert');
const { createToolRegistry } = require('../ai/marketData/toolRegistry.js');

function tool(name, schema, extra) {
    return Object.assign({ name, description: name + ' tool', inputSchema: schema || { type: 'object', properties: {} } }, extra || {});
}
function strEnum(vals) { return { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: vals } }, required: ['symbol'] }; }

test('D1 valid tools admitted, malformed disabled', () => {
    const r = createToolRegistry({});
    r.update([{ name: 'search_symbols', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }, { name: '' }, null, { name: 'x' }]);
    assert.equal(r.isCallable('search_symbols'), true);
    assert.equal(r.isCallable(''), false);
    assert.equal(r.isCallable('x'), false);
});

test('D2 write tools blocked even when advertised', () => {
    const r = createToolRegistry({});
    r.update([tool('create_alert'), tool('delete_watchlist'), tool('get_ohlcv')]);
    assert.equal(r.isCallable('create_alert'), false);
    assert.equal(r.isCallable('delete_watchlist'), false);
    assert.equal(r.isCallable('get_ohlcv'), true);
});

test('D3 destructive annotation vetoes allowlisted tool', () => {
    const r = createToolRegistry({});
    r.update([tool('get_ohlcv', null, { annotations: { destructiveHint: true } })]);
    assert.equal(r.isCallable('get_ohlcv'), false);
    r.update([tool('get_ohlcv', null, { annotations: { readOnlyHint: true } })]);
    assert.equal(r.isCallable('get_ohlcv'), true);
});

test('D4 inputSchema validation accepts/rejects args', () => {
    const r = createToolRegistry({});
    r.update([tool('get_ohlcv', { type: 'object', properties: { symbol: { type: 'string' }, interval: { type: 'string', enum: ['1m', '1D'] } }, required: ['symbol'] })]);
    assert.equal(r.validate('get_ohlcv', { symbol: 'X' }).ok, true);
    assert.equal(r.validate('get_ohlcv', {}).ok, false);
    assert.equal(r.validate('get_ohlcv', { symbol: 'X', interval: '9z' }).ok, false);
    assert.ok(/9z|interval|enum/i.test(r.validate('get_ohlcv', { symbol: 'X', interval: '9z' }).error || ''));
});

test('D5 unknown tool validate fails closed unsupported_tool', () => {
    const r = createToolRegistry({});
    r.update([]);
    const v = r.validate('nope', {});
    assert.equal(v.ok, false);
    assert.equal(v.code, 'unsupported_tool');
});

test('D6 dynamic schema change re-admits tool shape', () => {
    const r = createToolRegistry({});
    r.update([tool('get_ohlcv', strEnum(['1m']))]);
    assert.equal(r.validate('get_ohlcv', { symbol: 'X', interval: '1D' }).ok, false);
    r.update([tool('get_ohlcv', strEnum(['1m', '1D']))]);
    assert.equal(r.validate('get_ohlcv', { symbol: 'X', interval: '1D' }).ok, true);
});

test('D7 screener columns cached, refetch only on miss', () => {
    const r = createToolRegistry({});
    assert.equal(r.screenerColumnsCached(), false);
    r.setScreenerColumns(['close', 'volume']);
    assert.equal(r.screenerColumnsCached(), true);
    assert.equal(r.screenerColumnsCover(['close']), true);
    assert.equal(r.screenerColumnsCover(['rsi']), false);
});
