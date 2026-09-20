// ai/marketData/authProvider.js — authentication providers.
// Transport receives getAccessToken() only; storage details stay inside.
// createAuthStub: legacy no-auth behavior (unchanged). createOAuthProvider:
// TokenStore-backed provider with bounded single refresh.
let tokenMod = null;
try { tokenMod = require('./oauth/oauthToken.js'); } catch (e) {}
try { if (!tokenMod) tokenMod = require('./marketData/oauth/oauthToken.js'); } catch (e) {}
try { if (!tokenMod) tokenMod = require('ai/marketData/oauth/oauthToken.js'); } catch (e) {}
let pkceMod = null;
try { pkceMod = require('./oauth/oauthPkce.js'); } catch (e) {}
try { if (!pkceMod) pkceMod = require('./marketData/oauth/oauthPkce.js'); } catch (e) {}
try { if (!pkceMod) pkceMod = require('ai/marketData/oauth/oauthPkce.js'); } catch (e) {}
let flowMod = null;
try { flowMod = require('./oauth/oauthBrowserFlow.js'); } catch (e) {}
try { if (!flowMod) flowMod = require('./marketData/oauth/oauthBrowserFlow.js'); } catch (e) {}
try { if (!flowMod) flowMod = require('ai/marketData/oauth/oauthBrowserFlow.js'); } catch (e) {}
let loopbackMod = null;
try { loopbackMod = require('./oauth/oauthLoopback.js'); } catch (e) {}
try { if (!loopbackMod) loopbackMod = require('./marketData/oauth/oauthLoopback.js'); } catch (e) {}
try { if (!loopbackMod) loopbackMod = require('ai/marketData/oauth/oauthLoopback.js'); } catch (e) {}

function createAuthStub() {
    function getAccessToken() { return Promise.resolve(null); }
    function getAuthStatus() { return 'missing'; }
    function beginAuthorization() {
        return Promise.resolve({ code: 'auth_unavailable', message: 'TradingView OAuth browser flow not yet wired (DCR unverified)' });
    }
    function refreshAccessToken() {
        return Promise.resolve({ code: 'auth_unavailable', message: 'TradingView OAuth refresh not yet wired (DCR unverified)' });
    }
    return { getAccessToken, getAuthStatus, beginAuthorization, refreshAccessToken };
}

