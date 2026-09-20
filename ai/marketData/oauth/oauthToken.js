// ai/marketData/oauth/oauthToken.js — code exchange + refresh. Secrets never logged.
function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
function _form(obj) {
    return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}
async function _postForm(httpPostJson, url, fields) {
    const res = await httpPostJson({ url, body: _form(fields), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const status = res && res.status != null ? res.status : 0;
    const text = res ? String(res.bodyText || res.body || '') : '';
    if (status < 200 || status >= 300) {
        throw _err('oauth_token_failed', 'Token endpoint rejected (HTTP ' + status + ')');
    }
    let obj = null;
    try { obj = JSON.parse(text); } catch (e) { throw _err('oauth_token_failed', 'Token response malformed'); }
    return obj;
}
function _normalizeToken(obj) {
    if (!obj || typeof obj.access_token !== 'string' || !obj.access_token) {
        throw _err('oauth_token_failed', 'Token response missing access_token');
    }
    const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : null;
    return {
        accessToken: obj.access_token,
        refreshToken: typeof obj.refresh_token === 'string' ? obj.refresh_token : null,
        expiresAt: expiresIn != null ? Date.now() + expiresIn * 1000 : null,
        tokenType: obj.token_type || 'Bearer'
    };
}
async function exchangeCode(opts) {
    opts = opts || {};
    if (typeof opts.httpPostJson !== 'function') throw _err('oauth_token_failed', 'Token transport required');
    const obj = await _postForm(opts.httpPostJson, opts.tokenEndpoint, {
        grant_type: 'authorization_code',
        client_id: opts.clientId || '',
        code: opts.code || '',
        code_verifier: opts.codeVerifier || '',
        redirect_uri: opts.redirectUri || ''
    });
    return _normalizeToken(obj);
}
async function refreshToken(opts) {
    opts = opts || {};
    if (typeof opts.httpPostJson !== 'function') throw _err('oauth_token_failed', 'Token transport required');
    if (!opts.refreshToken) throw _err('oauth_token_failed', 'No refresh token available');
    const obj = await _postForm(opts.httpPostJson, opts.tokenEndpoint, {
        grant_type: 'refresh_token',
        client_id: opts.clientId || '',
        refresh_token: opts.refreshToken
    });
    const out = _normalizeToken(obj);
    if (!out.refreshToken) out.refreshToken = opts.refreshToken;
    return out;
}
module.exports = { exchangeCode, refreshToken };
