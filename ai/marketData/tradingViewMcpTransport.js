// ai/marketData/tradingViewMcpTransport.js — MCP Streamable HTTP transport.
// Injected httpRequest({url,method,headers,body,timeoutMs}, cancellable) ->
// Promise<{status,headers,bodyText,contentType}>. No npm SDK, no Soup import,
// no webSearchTool reuse (GET-only). Capability/protocol driven, fail closed.
let sseParserMod = null;
try { sseParserMod = require('./sseParser.js'); } catch (e) {}
try { if (!sseParserMod) sseParserMod = require('./marketData/sseParser.js'); } catch (e) {}
try { if (!sseParserMod) sseParserMod = require('ai/marketData/sseParser.js'); } catch (e) {}

const MCP_ENDPOINT = 'https://mcp.tradingview.com/mcp';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_INIT_TIMEOUT_MS = 30000;

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}
function _makeError(code, message, extra) {
    const e = new Error(String(message || code));
    e.code = code;
    if (extra && extra.status != null) { e.status = extra.status; e.httpStatus = extra.status; }
    if (extra && extra.retryAfter != null) e.retryAfter = extra.retryAfter;
    return e;
}
function _sanitize(s) {
    try {
        let t = String(s || '');
        t = t.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
        return t.slice(0, 300);
    } catch (e) { return ''; }
}
function _header(headers, name) {
    if (!headers || typeof headers !== 'object') return null;
    const low = String(name).toLowerCase();
    for (const k of Object.keys(headers)) {
        if (String(k).toLowerCase() === low) return headers[k];
    }
    return null;
}
function _parseSse(bodyText) {
    try {
        if (sseParserMod && typeof sseParserMod.parseSseFrames === 'function') return sseParserMod.parseSseFrames(bodyText);
    } catch (e) {}
    return [];
}
function _isSse(contentType) { return String(contentType || '').toLowerCase().indexOf('text/event-stream') >= 0; }

