// ai/marketData/oauth/oauthBrowserFlow.js — authorize URL + callback parsing. No I/O.
function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
function buildAuthorizationUrl(opts) {
    opts = opts || {};
    const base = String(opts.authorizationEndpoint || '');
    if (!base) throw _err('oauth_callback_failed', 'Authorization endpoint required');
    const q = [
        'response_type=code',
        'client_id=' + encodeURIComponent(opts.clientId || ''),
        'redirect_uri=' + encodeURIComponent(opts.redirectUri || ''),
        'scope=' + encodeURIComponent(opts.scope || 'mcp:read'),
        'state=' + encodeURIComponent(opts.state || ''),
        'code_challenge=' + encodeURIComponent(opts.codeChallenge || ''),
        'code_challenge_method=S256'
    ];
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + q.join('&');
}
function validateCallbackState(expected, actual) {
    if (typeof expected !== 'string' || !expected) return false;
    if (typeof actual !== 'string' || !actual) return false;
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    return diff === 0;
}
function _queryParams(url) {
    const out = {};
    try {
        const s = String(url || '');
        const qi = s.indexOf('?');
        if (qi < 0) return out;
        const hash = s.indexOf('#', qi);
        const qs = s.slice(qi + 1, hash >= 0 ? hash : s.length);
        for (const pair of qs.split('&')) {
            const eq = pair.indexOf('=');
            if (eq < 0) continue;
            out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
        }
    } catch (e) {}
    return out;
}
function parseCallback(url, expectedState) {
    const p = _queryParams(url);
    if (p.error) throw _err('oauth_callback_failed', 'OAuth authorization refused: ' + String(p.error).slice(0, 120));
    if (!validateCallbackState(expectedState, p.state)) throw _err('oauth_state_mismatch', 'OAuth state mismatch');
    if (typeof p.code !== 'string' || !p.code) throw _err('oauth_callback_failed', 'OAuth callback missing code');
    return { code: p.code, state: p.state };
}
module.exports = { buildAuthorizationUrl, validateCallbackState, parseCallback };
