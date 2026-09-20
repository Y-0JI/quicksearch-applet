// tests/ai-tradingview-oauth-authorize.test.js — production beginAuthorization (fake only)
const { test } = require('node:test');
const assert = require('node:assert');
const { createOAuthProvider } = require('../ai/marketData/authProvider.js');
const { createMemoryTokenStore } = require('../ai/marketData/oauth/oauthTokenStore.js');
const { createLoopbackReceiver, createNodeListener } = require('../ai/marketData/oauth/oauthLoopback.js');
const http = require('node:http');

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}
function mockDeps(over) {
    return Object.assign({
        discovery: { authorizationEndpoint: 'https://auth.test/authorize', tokenEndpoint: 'https://auth.test/token' },
        clientId: 'FAKE-CLIENT',
        scope: 'mcp:read',
        ports: [0],
        path: '/callback',
        timeoutMs: 3000,
        createListener: createNodeListener,
        openBrowser: async () => {},
        exchange: async () => ({ accessToken: 'FAKE-AT', refreshToken: 'FAKE-RT', expiresAt: Date.now() + 3600 })
    }, over || {});
}

test('P1 authorize builds URL with listener redirect, exchanges, saves', async () => {
    const store = createMemoryTokenStore();
    let opened = null;
    const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
    const flow = p.beginAuthorization(mockDeps({ openBrowser: async (url) => { opened = url; } }));
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(opened && opened.indexOf('response_type=code') >= 0, 'browser opened with authorize URL');
    const m = /redirect_uri=([^&]+)/.exec(opened);
    assert.ok(m, 'redirect_uri present');
    const redirect = decodeURIComponent(m[1]);
    const u = new URL(redirect);
    const st = /state=([^&]+)/.exec(opened)[1];
    const resp = await get(Number(u.port), u.pathname + '?code=FAKE_AUTH_CODE&state=' + st);
    assert.equal(resp.status, 200);
    const out = await flow;
    assert.equal(out.code, 'auth_success');
    assert.equal(await store.hasToken(), true);
    const rec = await store.load();
    assert.equal(rec.accessToken, 'FAKE-AT');
});

test('P2 invalid state rejects, nothing saved', async () => {
    const store = createMemoryTokenStore();
    let opened = null;
    const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
    const flow = p.beginAuthorization(mockDeps({ openBrowser: async (url) => { opened = url; } }));
    flow.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const u = new URL(decodeURIComponent(/redirect_uri=([^&]+)/.exec(opened)[1]));
    await get(Number(u.port), u.pathname + '?code=FAKE_AUTH_CODE&state=WRONG');
    await assert.rejects(flow, (e) => e && e.code === 'oauth_state_mismatch');
    assert.equal(await store.hasToken(), false);
});

test('P3 missing code and oauth error reject, nothing saved', async () => {
    for (const q of ['?state=S', '?error=access_denied&state=S']) {
        const store = createMemoryTokenStore();
        let opened = null;
        const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
        const flow = p.beginAuthorization(mockDeps({ openBrowser: async (url) => { opened = url; } }));
        flow.catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
        const st = /state=([^&]+)/.exec(opened)[1];
        const u = new URL(decodeURIComponent(/redirect_uri=([^&]+)/.exec(opened)[1]));
        await get(Number(u.port), u.pathname + q.replace('state=S', 'state=' + st));
        await assert.rejects(flow, (e) => e && (e.code === 'oauth_callback_failed' || e.code === 'oauth_state_mismatch'), q);
        assert.equal(await store.hasToken(), false);
    }
});

test('P4 timeout closes listener, rejects', async () => {
    const store = createMemoryTokenStore();
    const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
    await assert.rejects(
        p.beginAuthorization(mockDeps({ openBrowser: async () => {}, timeoutMs: 80 })),
        (e) => e && e.code === 'oauth_callback_timeout'
    );
    assert.equal(await store.hasToken(), false);
});

