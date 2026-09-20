// tests/ai-tradingview-oauth.test.js — OAuth foundation (mock-first, fake creds only)
const { test } = require('node:test');
const assert = require('node:assert');
const { discoverOAuth } = require('../ai/marketData/oauth/oauthDiscovery.js');
const { newCodeVerifier, codeChallengeS256, newState } = require('../ai/marketData/oauth/oauthPkce.js');
const { registerClient } = require('../ai/marketData/oauth/oauthClientRegistration.js');
const { buildAuthorizationUrl, parseCallback } = require('../ai/marketData/oauth/oauthBrowserFlow.js');
const { exchangeCode, refreshToken } = require('../ai/marketData/oauth/oauthToken.js');
const { createMemoryTokenStore } = require('../ai/marketData/oauth/oauthTokenStore.js');

const META = {
    issuer: 'https://www.tradingview.com',
    authorization_endpoint: 'https://www.tradingview.com/mcp/oauth/authorize',
    token_endpoint: 'https://www.tradingview.com/mcp/oauth/token',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:read', 'mcp:tools'],
    registration_endpoint: 'https://www.tradingview.com/mcp/oauth/register'
};
const okGet = (body, status) => async () => ({ status: status || 200, headers: {}, bodyText: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json' });
const okPost = (fn) => async (req) => fn(req);

test('O1 discovery success validates code+S256+endpoints', async () => {
    const d = await discoverOAuth({ issuer: 'https://www.tradingview.com', httpGetJson: okGet(META) });
    assert.equal(d.authorizationEndpoint, META.authorization_endpoint);
    assert.equal(d.tokenEndpoint, META.token_endpoint);
    assert.equal(d.registrationEndpoint, META.registration_endpoint);
    assert.ok(d.scopes.indexOf('mcp:read') >= 0);
});

test('O2 discovery fails closed: missing endpoint / PKCE / malformed', async () => {
    const noAuth = Object.assign({}, META);
    delete noAuth.authorization_endpoint;
    await assert.rejects(discoverOAuth({ issuer: 'https://x', httpGetJson: okGet(noAuth) }), (e) => e && e.code === 'oauth_discovery_failed');
    const noS256 = Object.assign({}, META, { code_challenge_methods_supported: ['plain'] });
    await assert.rejects(discoverOAuth({ issuer: 'https://x', httpGetJson: okGet(noS256) }), (e) => e && e.code === 'oauth_discovery_failed');
    await assert.rejects(discoverOAuth({ issuer: 'https://x', httpGetJson: okGet('not-json{{{') }), (e) => e && e.code === 'oauth_discovery_failed');
    await assert.rejects(discoverOAuth({ issuer: 'https://x', httpGetJson: async () => ({ status: 404, headers: {}, bodyText: '{}', contentType: 'application/json' }) }), (e) => e && e.code === 'oauth_discovery_failed');
});

test('O3 PKCE: verifier/challenge/state, mismatch rejected', async () => {
    const v = newCodeVerifier();
    assert.ok(/^[A-Za-z0-9\-_]{43,128}$/.test(v), 'verifier shape');
    const c = await codeChallengeS256(v);
    assert.ok(/^[A-Za-z0-9\-_]{43}$/.test(c), 'S256 challenge shape');
    const c2 = await codeChallengeS256(v);
    assert.equal(c, c2, 'deterministic');
    const s1 = newState();
    const s2 = newState();
    assert.ok(s1 !== s2, 'state unique');
    const { validateCallbackState } = require('../ai/marketData/oauth/oauthBrowserFlow.js');
    assert.equal(validateCallbackState(s1, s1), true);
    assert.equal(validateCallbackState(s1, s2), false);
    assert.equal(validateCallbackState(s1, ''), false);
});

test('O4 DCR verified shape + failure paths', async () => {
    const post = okPost(async (req) => {
        assert.equal(req.url, META.registration_endpoint);
        const body = JSON.parse(req.body);
        assert.ok(Array.isArray(body.redirect_uris) && body.redirect_uris.length, 'redirect_uris required');
        assert.equal(body.token_endpoint_auth_method, 'none');
        assert.ok(!('client_secret' in body), 'no secret invented');
        return { status: 200, headers: {}, bodyText: JSON.stringify({ client_id: 'FAKE-CLIENT-ID' }), contentType: 'application/json' };
    });
    const r = await registerClient({ discovery: { registrationEndpoint: META.registration_endpoint }, redirectUris: ['http://127.0.0.1:18080/callback'], httpPostJson: post });
    assert.equal(r.clientId, 'FAKE-CLIENT-ID');
    const bad = okPost(async () => ({ status: 400, headers: {}, bodyText: '{"error":"invalid_redirect_uri"}', contentType: 'application/json' }));
    await assert.rejects(registerClient({ discovery: { registrationEndpoint: META.registration_endpoint }, redirectUris: ['http://x/'], httpPostJson: bad }), (e) => e && e.code === 'oauth_registration_failed');
    const noid = okPost(async () => ({ status: 200, headers: {}, bodyText: '{}', contentType: 'application/json' }));
    await assert.rejects(registerClient({ discovery: { registrationEndpoint: META.registration_endpoint }, redirectUris: ['http://x/'], httpPostJson: noid }), (e) => e && e.code === 'oauth_registration_failed');
    await assert.rejects(registerClient({ discovery: {}, redirectUris: ['http://x/'], httpPostJson: post }), (e) => e && e.code === 'oauth_registration_failed');
});

test('O5 authorization URL carries state+PKCE+redirect', () => {
    const url = buildAuthorizationUrl({
        authorizationEndpoint: META.authorization_endpoint,
        clientId: 'FAKE-CLIENT',
        redirectUri: 'http://127.0.0.1:18080/callback',
        scope: 'mcp:read',
        state: 'FAKE-STATE',
        codeChallenge: 'FAKE-CHALLENGE'
    });
    assert.ok(url.indexOf('response_type=code') >= 0);
    assert.ok(url.indexOf('code_challenge=FAKE-CHALLENGE') >= 0);
    assert.ok(url.indexOf('code_challenge_method=S256') >= 0);
    assert.ok(url.indexOf('state=FAKE-STATE') >= 0);
    assert.ok(url.indexOf('redirect_uri=') >= 0);
    assert.ok(url.indexOf('client_id=FAKE-CLIENT') >= 0);
});

test('O6 callback: valid/invalid-state/missing-code/oauth-error', () => {
    const ok = parseCallback('http://127.0.0.1:18080/callback?code=FAKE-CODE&state=FAKE-STATE', 'FAKE-STATE');
    assert.equal(ok.code, 'FAKE-CODE');
    assert.throws(() => parseCallback('http://127.0.0.1:18080/callback?code=C&state=OTHER', 'FAKE-STATE'), (e) => e && e.code === 'oauth_state_mismatch');
    assert.throws(() => parseCallback('http://127.0.0.1:18080/callback?state=FAKE-STATE', 'FAKE-STATE'), (e) => e && e.code === 'oauth_callback_failed');
    assert.throws(() => parseCallback('http://127.0.0.1:18080/callback?error=access_denied&state=FAKE-STATE', 'FAKE-STATE'), (e) => e && e.code === 'oauth_callback_failed');
});

test('O7 token exchange parses, missing access_token fails', async () => {
    const post = okPost(async () => ({ status: 200, headers: {}, bodyText: JSON.stringify({ access_token: 'FAKE-AT', refresh_token: 'FAKE-RT', expires_in: 3600, token_type: 'Bearer' }), contentType: 'application/json' }));
    const t = await exchangeCode({ tokenEndpoint: META.token_endpoint, clientId: 'FAKE-C', code: 'FAKE-CODE', codeVerifier: 'FAKE-V', redirectUri: 'http://127.0.0.1:18080/callback', httpPostJson: post });
    assert.equal(t.accessToken, 'FAKE-AT');
    assert.equal(t.refreshToken, 'FAKE-RT');
    assert.ok(t.expiresAt > Date.now(), 'expiry computed');
    const noat = okPost(async () => ({ status: 200, headers: {}, bodyText: '{}', contentType: 'application/json' }));
    await assert.rejects(exchangeCode({ tokenEndpoint: META.token_endpoint, clientId: 'FAKE-C', code: 'C', codeVerifier: 'V', redirectUri: 'R', httpPostJson: noat }), (e) => e && e.code === 'oauth_token_failed');
});

test('O8 refresh success + failure, no infinite retry', async () => {
    const post = okPost(async () => ({ status: 200, headers: {}, bodyText: JSON.stringify({ access_token: 'FAKE-AT2', expires_in: 60 }), contentType: 'application/json' }));
    const t = await refreshToken({ tokenEndpoint: META.token_endpoint, clientId: 'FAKE-C', refreshToken: 'FAKE-RT', httpPostJson: post });
    assert.equal(t.accessToken, 'FAKE-AT2');
    const bad = okPost(async () => ({ status: 400, headers: {}, bodyText: '{"error":"invalid_grant"}', contentType: 'application/json' }));
    await assert.rejects(refreshToken({ tokenEndpoint: META.token_endpoint, clientId: 'FAKE-C', refreshToken: 'FAKE-RT', httpPostJson: bad }), (e) => e && e.code === 'oauth_token_failed');
});

test('O9 memory store save/load/clear, no plaintext file', async () => {
    const store = createMemoryTokenStore();
    assert.equal(await store.hasToken(), false);
    await store.save({ accessToken: 'FAKE-AT', refreshToken: 'FAKE-RT', expiresAt: Date.now() + 1000, clientId: 'FAKE-C' });
    assert.equal(await store.hasToken(), true);
    const loaded = await store.load();
    assert.equal(loaded.accessToken, 'FAKE-AT');
    await store.clear();
    assert.equal(await store.hasToken(), false);
});

test('O10 provider: live token, expired refreshes once, missing stays null', async () => {
    const { createOAuthProvider } = require('../ai/marketData/authProvider.js');
    const { createMemoryTokenStore } = require('../ai/marketData/oauth/oauthTokenStore.js');
    const store = createMemoryTokenStore();
    await store.save({ accessToken: 'FAKE-LIVE', refreshToken: 'FAKE-RT', expiresAt: Date.now() + 3600000, clientId: 'FAKE-C' });
    const p = createOAuthProvider({ tokenStore: store, discovery: { tokenEndpoint: 'https://x/token' }, clientId: 'FAKE-C', httpPostJson: async () => { throw new Error('must not refresh live token'); } });
    assert.equal(await p.getAccessToken(), 'FAKE-LIVE');
    assert.equal(await p.getAuthStatus(), 'authenticated');
    await store.save({ accessToken: 'FAKE-OLD', refreshToken: 'FAKE-RT', expiresAt: Date.now() - 1000, clientId: 'FAKE-C' });
    let posts = 0;
    const p2 = createOAuthProvider({ tokenStore: store, discovery: { tokenEndpoint: 'https://x/token' }, clientId: 'FAKE-C', httpPostJson: async () => { posts++; return { status: 200, headers: {}, bodyText: JSON.stringify({ access_token: 'FAKE-NEW', expires_in: 3600 }), contentType: 'application/json' }; } });
    assert.equal(await p2.getAccessToken(), 'FAKE-NEW');
    assert.equal(posts, 1, 'single bounded refresh');
    assert.equal(await p2.getAuthStatus(), 'authenticated');
    const empty = createMemoryTokenStore();
    const p3 = createOAuthProvider({ tokenStore: empty, discovery: { tokenEndpoint: 'https://x/token' }, clientId: 'FAKE-C', httpPostJson: async () => ({ status: 200, headers: {}, bodyText: '{}', contentType: 'application/json' }) });
    assert.equal(await p3.getAccessToken(), null);
});

test('O11 transport injects Authorization, redacts token, maps 401/403', async () => {
    const { createMcpTransport } = require('../ai/marketData/tradingViewMcpTransport.js');
    const seen = [];
    const http = async (req) => { seen.push(req); return { status: 401, headers: {}, bodyText: '{}', contentType: 'application/json' }; };
    const t = createMcpTransport({ httpRequest: http, supportedVersions: ['2025-06-18'], mode: 'legacy', getAccessToken: async () => 'FAKE-TOKEN-ABC' });
    await assert.rejects(t.call('tools/list', {}, null), (e) => e && (e.code === 'auth_expired' || e.code === 'auth_missing'));
    assert.equal(seen[0].headers.Authorization, 'Bearer FAKE-TOKEN-ABC');
    const http2 = async () => ({ status: 403, headers: {}, bodyText: 'x', contentType: 'text/plain' });
    const t2 = createMcpTransport({ httpRequest: http2, supportedVersions: ['2025-06-18'], mode: 'legacy', getAccessToken: async () => 'FAKE-TOKEN-ABC' });
    await assert.rejects(t2.call('tools/list', {}, null), (e) => e && e.code === 'auth_forbidden' && !String(e.message || '').includes('FAKE-TOKEN-ABC'));
});
