// ai/marketData/oauth/oauthClientRegistration.js — DCR (RFC 7591), verified shape only.
function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
async function registerClient(opts) {
    opts = opts || {};
    const discovery = opts.discovery || {};
    const endpoint = discovery.registrationEndpoint || opts.registrationEndpoint;
    if (typeof endpoint !== 'string' || !endpoint) {
        throw _err('oauth_registration_failed', 'DCR registration endpoint unavailable');
    }
    const redirectUris = Array.isArray(opts.redirectUris) ? opts.redirectUris : [];
    if (!redirectUris.length) throw _err('oauth_registration_failed', 'DCR redirect_uris required');
    const httpPostJson = opts.httpPostJson;
    if (typeof httpPostJson !== 'function') throw _err('oauth_registration_failed', 'DCR transport required');
    const body = {
        redirect_uris: redirectUris.slice(),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'QuickSearch Cinnamon Applet',
        scope: opts.scope || 'mcp:read'
    };
    const res = await httpPostJson({ url: endpoint, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const status = res && res.status != null ? res.status : 0;
    const text = res ? String(res.bodyText || res.body || '') : '';
    if (status < 200 || status >= 300) {
        throw _err('oauth_registration_failed', 'DCR rejected (HTTP ' + status + '): ' + text.slice(0, 200));
    }
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { throw _err('oauth_registration_failed', 'DCR response malformed'); }
    if (!obj || typeof obj.client_id !== 'string' || !obj.client_id) {
        throw _err('oauth_registration_failed', 'DCR response missing client_id');
    }
    return { clientId: obj.client_id, raw: obj };
}
module.exports = { registerClient };