function createOAuthProvider(opts) {
    opts = opts || {};
    const store = opts.tokenStore || null;
    const discovery = opts.discovery || null;
    const clientId = opts.clientId || null;
    const httpPostJson = opts.httpPostJson || null;
    const defaultScope = opts.scope || null;
    const skewMs = typeof opts.expirySkewMs === 'number' ? opts.expirySkewMs : 60000;
    if (!store || typeof store.load !== 'function') {
        throw Object.assign(new Error('OAuth provider requires a TokenStore'), { code: 'storage_unavailable' });
    }
    let refreshing = null;
    // Active authorization transaction (single at a time): { receiver, promise }.
    let activeAuth = null;
    let lastAuthorizeUrl = null;

    async function _record() {
        try { return await store.load(); } catch (e) { return null; }
    }
    function _live(rec) {
        if (!rec || !rec.accessToken) return false;
        if (rec.expiresAt == null) return true;
        return (rec.expiresAt - skewMs) > Date.now();
    }
    async function getAccessToken() {
        const rec = await _record();
        if (!rec || !rec.accessToken) return null;
        if (_live(rec)) return rec.accessToken;
        const out = await refreshAccessToken().catch(() => null);
        if (out && out.accessToken) return out.accessToken;
        return rec.accessToken;
    }
    function getAuthStatus() {
        return _record().then((rec) => {
            if (!rec || !rec.accessToken) return 'missing';
            return _live(rec) ? 'authenticated' : 'authentication_expired';
        }).catch(() => 'authentication_failed');
    }
    // Production authorization: PKCE + loopback + browser + exchange + save.
    // All collaborators injected via authOpts (test) or provider opts (prod).
    // Nothing here touches the network directly except through injected fns.
    function beginAuthorization(authOpts) {
        authOpts = authOpts || {};
        if (activeAuth) {
            return Promise.reject(Object.assign(new Error('Authorization already in progress'), { code: 'oauth_callback_failed' }));
        }
        const disc = authOpts.discovery || discovery;
        const cid = authOpts.clientId || clientId;
        const scope = authOpts.scope || defaultScope || 'mcp:read';
        const ports = Array.isArray(authOpts.ports) ? authOpts.ports : (Array.isArray(opts.ports) ? opts.ports : [18080, 18081, 18082]);
        const cbPath = authOpts.path || opts.callbackPath || '/callback';
        const timeoutMs = typeof authOpts.timeoutMs === 'number' ? authOpts.timeoutMs : (typeof opts.authTimeoutMs === 'number' ? opts.authTimeoutMs : 120000);
        const createListener = authOpts.createListener || opts.createListener || (loopbackMod && loopbackMod.createNodeListener);
        const openBrowser = authOpts.openBrowser || opts.openBrowser || null;
        const exchange = authOpts.exchange || opts.exchange || null;
        if (!disc || !disc.authorizationEndpoint) {
            return Promise.reject(Object.assign(new Error('Authorization endpoint undiscovered'), { code: 'oauth_discovery_failed' }));
        }
        if (!cid) {
            return Promise.reject(Object.assign(new Error('OAuth client not registered'), { code: 'oauth_registration_failed' }));
        }
        if (!pkceMod || !flowMod || !loopbackMod) {
            return Promise.reject(Object.assign(new Error('OAuth flow modules unavailable'), { code: 'oauth_callback_failed' }));
        }
        const promise = (async () => {
            const verifier = pkceMod.newCodeVerifier();
            const challenge = await pkceMod.codeChallengeS256(verifier);
            const state = pkceMod.newState();
            const receiver = loopbackMod.createLoopbackReceiver({ createListener, ports, path: cbPath, state, timeoutMs });
            activeAuth = { receiver };
            let redirectUri = null;
            try {
                const info = await receiver.start();
                redirectUri = info.url;
                const url = flowMod.buildAuthorizationUrl({
                    authorizationEndpoint: disc.authorizationEndpoint,
                    clientId: cid,
                    redirectUri,
                    scope,
                    state,
                    codeChallenge: challenge
                });
                lastAuthorizeUrl = url;
                if (typeof openBrowser === 'function') {
                    try { await openBrowser(url); } catch (e) {
                        throw Object.assign(new Error('Browser launch failed'), { code: 'oauth_callback_failed' });
                    }
                }
                const cb = await receiver.waitForCallback();
                const doExchange = exchange || (async () => {
                    if (!disc.tokenEndpoint || !tokenMod || typeof tokenMod.exchangeCode !== 'function' || typeof (authOpts.httpPostJson || opts.httpPostJson) !== 'function') {
                        throw Object.assign(new Error('Token exchange unavailable'), { code: 'oauth_token_failed' });
                    }
                    return tokenMod.exchangeCode({
                        tokenEndpoint: disc.tokenEndpoint,
                        clientId: cid,
                        code: cb.code,
                        codeVerifier: verifier,
                        redirectUri,
                        httpPostJson: authOpts.httpPostJson || opts.httpPostJson
                    });
                });
                const t = await doExchange();
                if (!t || !t.accessToken) {
                    throw Object.assign(new Error('Token response missing access_token'), { code: 'oauth_token_failed' });
                }
                const record = {
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken || null,
                    expiresAt: t.expiresAt != null ? t.expiresAt : null,
                    clientId: cid
                };
                if (typeof store.save === 'function') {
                    try { await store.save(record); } catch (e) {
                        throw Object.assign(new Error('Token storage failed'), { code: 'storage_unavailable' });
                    }
                }
                return { code: 'auth_success' };
            } finally {
                activeAuth = null;
            }
        })();
        // Attach receiver for cancelAuthorization even before start resolves.
        promise._receiver = () => (activeAuth && activeAuth.receiver) || null;
        return promise;
    }
    async function cancelAuthorization() {
        const recv = activeAuth && activeAuth.receiver;
        if (!recv) return;
        try { await recv.cancel(); } catch (e) {}
    }
    function __lastAuthorizeUrl() { return lastAuthorizeUrl; }
    async function refreshAccessToken() {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            try {
                const rec = await _record();
                if (!rec || !rec.refreshToken) {
                    throw Object.assign(new Error('No refresh token available'), { code: 'auth_unavailable' });
                }
                if (!discovery || !discovery.tokenEndpoint) {
                    throw Object.assign(new Error('Token endpoint undiscovered'), { code: 'oauth_discovery_failed' });
                }
                if (typeof httpPostJson !== 'function' || !tokenMod || typeof tokenMod.refreshToken !== 'function') {
                    throw Object.assign(new Error('Refresh transport unavailable'), { code: 'oauth_token_failed' });
                }
                const t = await tokenMod.refreshToken({
                    tokenEndpoint: discovery.tokenEndpoint,
                    clientId: clientId || (rec && rec.clientId),
                    refreshToken: rec.refreshToken,
                    httpPostJson
                });
                const next = {
                    accessToken: t.accessToken,
                    refreshToken: t.refreshToken || rec.refreshToken,
                    expiresAt: t.expiresAt,
                    clientId: clientId || (rec && rec.clientId) || null
                };
                if (typeof store.save === 'function') {
                    try { await store.save(next); } catch (e) {}
                }
                return next;
            } finally {
                refreshing = null;
            }
        })();
        return refreshing;
    }
    return { getAccessToken, getAuthStatus, beginAuthorization, cancelAuthorization, __lastAuthorizeUrl, refreshAccessToken };
}

module.exports = { createAuthStub, createOAuthProvider };
