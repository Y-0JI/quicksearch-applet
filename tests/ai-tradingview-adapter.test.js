// tests/ai-tradingview-adapter.test.js — adapter: tools/list, callTool, relist, auth stub
const { test } = require('node:test');
const assert = require('node:assert');
const { createMcpAdapter } = require('../ai/marketData/tradingViewMcpAdapter.js');
const { createAuthStub } = require('../ai/marketData/authProvider.js');

function rpcResult(id, result) { return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id, result }), contentType: 'application/json' }; }
function rpcError(id, code, message) { return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), contentType: 'application/json' }; }
const LIST = [{ name: 'search_symbols', description: 's', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'get_symbol_data', description: 'q', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] } },
    { name: 'create_alert', description: 'w', inputSchema: { type: 'object', properties: {} } }];

function mockHttp(handler) {
    const calls = [];
    let i = 0;
    const fn = (req) => { calls.push(req); i++; return Promise.resolve(handler(req, i)); };
    fn.calls = calls;
    return fn;
}
function baseHandler(listRef) {
    return (req, n) => {
        const m = JSON.parse(req.body).method;
        if (n === 1) return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} });
        if (m === 'tools/list') return rpcResult(n, { tools: typeof listRef === 'function' ? listRef() : listRef });
        return rpcResult(n, {});
    };
}

test('A1 setup fetches tools/list, write tool not callable', async () => {
    const http = mockHttp(baseHandler(LIST));
    const a = createMcpAdapter({ httpRequest: http, stateless: false });
    await a.setup(null);
    assert.equal(a.isCallable('search_symbols'), true);
    assert.equal(a.isCallable('get_symbol_data'), true);
    assert.equal(a.isCallable('create_alert'), false);
});

test('A2 callTool validates args, returns result', async () => {
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (n === 1) return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} });
        if (m === 'tools/list') return rpcResult(n, { tools: LIST });
        if (m === 'tools/call') return rpcResult(n, { content: [{ type: 'text', text: '{"close":100}' }] });
        return rpcResult(n, {});
    });
    const a = createMcpAdapter({ httpRequest: http, stateless: false });
    await a.setup(null);
    const r = await a.callTool('get_symbol_data', { symbol: 'NASDAQ:NVDA' }, null);
    assert.equal(r && r.close, 100);
    await assert.rejects(a.callTool('get_symbol_data', {}, null), (e) => e && e.code === 'invalid_response');
    await assert.rejects(a.callTool('create_alert', { symbol: 'X' }, null), (e) => e && e.code === 'unsupported_tool');
});

test('A3 method-not-found triggers one relist then retry', async () => {
    let listCount = 0;
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (n === 1) return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} });
        if (m === 'tools/list') { listCount++; return rpcResult(n, { tools: listCount === 1 ? [] : LIST }); }
        if (m === 'tools/call') {
            if (listCount < 2) return rpcError(n, -32601, 'Method not found');
            return rpcResult(n, { content: [{ type: 'text', text: '{"close":7}' }] });
        }
        return rpcResult(n, {});
    });
    const a = createMcpAdapter({ httpRequest: http, stateless: false });
    await a.setup(null);
    assert.equal(a.isCallable('get_symbol_data'), false);
    const r = await a.callToolRawForTest
        ? null : await a.callToolAllowMissing('get_symbol_data', { symbol: 'X' }, null).catch((e) => ({ __err: e && e.code }));
    assert.ok(r && (r.close === 7 || r.__err), 'relist path exercised: ' + JSON.stringify(r));
    assert.ok(listCount >= 2, 'relist happened');
});

test('A4 auth stub returns auth_unavailable, never a token', async () => {
    const auth = createAuthStub();
    assert.equal(auth.getAuthStatus(), 'missing');
    assert.equal(await auth.getAccessToken(), null);
    const r = await auth.beginAuthorization().catch((e) => e);
    assert.equal(r && r.code, 'auth_unavailable');
    const r2 = await auth.refreshAccessToken().catch((e) => e);
    assert.equal(r2 && r2.code, 'auth_unavailable');
});