function createMcpTransport(opts) {
    opts = opts || {};
    const httpRequest = opts.httpRequest;
    if (typeof httpRequest !== 'function') throw new Error('McpTransport: httpRequest required');
    const endpoint = String(opts.endpoint || MCP_ENDPOINT);
    const supportedVersions = Array.isArray(opts.supportedVersions) && opts.supportedVersions.length
        ? opts.supportedVersions.slice() : ['2026-07-28', '2025-11-25', '2025-06-18'];
    const getAccessToken = typeof opts.getAccessToken === 'function' ? opts.getAccessToken : null;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const initTimeoutMs = typeof opts.initTimeoutMs === 'number' ? opts.initTimeoutMs : DEFAULT_INIT_TIMEOUT_MS;
    const stateless = !!opts.stateless;
    const requireSession = !!opts.requireSession;

    let seq = 0;
    let negotiatedVersion = null;
    let sessionId = null;
    let discovered = null;

    function sessionIdOf() { return sessionId; }
    function versionOf() { return negotiatedVersion; }
    function discoveryOf() { return discovered; }

    function _headers(extra) {
        const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
        if (sessionId) h['Mcp-Session-Id'] = sessionId;
        if (extra && typeof extra === 'object') {
            for (const k of Object.keys(extra)) h[k] = extra[k];
        }
        return h;
    }

    async function _post(method, params, cancellable, ms, versionOverride) {
        if (_isCancelled(cancellable)) throw _makeError('cancelled', 'cancelled');
        const id = ++seq;
        const body = { jsonrpc: '2.0', id, method };
        if (params !== undefined) body.params = params;
        if (versionOverride) body.params = Object.assign({}, body.params, { protocolVersion: versionOverride });
        let token = null;
        if (getAccessToken) {
            try { token = await getAccessToken(); } catch (e) { token = null; }
        }
        const headers = _headers();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const req = { url: endpoint, method: 'POST', headers, body: JSON.stringify(body), timeoutMs: ms || timeoutMs };
        let res = null;
        const raced = await Promise.race([
            Promise.resolve().then(() => httpRequest(req, cancellable)),
            new Promise((_, rej) => {
                const t = setTimeout(() => rej(_makeError('timeout', 'MCP request timeout')), req.timeoutMs);
                if (t && typeof t.unref === 'function') { try { t.unref(); } catch (e) {} }
            })
        ]).catch((e) => {
            if (e && e.code) throw e;
            throw _makeError('network_error', _sanitize(e && e.message) || 'MCP network error');
        });
        res = raced || null;
        if (_isCancelled(cancellable)) throw _makeError('cancelled', 'cancelled');
        return _handleResponse(res, id);
    }

    function _handleResponse(res, id) {
        const status = res && res.status != null ? res.status : 0;
        if (status === 401) throw _makeError('auth_expired', 'TradingView authentication required or expired', { status });
        if (status === 403) throw _makeError('auth_forbidden', 'TradingView access forbidden (plan/scope)', { status });
        if (status === 429) {
            const ra = res && res.headers ? _header(res.headers, 'retry-after') : null;
            throw _makeError('rate_limited', 'TradingView rate limited', { status, retryAfter: ra != null ? ra : undefined });
        }
        if (status !== 200) throw _makeError('network_error', 'MCP request failed (HTTP ' + status + ')', { status });
        const ct = (res && (res.contentType || _header(res.headers, 'content-type'))) || '';
        const text = res ? String(res.bodyText || '') : '';
        let frames = null;
        if (_isSse(ct)) {
            frames = _parseSse(text);
        } else {
            let obj = null;
            try { obj = JSON.parse(text); } catch (e) { throw _makeError('invalid_response', 'Malformed MCP response'); }
            frames = [obj && obj.method && obj.id == null ? { notification: true, method: obj.method, params: obj.params } : obj];
        }
        if (!Array.isArray(frames) || frames.length === 0) throw _makeError('invalid_response', 'Empty MCP response');
        for (const f of frames) {
            if (!f || f.notification) continue;
            if (f.id !== id) continue;
            if (f.error) {
                const msg = String((f.error && f.error.message) || 'MCP error');
                if (/-32601|method not found/i.test(msg)) throw _makeError('unsupported_tool', _sanitize(msg));
                if (/protocol version|protocolversion/i.test(msg)) throw _makeError('unsupported_protocol', _sanitize(msg));
                throw _makeError('invalid_response', _sanitize(msg));
            }
            if (f.result !== undefined) return f.result;
        }
        const errFrame = frames.filter((f) => f && !f.notification && f.error && f.id === id)[0];
        if (errFrame) throw _makeError('invalid_response', _sanitize(errFrame.error && errFrame.error.message));
        throw _makeError('invalid_response', 'MCP response without matching result');
    }

    async function call(method, params, cancellable, ms) {
        return _post(String(method), params || {}, cancellable, ms);
    }

    async function setup(cancellable) {
        sessionId = null;
        negotiatedVersion = null;
        discovered = null;
        let lastErr = null;
        for (const v of supportedVersions) {
            try {
                const res = await _post('initialize', {
                    protocolVersion: v,
                    capabilities: {},
                    clientInfo: { name: 'quicksearch', version: '1.0' }
                }, cancellable, initTimeoutMs, null);
                const serverV = res && (res.protocolVersion || (res.serverInfo && res.serverInfo.version)) || v;
                if (supportedVersions.indexOf(serverV) < 0) throw _makeError('unsupported_protocol', 'Unsupported MCP protocol version: ' + serverV);
                negotiatedVersion = serverV;
                return _afterInit(cancellable, res);
            } catch (e) {
                lastErr = e;
                if (e && (e.code === 'cancelled' || e.code === 'auth_expired' || e.code === 'auth_missing' || e.code === 'auth_forbidden' || e.code === 'timeout')) throw e;
                if (e && e.code === 'unsupported_protocol') {
                    if (supportedVersions.length === 1) throw e;
                    continue;
                }
                if (e && (e.code === 'network_error' || e.code === 'rate_limited')) throw e;
                continue;
            }
        }
        throw lastErr || _makeError('unsupported_protocol', 'No supported MCP protocol version');
    }

    async function _afterInit(cancellable, initRes) {
        if (stateless) {
            const wantsDiscover = !!(initRes && initRes.capabilities && initRes.capabilities.discover);
            if (!wantsDiscover) return { version: negotiatedVersion, stateless: true, discovered: null };
            try {
                const caps = await call('server/discover', {}, cancellable).catch(() => null);
                if (caps) discovered = caps;
                return { version: negotiatedVersion, stateless: true, discovered };
            } catch (e) {
                return { version: negotiatedVersion, stateless: true, discovered: null };
            }
        }
        return _legacyInit(cancellable);
    }

    async function _legacyInit(cancellable) {
        if (requireSession && !sessionId) {
            const sid = _lastSessionHeader();
            if (sid) sessionId = sid;
            if (!sessionId) throw _makeError('invalid_response', 'Session-based protocol requires Mcp-Session-Id but server provided none');
        }
        try { await call('notifications/initialized', {}, cancellable); } catch (e) {}
        if (!stateless) {
            try {
                const caps = await call('server/discover', {}, cancellable).catch(() => null);
                if (caps && caps !== null && typeof caps === 'object') {
                    discovered = caps;
                    return { version: negotiatedVersion, stateless: false, discovered };
                }
            } catch (e) {}
        }
        return { version: negotiatedVersion, stateless: false, discovered: null };
    }

    let _lastHeaders = null;
    const _origHandle = _handleResponse;
    _handleResponse = function (res, id) {
        try { _lastHeaders = (res && res.headers) || null; } catch (e) {}
        return _origHandle(res, id);
    };
    function _lastSessionHeader() {
        try { return _header(_lastHeaders, 'mcp-session-id'); } catch (e) { return null; }
    }

    function notifySession(headers) {
        const sid = _header(headers, 'mcp-session-id');
        if (sid) sessionId = String(sid);
    }

    return { call, setup, sessionId: sessionIdOf, version: versionOf, discovery: discoveryOf, notifySession, endpoint: () => endpoint };
}

module.exports = { createMcpTransport, MCP_ENDPOINT, DEFAULT_TIMEOUT_MS };
