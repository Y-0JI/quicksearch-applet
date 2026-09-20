// tests/ai-tradingview-mcp-transport.test.js — transport core (mock httpRequest)
const { test } = require('node:test');
const assert = require('node:assert');
const { createMcpTransport } = require('../ai/marketData/tradingViewMcpTransport.js');

function mockHttp(responses) {
    let i = 0;
    const calls = [];
    const fn = (req, canc) => {
        calls.push(req);
        const r = Array.isArray(responses) ? responses[Math.min(i++, responses.length - 1)] : responses;
        if (typeof r === 'function') return r(req, canc);
        return Promise.resolve(r);
    };
    fn.calls = calls;
    return fn;
}
function okJson(result, headers) {
    return { status: 200, headers: headers || {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, result }), contentType: 'application/json' };
}
function cancelled() { return { is_cancelled: () => true }; }

test('M1 JSON response resolves correlated result', async () => {
    const http = mockHttp(okJson({ tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    const res = await t.call('tools/list', {}, null);
    assert.deepEqual(res, { tools: [] });
});

test('M2 SSE response resolves correlated result', async () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,"result":{"hello":1}}\n\n';
    const http = mockHttp({ status: 200, headers: {}, bodyText: body, contentType: 'text/event-stream' });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    const res = await t.call('tools/list', {}, null);
    assert.deepEqual(res, { hello: 1 });
});

test('M3 malformed body maps to invalid_response', async () => {
    const http = mockHttp({ status: 200, headers: {}, bodyText: 'not-json{{{', contentType: 'application/json' });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    await assert.rejects(t.call('tools/list', {}, null), (e) => e && e.code === 'invalid_response');
});

test('M4 401 maps to auth error without leaking token', async () => {
    const http = mockHttp({ status: 401, headers: {}, bodyText: '{"detail":"nope"}', contentType: 'application/json' });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], getAccessToken: async () => 'SECRET-TOKEN-XYZ' });
    await assert.rejects(t.call('tools/list', {}, null), (e) => {
        assert.equal(e.code === 'auth_expired' || e.code === 'auth_missing', true);
        assert.ok(!String(e.message || '').includes('SECRET-TOKEN-XYZ'), 'token leaked');
        return true;
    });
    assert.ok(!String(JSON.stringify(http.calls)).includes('SECRET-TOKEN-XYZ') || http.calls[0].headers.Authorization === 'Bearer SECRET-TOKEN-XYZ');
});

test('M5 403 maps to auth_forbidden, 429 to rate_limited', async () => {
    const t403 = createMcpTransport({ httpRequest: mockHttp({ status: 403, headers: {}, bodyText: 'x', contentType: 'text/plain' }), supportedVersions: ['2025-06-18'] });
    await assert.rejects(t403.call('a', {}, null), (e) => e && e.code === 'auth_forbidden');
    const t429 = createMcpTransport({ httpRequest: mockHttp({ status: 429, headers: { 'retry-after': '2' }, bodyText: 'x', contentType: 'text/plain' }), supportedVersions: ['2025-06-18'] });
    await assert.rejects(t429.call('a', {}, null), (e) => e && e.code === 'rate_limited');
});

test('M6 cancelled cancellable rejects cancelled', async () => {
    const http = mockHttp(okJson({}));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    await assert.rejects(t.call('tools/list', {}, cancelled()), (e) => e && e.code === 'cancelled');
    assert.equal(http.calls.length, 0);
});

test('M7 timeout maps to timeout', async () => {
    const http = () => new Promise(() => {});
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], timeoutMs: 20 });
    await assert.rejects(t.call('tools/list', {}, null), (e) => e && e.code === 'timeout');
});

test('M8 JSON-RPC error maps to invalid_response/method error', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
    const http = mockHttp({ status: 200, headers: {}, bodyText: body, contentType: 'application/json' });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    await assert.rejects(t.call('nope', {}, null), (e) => e && (e.code === 'unsupported_tool' || e.code === 'invalid_response'));
});

test('M9 unsupported version folds to unsupported_protocol after exhausting list', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Unsupported protocol version 2025-06-18' } });
    const http = mockHttp({ status: 200, headers: {}, bodyText: body, contentType: 'application/json' });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'] });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'unsupported_protocol');
});

test('M10 legacy setup captures session id; missing on session-based is error', async () => {
    const initRes = { protocolVersion: '2025-06-18', capabilities: {} };
    const httpNoSess = mockHttp(okJson(initRes, {}));
    const t = createMcpTransport({ httpRequest: httpNoSess, supportedVersions: ['2025-06-18'], requireSession: true });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'invalid_response');
    const httpSess = mockHttp([
        { status: 200, headers: { 'mcp-session-id': 'ABC' }, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, result: initRes }), contentType: 'application/json' },
        { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }), contentType: 'application/json' }
    ]);
    const t2 = createMcpTransport({ httpRequest: httpSess, supportedVersions: ['2025-06-18'], requireSession: true });
    await t2.setup(null);
    assert.equal(t2.sessionId(), 'ABC');
    assert.equal(httpSess.calls[1].headers['Mcp-Session-Id'], 'ABC');
});

test('M11 stateless setup sends no session and needs none', async () => {
    const initRes = { protocolVersion: '2026-07-28', capabilities: {} };
    const http = mockHttp(okJson(initRes, {}));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], stateless: true });
    await t.setup(null);
    assert.equal(t.sessionId(), null);
});

test('M12 server/discover called only when advertised', async () => {
    const initRes = { protocolVersion: '2026-07-28', capabilities: { discover: true } };
    const discRes = { capabilities: { tools: true } };
    const http = mockHttp([
        { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 1, result: initRes }), contentType: 'application/json' },
        { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 2, result: discRes }), contentType: 'application/json' }
    ]);
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], stateless: true });
    await t.setup(null);
    assert.equal(http.calls.length, 2);
    assert.ok(JSON.stringify(http.calls[1].body).includes('server/discover'));
    const http2 = mockHttp(okJson({ protocolVersion: '2026-07-28', capabilities: {} }, {}));
    const t2 = createMcpTransport({ httpRequest: http2, supportedVersions: ['2026-07-28'], stateless: true });
    await t2.setup(null);
    assert.equal(http2.calls.length, 1);
});
