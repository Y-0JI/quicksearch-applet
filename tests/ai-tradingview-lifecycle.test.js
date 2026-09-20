// tests/ai-tradingview-lifecycle.test.js — P0/P1: explicit legacy vs modern lifecycle
const { test } = require('node:test');
const assert = require('node:assert');
const { createMcpTransport } = require('../ai/marketData/tradingViewMcpTransport.js');

function rpcResult(id, result, headers) { return { status: 200, headers: headers || {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id, result }), contentType: 'application/json' }; }
function rpcError(id, code, message) { return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), contentType: 'application/json' }; }
function mockHttp(handler) {
    const calls = [];
    let i = 0;
    const fn = (req) => { calls.push(req); i++; return Promise.resolve(handler(req, i)); };
    fn.calls = calls;
    return fn;
}
function methods(http) { return http.calls.map((c) => { try { return JSON.parse(c.body).method; } catch (e) { return '?'; } }); }

test('L1 modern mode never sends legacy initialize', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern' });
    const info = await t.setup(null);
    assert.equal(info.mode, 'modern');
    assert.equal(info.version, '2026-07-28');
    assert.deepEqual(methods(http), [], 'zero handshake calls in modern setup');
    assert.equal(t.sessionId(), null);
});

test('L2 modern stateless needs no session id; tools/list works without it', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern' });
    await t.setup(null);
    const res = await t.call('tools/list', {}, null);
    assert.deepEqual(res, { tools: [] });
    assert.ok(!http.calls[0].headers['Mcp-Session-Id'], 'no session header sent');
});

test('L3 legacy performs initialize + initialized, captures session', async () => {
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (m === 'initialize') return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} }, { 'mcp-session-id': 'SID1' });
        if (m === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '', contentType: 'application/json' };
        return rpcResult(n, { tools: [] });
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy', requireSession: true });
    const info = await t.setup(null);
    assert.equal(info.mode, 'legacy');
    assert.deepEqual(methods(http), ['initialize', 'notifications/initialized']);
    assert.equal(t.sessionId(), 'SID1');
});

test('L4 legacy missing required session id fails invalid_response', async () => {
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (m === 'initialize') return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} }, {});
        return rpcResult(n, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy', requireSession: true });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'invalid_response');
});

test('L5 legacy never calls server/discover', async () => {
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (m === 'initialize') return rpcResult(n, { protocolVersion: '2025-06-18', capabilities: {} }, {});
        if (m === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '', contentType: 'application/json' };
        return rpcResult(n, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy' });
    await t.setup(null);
    assert.ok(methods(http).indexOf('server/discover') < 0, 'no discover on legacy path');
});

test('L6 modern calls server/discover only when explicitly configured', async () => {
    const http = mockHttp((req, n) => {
        const m = JSON.parse(req.body).method;
        if (m === 'server/discover') return rpcResult(n, { capabilities: { tools: true } });
        return rpcResult(n, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', discovery: 'server-discover' });
    const info = await t.setup(null);
    assert.deepEqual(methods(http), ['server/discover']);
    assert.deepEqual(info.discovered, { capabilities: { tools: true } });
    const http2 = mockHttp((req, n) => rpcResult(n, {}));
    const t2 = createMcpTransport({ httpRequest: http2, supportedVersions: ['2026-07-28'], mode: 'modern' });
    await t2.setup(null);
    assert.deepEqual(methods(http2), [], 'no discover unless configured');
});

test('L7 unsupported protocol version fails closed', async () => {
    const http = mockHttp((req, n) => rpcError(n, -32600, 'Unsupported protocol version 2025-06-18'));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy' });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'unsupported_protocol');
});

test('L8 protocol mismatch (server answers different version) is not success', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { protocolVersion: '1999-01-01', capabilities: {} }, {}));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy' });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'unsupported_protocol');
});

test('L9 legacy mode with only modern versions configured fails closed', async () => {
    const http = mockHttp((req, n) => rpcResult(n, {}, {}));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'legacy' });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'unsupported_protocol');
    assert.deepEqual(methods(http), [], 'no handshake attempted without legacy candidate');
});

test('L10 modern mode with requireSession fails explicitly', async () => {
    const http = mockHttp((req, n) => rpcResult(n, {}, {}));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', requireSession: true });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'invalid_response');
});

test('L11 auto mode falls back explicitly only on defined condition', async () => {
    const http = mockHttp((req, n) => {
        const body = JSON.parse(req.body);
        if (body.method === 'initialize') return rpcError(n, -32601, 'Method not found');
        return rpcResult(n, {}, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto' });
    const info = await t.setup(null);
    assert.equal(info.mode, 'modern');
    assert.equal(info.fallback, 'legacy-initialize-unavailable');
});

test('L12 auto mode does not swallow auth errors as version mismatch', async () => {
    const http = mockHttp(() => ({ status: 401, headers: {}, bodyText: '{}', contentType: 'application/json' }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto' });
    await assert.rejects(t.setup(null), (e) => e && (e.code === 'auth_expired' || e.code === 'auth_missing'));
    assert.equal(http.calls.length, 1, 'fail closed on first auth error, no silent retry storm');
});
