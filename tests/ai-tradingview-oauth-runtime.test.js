// tests/ai-tradingview-oauth-runtime.test.js — Secret backend + loopback (fake values only)
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createGjsSecretBackend } = require('../ai/marketData/oauth/oauthSecretBackend.js');
const { createSecretTokenStore } = require('../ai/marketData/oauth/oauthTokenStore.js');
const { createLoopbackReceiver, createNodeListener } = require('../ai/marketData/oauth/oauthLoopback.js');

// GJS-style Secret mock (callback API like gi.repository.Secret)
function mockSecret() {
    const vault = {};
    const key = (attrs) => JSON.stringify(attrs || {});
    return {
        __vault: vault,
        Schema: { new: () => ({}) },
        password_store: (schema, attrs, coll, label, value, canc, cb) => {
            vault[key(attrs)] = String(value);
            setImmediate(() => cb(null, true));
        },
        password_store_finish: () => true,
        password_lookup: (schema, attrs, canc, cb) => {
            setImmediate(() => cb(null, true));
        },
        password_lookup_finish: (res) => {
            void res;
            return null;
        },
        password_clear: (schema, attrs, canc, cb) => {
            delete vault[key(attrs)];
            setImmediate(() => cb(null, true));
        },
        password_clear_finish: () => true
    };
}
// Lookup must return stored value: wrap mock to echo vault on finish.
function mockSecretEcho() {
    const m = mockSecret();
    let lastAttrs = null;
    const origLookup = m.password_lookup;
    m.password_lookup = (schema, attrs, canc, cb) => { lastAttrs = attrs; origLookup(schema, attrs, canc, cb); };
    m.password_lookup_finish = () => {
        const k = JSON.stringify(lastAttrs || {});
        return Object.prototype.hasOwnProperty.call(m.__vault, k) ? m.__vault[k] : null;
    };
    return m;
}

test('S1 secret backend save/load/clear roundtrip', async () => {
    const backend = createGjsSecretBackend({ Secret: mockSecretEcho(), service: 'qs-test' });
    const store = createSecretTokenStore(backend);
    assert.equal(await store.hasToken(), false);
    await store.save({ accessToken: 'FAKE-AT', refreshToken: 'FAKE-RT', expiresAt: 123, clientId: 'FAKE-C' });
    assert.equal(await store.hasToken(), true);
    const rec = await store.load();
    assert.equal(rec.accessToken, 'FAKE-AT');
    assert.equal(rec.clientId, 'FAKE-C');
    await store.clear();
    assert.equal(await store.hasToken(), false);
});

test('S2 secret backend unavailable fails closed, no plaintext', async () => {
    assert.throws(() => createGjsSecretBackend({ Secret: null }), (e) => e && e.code === 'storage_unavailable');
    const broken = { password_store: null };
    assert.throws(() => createGjsSecretBackend({ Secret: broken }), (e) => e && e.code === 'storage_unavailable');
    const { createSecretTokenStore: mk } = require('../ai/marketData/oauth/oauthTokenStore.js');
    assert.throws(() => mk(null), (e) => e && e.code === 'storage_unavailable');
});

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });
}

test('L1 receiver binds loopback, exposes callback URL', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 2000 });
    const info = await r.start();
    assert.ok(info.port > 0, 'ephemeral port assigned by node listener');
    assert.ok(info.url.indexOf('127.0.0.1') >= 0, 'loopback only');
    assert.ok(info.url.endsWith('/callback'), 'callback path');
    await r.cancel().catch(() => {});
});

test('L2 valid callback resolves code and shuts down', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 2000 });
    const info = await r.start();
    const pending = r.waitForCallback();
    const resp = await get(info.port, '/callback?code=FAKE_AUTH_CODE&state=FAKE-STATE');
    assert.equal(resp.status, 200);
    const out = await pending;
    assert.equal(out.code, 'FAKE_AUTH_CODE');
    await assert.rejects(r.waitForCallback(), (e) => e && (e.code === 'oauth_receiver_closed' || e.code === 'oauth_callback_failed'));
});

test('L3 invalid state rejected, missing code rejected, oauth error rejected', async () => {
    for (const path of [
        '/callback?code=FAKE_AUTH_CODE&state=WRONG_STATE',
        '/callback?state=FAKE-STATE',
        '/callback?error=access_denied&state=FAKE-STATE',
        '/callback'
    ]) {
        const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 2000 });
        const info = await r.start();
        const pending = r.waitForCallback();
        pending.catch(() => {});
        await get(info.port, path);
        await assert.rejects(pending, (e) => e && (e.code === 'oauth_state_mismatch' || e.code === 'oauth_callback_failed'), path);
        await r.cancel().catch(() => {});
    }
});

test('L3b non-callback path ignored, transaction stays pending until timeout', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 120 });
    const info = await r.start();
    const pending = r.waitForCallback();
    const resp = await get(info.port, '/other?code=X&state=FAKE-STATE');
    assert.equal(resp.status, 404);
    await assert.rejects(pending, (e) => e && e.code === 'oauth_callback_timeout');
});

test('L4 second callback after completion unavailable', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 2000 });
    const info = await r.start();
    const pending = r.waitForCallback();
    pending.catch(() => {});
    await get(info.port, '/callback?code=FAKE_AUTH_CODE&state=FAKE-STATE');
    await pending;
    let closed = false;
    try {
        const resp = await get(info.port, '/callback?code=X&state=FAKE-STATE');
        closed = resp.status === 410;
    } catch (e) {
        closed = true;
    }
    assert.equal(closed, true, 'second callback refused (410 or connection refused)');
});

test('L5 timeout rejects and cleans up listener', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 60 });
    await r.start();
    await assert.rejects(r.waitForCallback(), (e) => e && e.code === 'oauth_callback_timeout');
});

test('L6 cancel rejects pending and cleans up', async () => {
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 5000 });
    const info = await r.start();
    const pending = r.waitForCallback();
    await r.cancel();
    await assert.rejects(pending, (e) => e && e.code === 'oauth_callback_cancelled');
    await assert.rejects(get(info.port, '/callback?code=X&state=FAKE-STATE'), () => true, 'listener closed after cancel');
});

test('L7 port conflict tries next configured port', async () => {
    const blocker = http.createServer((req, res) => res.end('x'));
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = blocker.address().port;
    const r = createLoopbackReceiver({ createListener: createNodeListener, ports: [taken, 0], path: '/callback', state: 'FAKE-STATE', timeoutMs: 2000 });
    const info = await r.start();
    assert.notEqual(info.port, taken, 'conflicting port skipped');
    await r.cancel().catch(() => {});
    blocker.close();
});
