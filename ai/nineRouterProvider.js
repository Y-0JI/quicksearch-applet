// ai/nineRouterProvider.js — OpenAI-compatible non-streaming transport to 9router.
// Behind AIProvider contract. No UI, no tool registry, no shell.
// ponytail: non-streaming only. Upgrade to streaming via `stream: true` + chunk parsing when UI needs it.
let Gio = null, GLib = null, Soup = null;
try { Gio = require('gi.Gio'); } catch (e) {}
try { GLib = require('gi.GLib'); } catch (e) {}
try { Soup = require('gi.Soup'); } catch (e) {}

const DEFAULT_TIMEOUT_MS = 15000;

function _scheduleTimeout(ms, fn) {
    if (GLib && typeof GLib.timeout_add === 'function') {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { fn(); return GLib.SOURCE_REMOVE; });
    }
    return setTimeout(fn, ms);
}
function _cancelTimeout(id) {
    if (!id) return;
    if (GLib && typeof GLib.source_remove === 'function') {
        try { GLib.source_remove(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} }
    } else try { clearTimeout(id); } catch (e) {}
}
function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function buildChatCompletionsUrl(baseUrl) {
    let raw = String(baseUrl || '').trim();
    if (!raw) throw new Error('baseUrl required');
    raw = raw.replace(/\/+$/, '');
    if (raw.endsWith('/v1')) raw = raw.slice(0, -3);
    // after stripping /v1, there may be trailing slash left e.g. "http://x/v1/" already trimmed but double-case
    raw = raw.replace(/\/+$/, '');
    return raw + '/v1/chat/completions';
}

function buildRequestBody(model, systemPrompt, userContent) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(userContent || '') });
    return JSON.stringify({ model: String(model), messages, stream: false });
}

function parseResponseText(text, status) {
    // status already checked for non-2xx before calling; but handle error payload shape
    let data;
    try { data = JSON.parse(text); } catch (e) {
        const err = new Error('Invalid AI response');
        err.code = 'invalid_response';
        throw err;
    }
    // provider error payload even on 2xx?
    if (data && typeof data === 'object' && data.error) {
        const err = new Error('AI provider error');
        // let caller map by status; here we treat as provider_error unless status says otherwise
        err.code = 'provider_error';
        err._status = status;
        throw err;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.choices) || data.choices.length === 0) {
        const err = new Error('Invalid AI response');
        err.code = 'invalid_response';
        throw err;
    }
    const choice = data.choices[0];
    if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
        const err = new Error('Invalid AI response');
        err.code = 'invalid_response';
        throw err;
    }
    const content = choice.message.content;
    if (typeof content !== 'string') {
        const err = new Error('Invalid AI response');
        err.code = 'invalid_response';
        throw err;
    }
    // empty string is valid answer (test expects distinct handling but still answer)
    return { type: 'answer', text: content };
}

function httpStatusToCode(status) {
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
}

function createDefaultHttpFetch() {
    // Cinnamon Soup-based fetch
    if (Soup && GLib) {
        let session = null;
        function ensureSession() {
            if (!session) {
                session = new Soup.Session();
                session.timeout = 30;
            }
            return session;
        }
        return function soupFetch(url, opts) {
            return new Promise((resolve, reject) => {
                try {
                    const s = ensureSession();
                    const msg = Soup.Message.new('POST', url);
                    if (!msg) return reject(new Error('bad url'));
                    const headers = opts.headers || {};
                    for (const k in headers) {
                        try { msg.request_headers.append(k, headers[k]); } catch (e) {}
                    }
                    const body = opts.body || '';
                    try {
                        if (GLib && GLib.Bytes) {
                            try { msg.set_request_body_from_bytes('application/json', GLib.Bytes.new(String(body))); }
                            catch (e) { msg.set_request_body_from_bytes('application/json', new GLib.Bytes(String(body))); }
                        }
                    } catch (e) {}
                    const cancellable = opts.cancellable || null;
                    s.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                        try {
                            const bytes = sess.send_and_read_finish(res);
                            let text = '';
                            try { text = new TextDecoder().decode(bytes.get_data()); } catch (e) { text = String(bytes.get_data()); }
                            const status = typeof msg.get_status === 'function' ? msg.get_status() : (msg.status_code || 200);
                            resolve({ status, bodyText: text, body: text });
                        } catch (e) { reject(e); }
                    });
                } catch (e) { reject(e); }
            });
        };
    }
    // Node / fetch fallback
    if (typeof fetch === 'function') {
        return async function fetchFetch(url, opts) {
            const res = await fetch(url, { method: opts.method || 'POST', headers: opts.headers || {}, body: opts.body });
            const text = await res.text();
            return { status: res.status, bodyText: text, body: text };
        };
    }
    // No transport
    return function noFetch() {
        return Promise.reject(new Error('no http transport'));
    };
}