test('P5 cancel closes listener, rejects, nothing saved', async () => {
    const store = createMemoryTokenStore();
    const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
    const flow = p.beginAuthorization(mockDeps({ openBrowser: async () => {}, timeoutMs: 5000 }));
    flow.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await p.cancelAuthorization();
    await assert.rejects(flow, (e) => e && e.code === 'oauth_callback_cancelled');
    assert.equal(await store.hasToken(), false);
});

test('P6 exchange failure rejects, nothing saved', async () => {
    const store = createMemoryTokenStore();
    const p = createOAuthProvider({ tokenStore: store, discovery: mockDeps().discovery, clientId: 'FAKE-CLIENT' });
    const flow = p.beginAuthorization(mockDeps({
        openBrowser: async () => {},
        exchange: async () => { throw Object.assign(new Error('denied'), { code: 'oauth_token_failed' }); }
    }));
    flow.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    const opened = p.__lastAuthorizeUrl();
    const u = new URL(decodeURIComponent(/redirect_uri=([^&]+)/.exec(opened)[1]));
    const st = /state=([^&]+)/.exec(opened)[1];
    await get(Number(u.port), u.pathname + '?code=FAKE_AUTH_CODE&state=' + st);
    await assert.rejects(flow, (e) => e && e.code === 'oauth_token_failed');
    assert.equal(await store.hasToken(), false);
});

test('P7 GJS listener adapter satisfies loopback interface', async () => {
    const { createGjsListener } = require('../ai/marketData/oauth/oauthGjsListener.js');
    assert.equal(typeof createGjsListener, 'function');
    const r = createLoopbackReceiver({ createListener: createGjsListener({}), ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 3000 });
    void r;
});

test('P8 factory forwards listener/browser/ports/path/timeout to provider', async () => {
    const { createMarketDataFromConfig } = require('../ai/marketData/marketDataFactory.js');
    const { createMemoryTokenStore } = require('../ai/marketData/oauth/oauthTokenStore.js');
    const { createNodeListener } = require('../ai/marketData/oauth/oauthLoopback.js');
    const store = createMemoryTokenStore();
    let opened = null;
    const httpRequest = async (req) => {
        const body = JSON.parse(req.body);
        return { status: 200, headers: {}, bodyText: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), contentType: 'application/json' };
    };
    const { auth } = createMarketDataFromConfig({
        enabled: true,
        httpRequest,
        oauth: {
            tokenStore: store,
            discovery: { authorizationEndpoint: 'https://auth.test/authorize', tokenEndpoint: 'https://auth.test/token' },
            clientId: 'FAKE-CLIENT',
            createListener: createNodeListener,
            openBrowser: async (url) => { opened = url; },
            ports: [0],
            path: '/cb',
            timeoutMs: 3000,
            scope: 'mcp:read'
        }
    });
    assert.ok(auth && typeof auth.beginAuthorization === 'function', 'factory built OAuth provider');
    const flow = auth.beginAuthorization({
        exchange: async () => ({ accessToken: 'FAKE-AT', refreshToken: null, expiresAt: null })
    });
    flow.catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(opened, 'browser opened');
    const u = new URL(decodeURIComponent(/redirect_uri=([^&]+)/.exec(opened)[1]));
    assert.equal(u.pathname, '/cb', 'redirect path propagated');
    assert.ok(Number(u.port) > 0, 'listener port propagated');
    const st = /state=([^&]+)/.exec(opened)[1];
    const http2 = require('node:http');
    await new Promise((resolve, reject) => {
        http2.get({ host: '127.0.0.1', port: Number(u.port), path: u.pathname + '?code=FAKE_AUTH_CODE&state=' + st }, (res) => res.resume() && res.on('end', resolve)).on('error', reject);
    });
    const out = await flow;
    assert.equal(out.code, 'auth_success');
    assert.equal(await store.hasToken(), true);
});
