// ai/marketData/oauth/oauthDiscovery.js — dynamic OAuth metadata discovery.
// Pure orchestration over injected httpGetJson. Fail closed.
function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
async function _getJson(httpGetJson, url) {
    const res = await httpGetJson(url);
    const status = res && res.status != null ? res.status : 0;
    if (status < 200 || status >= 300) throw _err('oauth_discovery_failed', 'OAuth metadata fetch failed (HTTP ' + status + ')');
    const text = res ? String(res.bodyText || res.body || '') : '';
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { throw _err('oauth_discovery_failed', 'OAuth metadata is not valid JSON'); }
    if (!obj || typeof obj !== 'object') throw _err('oauth_discovery_failed', 'OAuth metadata malformed');
    return obj;
}
async function discoverOAuth(opts) {
    opts = opts || {};
    const issuer = String(opts.issuer || 'https://www.tradingview.com').replace(/\/+$/, '');
    const httpGetJson = opts.httpGetJson;
    if (typeof httpGetJson !== 'function') throw _err('oauth_discovery_failed', 'OAuth discovery transport required');
    const meta = await _getJson(httpGetJson, issuer + '/.well-known/oauth-authorization-server');
    const authorizationEndpoint = meta.authorization_endpoint;
    const tokenEndpoint = meta.token_endpoint;
    if (typeof authorizationEndpoint !== 'string' || !authorizationEndpoint) {
        throw _err('oauth_discovery_failed', 'OAuth metadata missing authorization_endpoint');
    }
    if (typeof tokenEndpoint !== 'string' || !tokenEndpoint) {
        throw _err('oauth_discovery_failed', 'OAuth metadata missing token_endpoint');
    }
    const responses = Array.isArray(meta.response_types_supported) ? meta.response_types_supported : [];
    if (responses.length && responses.indexOf('code') < 0) {
        throw _err('oauth_discovery_failed', 'OAuth authorization code flow unsupported');
    }
    const challenges = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : [];
    if (challenges.length && challenges.indexOf('S256') < 0) {
        throw _err('oauth_discovery_failed', 'OAuth PKCE S256 unsupported');
    }
    return {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : null,
        jwksUri: typeof meta.jwks_uri === 'string' ? meta.jwks_uri : null,
        revocationEndpoint: typeof meta.revocation_endpoint === 'string' ? meta.revocation_endpoint : null,
        responseTypes: responses.slice(),
        grantTypes: Array.isArray(meta.grant_types_supported) ? meta.grant_types_supported.slice() : [],
        authMethods: Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported.slice() : [],
        challengeMethods: challenges.slice(),
        scopes: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.slice() : []
    };
}
module.exports = { discoverOAuth };