function createNineRouterProvider(opts) {
    opts = opts || {};
    const baseUrl = opts.baseUrl;
    const apiKey = opts.apiKey;
    const model = opts.model;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const httpFetch = opts.httpFetch || createDefaultHttpFetch();

    if (!baseUrl) throw new Error('NineRouterProvider: baseUrl required');
    if (!model) throw new Error('NineRouterProvider: model required');
    // apiKey may be empty — handled per-request as auth_error without network

    let destroyed = false;

    function request(payload, cancellable, cb) {
        // overload: request(payload, cb)
        if (typeof cancellable === 'function' && cb === undefined) {
            cb = cancellable;
            cancellable = null;
        }
        // also support payload being string query (legacy)
        if (typeof payload === 'string') payload = { query: payload };
        payload = payload || {};

        if (destroyed) {
            const e = new Error('AI provider unavailable');
            e.code = 'provider_error';
            if (cb) return cb(e);
            return;
        }

        // secret never in error message — generic only
        if (!apiKey) {
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            if (cb) return cb(e);
            return;
        }

        const systemPrompt = payload.systemPrompt || '';
        let userContent = '';
        if (typeof payload.query === 'string') userContent = payload.query;
        else if (typeof payload.userContent === 'string') userContent = payload.userContent;
        else if (payload.messages) {
            // if caller already built messages, extract last user — but spec says provider builds messages
            userContent = String(payload.query || '');
        }
        if (payload.groundingContext) {
            userContent = (userContent ? userContent + '\n\n' : '') + String(payload.groundingContext);
        }

        let url;
        try { url = buildChatCompletionsUrl(baseUrl); } catch (e) {
            const err = new Error('Invalid AI response');
            err.code = 'invalid_response';
            if (cb) return cb(err);
            return;
        }

        const body = buildRequestBody(model, systemPrompt, userContent);
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        };

        let settled = false;
        let timeoutId = null;

        function done(err, result) {
            if (settled) return;
            settled = true;
            if (timeoutId) _cancelTimeout(timeoutId);
            if (_isCancelled(cancellable)) {
                const ce = new Error('cancelled');
                ce.code = 'cancelled';
                if (cb) return cb(ce);
                return;
            }
            if (err) {
                // ensure no secret in message
                if (err.message && String(err.message).includes(String(apiKey))) {
                    err.message = String(err.message).replace(String(apiKey), '[REDACTED]');
                }
                if (cb) return cb(err);
                return;
            }
            if (cb) return cb(null, result);
        }

        timeoutId = _scheduleTimeout(timeoutMs, () => {
            if (settled) return;
            settled = true;
            // try to cancel underlying Soup message
            try { if (cancellable && typeof cancellable.cancel === 'function') cancellable.cancel(); } catch (e) {}
            const e = new Error('AI request timeout');
            e.code = 'timeout';
            if (cb) cb(e);
        });

        let fetchPromise;
        try {
            // httpFetch may be (url, opts) => Promise or (url, opts, callback)
            if (httpFetch.length >= 3) {
                // callback style — not expected but handle
                fetchPromise = new Promise((resolve, reject) => {
                    try {
                        httpFetch(url, { method: 'POST', headers, body, cancellable }, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    } catch (e) { reject(e); }
                });
            } else {
                const maybe = httpFetch(url, { method: 'POST', headers, body, cancellable, timeoutMs });
                // handle both {status, bodyText} and {status, body} and raw string
                if (maybe && typeof maybe.then === 'function') fetchPromise = maybe;
                else fetchPromise = Promise.resolve(maybe);
            }
        } catch (e) {
            done(e);
            return;
        }

        fetchPromise.then(res => {
            if (settled) return;
            // cancelled already?
            if (_isCancelled(cancellable)) {
                return done(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
            }
            // normalize response shape
            let status = 200;
            let text = '';
            if (res == null) {
                const e = new Error('Invalid AI response');
                e.code = 'invalid_response';
                return done(e);
            }
            if (typeof res === 'string') {
                text = res;
                status = 200;
            } else if (typeof res === 'object') {
                if (typeof res.status === 'number') status = res.status;
                else if (typeof res.statusCode === 'number') status = res.statusCode;
                if (typeof res.bodyText === 'string') text = res.bodyText;
                else if (typeof res.body === 'string') text = res.body;
                else if (typeof res.text === 'string') text = res.text;
                else if (typeof res.data === 'string') text = res.data;
                else text = typeof res.bodyText !== 'undefined' ? String(res.bodyText) : '';
                // if body is object already parsed
                if (!text && res.body && typeof res.body === 'object') {
                    try { text = JSON.stringify(res.body); } catch (e) {}
                }
            }
            if (status < 200 || status >= 300) {
                const code = httpStatusToCode(status);
                const e = new Error(code === 'auth_error' ? 'AI provider auth error' : code === 'rate_limited' ? 'AI rate limited' : 'AI provider unavailable');
                e.code = code;
                e.status = status;
                return done(e);
            }
            try {
                const parsed = parseResponseText(text, status);
                return done(null, parsed);
            } catch (e) {
                // map provider error payload status if present
                if (e._status) e.code = httpStatusToCode(e._status);
                return done(e);
            }
        }).catch(e => {
            if (settled) return;
            if (_isCancelled(cancellable)) {
                const ce = new Error('cancelled');
                ce.code = 'cancelled';
                return done(ce);
            }
            // network error
            const ne = new Error('AI network error');
            ne.code = 'network_error';
            ne.cause = e;
            return done(ne);
        });
    }

    function destroy() {
        destroyed = true;
    }

    return { request, destroy, _buildUrl: buildChatCompletionsUrl };
}

module.exports = { createNineRouterProvider, NineRouterProvider: createNineRouterProvider, buildChatCompletionsUrl, buildRequestBody, parseResponseText, DEFAULT_TIMEOUT_MS };
