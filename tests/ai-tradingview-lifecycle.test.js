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
function methods(http) { return http.calls.filter((c) => String(c.method || 'POST') === 'POST').map((c) => { try { return JSON.parse(c.body).method; } catch (e) { return '?'; } }); }

test('L1 modern mode never sends legacy initialize', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern' });
    const info = await t.setup(null);
    assert.equal(info.mode, 'modern');
    assert.equal(info.version, '2026-07-28');
    assert.deepEqual(methods(http), [], 'zero handshake calls in modern setup');
    assert.equal(t.sessionId(), null);
});

test('L2 modern stateless needs no session id; calls carry version header, no session', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern' });
    await t.setup(null);
    await t.call('tools/list', {}, null);
    assert.equal(http.calls[0].headers['Mcp-Protocol-Version'], '2026-07-28');
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

test('L13 modern negotiates version from server metadata intersection', async () => {
    const http = mockHttp((req, n) => {
        if (String(req.method || 'POST') === 'GET') {
            return { status: 200, headers: {}, bodyText: JSON.stringify({ protocolVersions: ['2025-11-25'], discovery: null }), contentType: 'application/json' };
        }
        return rpcResult(n, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28', '2025-11-25'], modernVersions: ['2026-07-28', '2025-11-25'], mode: 'modern', metadataUrl: 'https://x.test/meta' });
    const info = await t.setup(null);
    assert.equal(info.version, '2025-11-25', 'server-advertised intersection wins, not cands[0]');
    assert.equal(http.calls[0].method, 'GET');
    assert.ok(!http.calls[0].headers['Mcp-Protocol-Version'], 'no version header pre-negotiation');
});

test('L14 modern fails closed when no mutually-supported version', async () => {
    const http = mockHttp((req) => {
        if (String(req.method || 'POST') === 'GET') {
            return { status: 200, headers: {}, bodyText: JSON.stringify({ protocolVersions: ['1999-01-01'] }), contentType: 'application/json' };
        }
        return rpcResult(1, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', metadataUrl: 'https://x.test/meta' });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'unsupported_protocol');
});

test('L15 modern metadata auth failure propagates, never treated as no-meta', async () => {
    const http = mockHttp((req) => {
        if (String(req.method || 'POST') === 'GET') return { status: 401, headers: {}, bodyText: '{}', contentType: 'application/json' };
        return rpcResult(1, {});
    });
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', metadataUrl: 'https://x.test/meta' });
    await assert.rejects(t.setup(null), (e) => e && (e.code === 'auth_expired' || e.code === 'auth_missing'));
});

test('L16 modern server/discover unavailable fails closed, no legacy retry', async () => {
    const http = mockHttp((req, n) => rpcError(n, -32601, 'Method not found'));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', discovery: 'server-discover' });
    await assert.rejects(t.setup(null), (e) => e && (e.code === 'unsupported_tool' || e.code === 'invalid_response'));
    assert.ok(methods(http).indexOf('initialize') < 0, 'no silent legacy fallback from modern mode');
});

test('L17 auto prefers modern metadata when advertised, legacy-only otherwise', async () => {
    const httpModern = mockHttp((req, n) => {
        if (String(req.method || 'POST') === 'GET') {
            return { status: 200, headers: {}, bodyText: JSON.stringify({ protocolVersions: ['2026-07-28'] }), contentType: 'application/json' };
        }
        return rpcResult(n, {});
    });
    const t = createMcpTransport({ httpRequest: httpModern, supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto', metadataUrl: 'https://x.test/meta' });
    const info = await t.setup(null);
    assert.equal(info.mode, 'modern');
    assert.ok(methods(httpModern).indexOf('initialize') < 0, 'no legacy probe when metadata proves modern');
    const httpLegacy = mockHttp((req) => {
        if (String(req.method || 'POST') === 'GET') return { status: 404, headers: {}, bodyText: '{}', contentType: 'application/json' };
        const body = JSON.parse(req.body);
        const m = body.method;
        const id = body.id;
        if (m === 'initialize') return rpcResult(id, { protocolVersion: '2025-06-18', capabilities: {} }, {});
        if (m === 'notifications/initialized') return { status: 202, headers: {}, bodyText: '', contentType: 'application/json' };
        return rpcResult(id, {});
    });
    const t2 = createMcpTransport({ httpRequest: httpLegacy, supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto', metadataUrl: 'https://x.test/meta' });
    const info2 = await t2.setup(null);
    assert.equal(info2.mode, 'legacy');
});

test('L18 modern never sends notifications/initialized', async () => {
    const http = mockHttp((req, n) => rpcResult(n, { tools: [] }));
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern', discovery: 'server-discover' });
    await t.setup(null).catch(() => {});
    const t2 = createMcpTransport({ httpRequest: http, supportedVersions: ['2026-07-28'], mode: 'modern' });
    await t2.setup(null);
    assert.ok(methods(http).indexOf('notifications/initialized') < 0, 'modern must never send initialized');
});

test('L19 403/network/timeout/429 never trigger protocol fallback', async () => {
    const mk = (resp) => mockHttp(() => resp);
    for (const [resp, code] of [
        [{ status: 403, headers: {}, bodyText: 'x', contentType: 'text/plain' }, 'auth_forbidden'],
        [{ status: 0, headers: {}, bodyText: '', contentType: '' }, 'network_error'],
        [{ status: 429, headers: {}, bodyText: 'x', contentType: 'text/plain' }, 'rate_limited']
    ]) {
        const t = createMcpTransport({ httpRequest: mk(resp), supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto' });
        await assert.rejects(t.setup(null), (e) => e && e.code === code, 'expected ' + code);
        assert.equal(mk(resp).calls.length, 0);
    }
    const hanging = () => new Promise(() => {});
    const t = createMcpTransport({ httpRequest: hanging, supportedVersions: ['2025-06-18', '2026-07-28'], mode: 'auto', timeoutMs: 15, initTimeoutMs: 15 });
    await assert.rejects(t.setup(null), (e) => e && e.code === 'timeout');
});
