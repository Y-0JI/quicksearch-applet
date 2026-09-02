// ai/nineRouterProvider.js — OpenAI-compatible non-streaming transport to 9router.
// Behind AIProvider contract. No UI, no tool registry, no shell.
// ponytail: non-streaming only. Upgrade to streaming via `stream: true` + chunk parsing when UI needs it.
let Gio = null, GLib = null, Soup = null;
try { Gio = require('gi.Gio'); } catch (e) {}
try { GLib = require('gi.GLib'); } catch (e) {}
try { Soup = require('gi.Soup'); } catch (e) {}

const DEFAULT_TIMEOUT_MS = 15000;
const _knownApiKeys = new Set();
function _redactKnownKeys(str) {
    let s = String(str);
    for (const k of _knownApiKeys) {
        if (k && s.includes(k)) s = s.split(k).join('[REDACTED]');
    }
    return s;
}

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
    let data;
    try { data = JSON.parse(text); } catch (e) {
        const err = new Error('Invalid AI response');
        err.code = 'invalid_response';
        throw err;
    }
    if (data && typeof data === 'object' && data.error) {
        let msg = 'AI provider error';
        if (typeof data.error === 'string' && data.error.trim()) msg = data.error.trim();
        else if (data.error && typeof data.error.message === 'string' && data.error.message.trim()) msg = data.error.message.trim();
        else if (typeof data.message === 'string' && data.message.trim()) msg = data.message.trim();
        const err = new Error(msg);
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
    return { type: 'answer', text: content };
}

function httpStatusToCode(status) {
    if (status === 401 || status === 403) return 'auth_error';
    if (status === 429) return 'rate_limited';
    return 'provider_error';
}

function createDefaultHttpFetch() {
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
                    const signal = opts.signal || null;
                    // if native AbortSignal provided and Soup not cancellable, wire it
                    let abortHandler = null;
                    if (signal && !cancellable) {
                        if (signal.aborted) return reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
                        abortHandler = () => reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
                        try { signal.addEventListener('abort', abortHandler); } catch (e) {}
                    }
                    s.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                        try { if (signal && abortHandler) try { signal.removeEventListener('abort', abortHandler); } catch (e) {} } catch (e) {}
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
    if (typeof fetch === 'function') {
        return async function fetchFetch(url, opts) {
            const init = { method: opts.method || 'POST', headers: opts.headers || {}, body: opts.body };
            if (opts.signal) init.signal = opts.signal;
            const res = await fetch(url, init);
            const text = await res.text();
            return { status: res.status, bodyText: text, body: text };
        };
    }
    return function noFetch() {
        return Promise.reject(new Error('no http transport'));
    };
}

function _getSoupStatus(msg) {
    try {
        if (msg && typeof msg.get_status === 'function') return msg.get_status();
        if (msg && typeof msg.get_status_code === 'function') return msg.get_status_code();
        if (msg && typeof msg.status_code === 'number') return msg.status_code;
        if (msg && typeof msg.statusCode === 'number') return msg.statusCode;
    } catch (e) {}
    return 0;
}

function _parseErrorMessage(text, fallbackStatus) {
    if (!text) return 'HTTP ' + fallbackStatus;
    try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object') {
            if (data.error && typeof data.error === 'object' && typeof data.error.message === 'string' && data.error.message.trim()) return data.error.message.trim();
            if (typeof data.error === 'string' && data.error.trim()) return data.error.trim();
            if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
        }
    } catch (e) {}
    const t = String(text).trim();
    if (t.length > 0 && t.length < 500) return t;
    return 'HTTP ' + fallbackStatus;
}

function _sanitizedLog() {
    try {
        const args = Array.prototype.slice.call(arguments);
        // never log auth headers / api keys — strip bearer tokens and any known apiKey values
        const line = args.map(a => {
            let s = String(a);
            s = _redactKnownKeys(s);
            s = s.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
            s = s.replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]');
            s = _redactKnownKeys(s);
            return s;
        }).join(' ');
        const msg = '[quicksearch] ' + line;
        if (typeof global !== 'undefined' && global && typeof global.log === 'function') global.log(msg);
        else if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(msg);
    } catch (e) {}
}

function _collectStreamText(stream, cb) {
    // Collect all bytes from GIO InputStream for error bodies (non-2xx)
    let acc = [];
    let totalLen = 0;
    function next() {
        try {
            stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    const bytes = s.read_bytes_finish(res);
                    if (!bytes || bytes.get_size() === 0) {
                        try { stream.close(null); } catch (e2) {}
                        let text = '';
                        if (acc.length > 0) {
                            const combined = new Uint8Array(totalLen);
                            let off = 0;
                            for (let i = 0; i < acc.length; i++) { combined.set(acc[i], off); off += acc[i].length; }
                            try { text = new TextDecoder().decode(combined); } catch (e) { text = String(combined); }
                        }
                        cb(null, text);
                        return;
                    }
                    const raw = bytes.get_data();
                    let chunk;
                    if (raw instanceof Uint8Array) chunk = raw;
                    else if (raw && typeof raw.length === 'number') chunk = new Uint8Array(raw);
                    else chunk = new Uint8Array(0);
                    acc.push(chunk);
                    totalLen += chunk.length;
                    next();
                } catch (e) { cb(e); }
            });
        } catch (e) { cb(e); }
    }
    next();
}

function createDefaultStreamingHttpFetch() {
    // Streaming HTTP fetch: calls onChunk(text) for each SSE text chunk, onDone(err) when finished.
    if (Soup && GLib) {
        let session = null;
        function ensureSession() {
            if (!session) {
                session = new Soup.Session();
                session.timeout = 30;
            }
            return session;
        }
        return function soupStreamFetch(url, opts, onChunk, onDone) {
            try {
                const s = ensureSession();
                const msg = Soup.Message.new('POST', url);
                if (!msg) { onDone(new Error('bad url')); return; }
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
                _sanitizedLog('stream start', url);
                // Resolve async send method compat: libsoup 3 uses send_async/send_finish, older also send_async
                let sendFn = null;
                let sendKind = '';
                if (typeof s.send_async === 'function') { sendFn = s.send_async.bind(s); sendKind = 'send_async'; }
                else if (typeof s.sendAsync === 'function') { sendFn = s.sendAsync.bind(s); sendKind = 'sendAsync'; }
                else if (typeof s.send === 'function') { sendFn = s.send.bind(s); sendKind = 'send'; }
                function handleStream(stream) {
                    const status = _getSoupStatus(msg);
                    _sanitizedLog('stream response status', status, 'via', sendKind || 'fallback');
                    if (status !== 0 && (status < 200 || status >= 300)) {
                        // Do NOT feed error body into SSE parser — collect, parse, map
                        _collectStreamText(stream, (cerr, text) => {
                            const message = _parseErrorMessage(text, status);
                            const code = httpStatusToCode(status);
                            _sanitizedLog('stream http error', status, code, message.slice(0, 200));
                            const err = new Error(message);
                            err.code = code;
                            err.status = status;
                            onDone(err);
                        });
                        return;
                    }
                    _readStreamChunks(stream, onChunk, onDone);
                }
                function handleSendError(e) {
                    const status = _getSoupStatus(msg);
                    _sanitizedLog('stream send error', String(e && e.message || e).slice(0, 300), 'status', status);
                    if (status !== 0 && (status < 200 || status >= 300)) {
                        const code = httpStatusToCode(status);
                        const err = new Error(_parseErrorMessage(e && e.message || '', status));
                        err.code = code;
                        err.status = status;
                        onDone(err);
                        return;
                    }
                    if (status >= 200 && status < 300) {
                        _fallbackFullRead(s, msg, onChunk, onDone);
                        return;
                    }
                    if (status !== 0) {
                        const code = httpStatusToCode(status);
                        const err = new Error(_parseErrorMessage('', status));
                        err.code = code;
                        err.status = status;
                        onDone(err);
                        return;
                    }
                    onDone(e);
                }
                if (sendFn) {
                    try {
                        // send_async signature: (msg, priority, cancellable, callback) vs send: (msg, cancellable, callback)
                        if (sendKind === 'send_async' || sendKind === 'sendAsync') {
                            sendFn(msg, GLib.PRIORITY_DEFAULT, cancellable, (sess, res) => {
                                try {
                                    const finish = sess.send_finish || sess.sendFinish || sess.send_finish_async;
                                    const inputStream = (typeof sess.send_finish === 'function') ? sess.send_finish(res)
                                        : (typeof sess.sendFinish === 'function') ? sess.sendFinish(res)
                                        : null;
                                    if (!inputStream) { onDone(new Error('no input stream')); return; }
                                    handleStream(inputStream);
                                } catch (e) { handleSendError(e); }
                            });
                        } else {
                            // s.send(msg, cancellable, cb) — older GI binding
                            s.send(msg, cancellable, (sess, res) => {
                                try {
                                    const inputStream = sess.send_finish(res);
                                    if (!inputStream) { onDone(new Error('no input stream')); return; }
                                    handleStream(inputStream);
                                } catch (e) { handleSendError(e); }
                            });
                        }
                    } catch (e) { handleSendError(e); }
                } else {
                    // Fallback: full read then deliver as one chunk (will validate status)
                    _fallbackFullRead(s, msg, onChunk, onDone);
                }
            } catch (e) { onDone(e); }
        };
    }
    if (typeof fetch === 'function') {
        return function fetchStreamFetch(url, opts, onChunk, onDone) {
            const init = { method: opts.method || 'POST', headers: opts.headers || {}, body: opts.body };
            if (opts.signal) init.signal = opts.signal;
            fetch(url, init).then(async (res) => {
                if (!res.ok) {
                    let text = '';
                    try { text = await res.text(); } catch (e) {}
                    const message = _parseErrorMessage(text, res.status);
                    _sanitizedLog('stream http error', res.status, httpStatusToCode(res.status), message.slice(0, 200));
                    const err = new Error(message);
                    err.status = res.status;
                    err.code = httpStatusToCode(res.status);
                    return onDone(err);
                }
                const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
                if (!reader) {
                    // No streaming body support — read full response
                    const text = await res.text();
                    onChunk(text);
                    onDone(null);
                    return;
                }
                const decoder = new TextDecoder();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const text = decoder.decode(value, { stream: true });
                        if (text) onChunk(text);
                    }
                    const tail = decoder.decode();
                    if (tail) onChunk(tail);
                    onDone(null);
                } catch (e) {
                    onDone(e);
                }
            }).catch(e => onDone(e));
        };
    }
    return function noStreamFetch(url, opts, onChunk, onDone) {
        onDone(new Error('no http transport'));
    };
}

// Read chunks from a GIO InputStream (Soup streaming path)
// ponytail: persistent TextDecoder with {stream:true} prevents UTF-8 split corruption.
function _readStreamChunks(inputStream, onChunk, onDone) {
    const bufferSize = 4096;
    let finished = false;
    let decoder = null;
    try { decoder = new TextDecoder(); } catch (e) { decoder = null; }
    function readNext() {
        if (finished) return;
        try {
            inputStream.read_bytes_async(bufferSize, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                if (finished) return;
                try {
                    const bytes = stream.read_bytes_finish(result);
                    if (!bytes || bytes.get_size() === 0) {
                        finished = true;
                        // flush persistent decoder tail
                        if (decoder) {
                            try {
                                const tail = decoder.decode();
                                if (tail) onChunk(tail);
                            } catch (e) {}
                        }
                        try { inputStream.close(null); } catch (e) {}
                        onDone(null);
                        return;
                    }
                    let text = '';
                    const raw = bytes.get_data();
                    if (decoder) {
                        try { text = decoder.decode(raw, { stream: true }); } catch (e) { try { text = new TextDecoder().decode(raw); } catch (e2) { text = String(raw); } }
                    } else {
                        try { text = new TextDecoder().decode(raw); } catch (e) { text = String(raw); }
                    }
                    if (text) onChunk(text);
                    readNext();
                } catch (e) {
                    if (!finished) {
                        finished = true;
                        onDone(e);
                    }
                }
            });
        } catch (e) {
            if (!finished) {
                finished = true;
                onDone(e);
            }
        }
    }
    readNext();
}

// Fallback: full read then deliver as one chunk
function _fallbackFullRead(session, msg, onChunk, onDone) {
    try {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
            try {
                const bytes = sess.send_and_read_finish(res);
                let text = '';
                try { text = new TextDecoder().decode(bytes.get_data()); } catch (e) { text = String(bytes.get_data()); }
                const status = _getSoupStatus(msg) || 200;
                if (status < 200 || status >= 300) {
                    const message = _parseErrorMessage(text, status);
                    const code = httpStatusToCode(status);
                    _sanitizedLog('fallback http error', status, code, message.slice(0, 200));
                    const err = new Error(message);
                    err.status = status;
                    err.code = code;
                    return onDone(err);
                }
                if (text && typeof onChunk === 'function') onChunk(text);
                onDone(null);
            } catch (e) { onDone(e); }
        });
    } catch (e) { onDone(e); }
}

function createNineRouterProvider(opts) {
    opts = opts || {};
    const baseUrl = opts.baseUrl;
    const apiKey = opts.apiKey;
    if (apiKey) try { _knownApiKeys.add(String(apiKey)); } catch (e) {}
    const model = opts.model;
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const httpFetch = opts.httpFetch || createDefaultHttpFetch();

    if (!baseUrl) throw new Error('NineRouterProvider: baseUrl required');
    if (!model) throw new Error('NineRouterProvider: model required');

    let destroyed = false;
    const activeRequests = new Set();

    function sanitizeError(err) {
        if (!err || !apiKey) return err;
        try {
            if (err.message && String(err.message).includes(String(apiKey))) {
                err.message = String(err.message).split(String(apiKey)).join('[REDACTED]');
            }
            if (err.cause && err.cause.message && String(err.cause.message).includes(String(apiKey))) {
                err.cause.message = String(err.cause.message).split(String(apiKey)).join('[REDACTED]');
            }
            // also sanitize any stringified stack that might contain key
            if (err.stack && String(err.stack).includes(String(apiKey))) {
                err.stack = String(err.stack).split(String(apiKey)).join('[REDACTED]');
            }
        } catch (e) {}
        return err;
    }

    function request(payload, cancellable, cb) {
        if (typeof cancellable === 'function' && cb === undefined) {
            cb = cancellable;
            cancellable = null;
        }
        if (typeof payload === 'string') payload = { query: payload };
        payload = payload || {};

        if (destroyed) {
            const e = new Error('AI provider unavailable');
            e.code = 'provider_error';
            sanitizeError(e);
            if (cb) return cb(e);
            return;
        }

        if (!apiKey) {
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            if (cb) return cb(e);
            return;
        }

        if (_isCancelled(cancellable)) {
            const e = new Error('cancelled');
            e.code = 'cancelled';
            if (cb) return cb(e);
            return;
        }

        const systemPrompt = payload.systemPrompt || '';
        let userContent = '';
        if (typeof payload.query === 'string') userContent = payload.query;
        else if (typeof payload.userContent === 'string') userContent = payload.userContent;
        else if (payload.messages) {
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

        // per-request state for one-shot completion
        const state = {
            settled: false,
            timeoutId: null,
            cancelHandlerId: null,
            originalCancel: null,
            cancellable: cancellable,
            abortController: null,
            cb: cb,
            complete: null
        };
        activeRequests.add(state);

        // AbortController for native fetch fallback
        try {
            if (typeof AbortController !== 'undefined') {
                state.abortController = new AbortController();
            }
        } catch (e) {}

        function cleanup() {
            if (state.timeoutId) { _cancelTimeout(state.timeoutId); state.timeoutId = null; }
            // disconnect GIO cancellable handler
            if (state.cancelHandlerId != null && state.cancellable) {
                try {
                    if (typeof state.cancellable.disconnect === 'function') state.cancellable.disconnect(state.cancelHandlerId);
                } catch (e) {}
                state.cancelHandlerId = null;
            }
            // restore patched cancel
            if (state.originalCancel && state.cancellable) {
                try { state.cancellable.cancel = state.originalCancel; } catch (e) {}
                state.originalCancel = null;
            }
            activeRequests.delete(state);
        }

        function complete(err, result) {
            if (state.settled) return;
            state.settled = true;
            cleanup();
            // abort fetch if still pending
            if (state.abortController) {
                try { state.abortController.abort(); } catch (e) {}
            }
            if (err) {
                sanitizeError(err);
                // never expose headers/body containing secret — err is generic
                if (state.cb) return state.cb(err);
                return;
            }
            if (state.cb) return state.cb(null, result);
        }
        state.complete = complete;

        const cancelledError = Object.assign(new Error('cancelled'), { code: 'cancelled' });

        // register immediate cancellation handler
        if (cancellable) {
            // GIO Cancellable path: connect signal
            if (typeof cancellable.connect === 'function') {
                try {
                    state.cancelHandlerId = cancellable.connect('cancelled', () => {
                        complete(cancelledError);
                    });
                } catch (e) {}
            } else if (typeof cancellable.cancel === 'function') {
                // fake cancellable: patch cancel() to trigger immediate complete
                try {
                    state.originalCancel = cancellable.cancel.bind(cancellable);
                    const orig = state.originalCancel;
                    cancellable.cancel = function patchedCancel() {
                        try { orig(); } catch (e) {}
                        complete(cancelledError);
                    };
                } catch (e) {}
            }
            // also check already-cancelled race after registration
            if (_isCancelled(cancellable)) {
                return complete(cancelledError);
            }
        }

        state.timeoutId = _scheduleTimeout(timeoutMs, () => {
            if (state.settled) return;
            const e = new Error('AI request timeout');
            e.code = 'timeout';
            complete(e);
        });

        let fetchPromise;
        try {
            const fetchOpts = { method: 'POST', headers, body, cancellable: cancellable, timeoutMs };
            // provide AbortSignal to fetch fallback so it can be aborted
            if (state.abortController) fetchOpts.signal = state.abortController.signal;
            // also pass abortController itself for transports that want it
            fetchOpts.abortController = state.abortController;
            if (httpFetch.length >= 3) {
                fetchPromise = new Promise((resolve, reject) => {
                    try {
                        httpFetch(url, fetchOpts, (err, res) => {
                            if (err) reject(err);
                            else resolve(res);
                        });
                    } catch (e) { reject(e); }
                });
            } else {
                const maybe = httpFetch(url, fetchOpts);
                if (maybe && typeof maybe.then === 'function') fetchPromise = maybe;
                else fetchPromise = Promise.resolve(maybe);
            }
        } catch (e) {
            complete(sanitizeError(e));
            return;
        }

        fetchPromise.then(res => {
            if (state.settled) return;
            if (_isCancelled(cancellable)) {
                return complete(cancelledError);
            }
            let status = 200;
            let text = '';
            if (res == null) {
                const e = new Error('Invalid AI response');
                e.code = 'invalid_response';
                return complete(e);
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
                if (!text && res.body && typeof res.body === 'object') {
                    try { text = JSON.stringify(res.body); } catch (e) {}
                }
            }
            if (status < 200 || status >= 300) {
                const code = httpStatusToCode(status);
                const providerMsg = _parseErrorMessage(text, status);
                const isGenericHttp = /^HTTP\s+\d+$/i.test(providerMsg);
                const fallback = code === 'auth_error' ? 'AI provider auth error' : code === 'rate_limited' ? 'AI rate limited' : 'AI provider unavailable';
                const message = isGenericHttp ? fallback : providerMsg;
                _sanitizedLog('request http error', status, code, String(message).slice(0, 200));
                const e = new Error(message);
                e.code = code;
                e.status = status;
                return complete(e);
            }
            try {
                const parsed = parseResponseText(text, status);
                return complete(null, parsed);
            } catch (e) {
                if (e._status) e.code = httpStatusToCode(e._status);
                try { sanitizeError(e); } catch (ex) {}
                _sanitizedLog('request parse error', e.code || 'invalid_response', String(e.message).slice(0, 300));
                return complete(e);
            }
        }).catch(e => {
            if (state.settled) return;
            // AbortError from fetch -> cancelled, not network_error (§7)
            if (e && (e.name === 'AbortError' || String(e.message).includes('AbortError') || String(e.message).includes('aborted'))) {
                return complete(cancelledError);
            }
            if (_isCancelled(cancellable)) {
                return complete(cancelledError);
            }
            const ne = new Error('AI network error');
            ne.code = 'network_error';
            // do not expose raw cause message that might contain secret
            // keep cause sanitized or omit
            try { ne.cause = sanitizeError(e); } catch (ex) {}
            sanitizeError(ne);
            return complete(ne);
        });
    }

    // Streaming request: sends stream:true, delivers SSE chunks via onEvent callback.
    // onEvent receives normalized events from streamParser: { type: 'start'|'delta'|'complete'|'error', ... }
    function streamRequest(payload, cancellable, onEvent) {
        if (typeof cancellable === 'function' && onEvent === undefined) {
            onEvent = cancellable;
            cancellable = null;
        }
        if (typeof payload === 'string') payload = { query: payload };
        payload = payload || {};

        if (destroyed) {
            const e = new Error('AI provider unavailable');
            e.code = 'provider_error';
            sanitizeError(e);
            if (onEvent) return onEvent({ type: 'error', error: { code: e.code, message: e.message } });
            return;
        }

        if (!apiKey) {
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            if (onEvent) return onEvent({ type: 'error', error: { code: e.code, message: e.message } });
            return;
        }

        if (_isCancelled(cancellable)) {
            return; // silent cancel per spec
        }

        const systemPrompt = payload.systemPrompt || '';
        let userContent = '';
        if (typeof payload.query === 'string') userContent = payload.query;
        else if (typeof payload.userContent === 'string') userContent = payload.userContent;
        if (payload.groundingContext) {
            userContent = (userContent ? userContent + '\n\n' : '') + String(payload.groundingContext);
        }

        let url;
        try { url = buildChatCompletionsUrl(baseUrl); } catch (e) {
            if (onEvent) return onEvent({ type: 'error', error: { code: 'invalid_response', message: 'Invalid AI response' } });
            return;
        }

        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
        messages.push({ role: 'user', content: String(userContent || '') });
        const body = JSON.stringify({ model: String(model), messages, stream: true });
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        };

        // per-request state
        const state = {
            settled: false,
            timeoutId: null,
            cancelHandlerId: null,
            originalCancel: null,
            cancellable: cancellable,
            abortController: null,
            onEvent: onEvent,
            complete: null
        };
        activeRequests.add(state);

        try {
            if (typeof AbortController !== 'undefined') {
                state.abortController = new AbortController();
            }
        } catch (e) {}

        let parser = null;
        try {
            const sp = require('./streamParser.js');
            parser = sp.createStreamParser({
                onEvent: (evt) => {
                    if (state.settled || _isCancelled(cancellable)) return;
                    if (state.onEvent) state.onEvent(evt);
                }
            });
        } catch (e) {}

        function cleanup() {
            if (state.timeoutId) { _cancelTimeout(state.timeoutId); state.timeoutId = null; }
            if (state.cancelHandlerId != null && state.cancellable) {
                try {
                    if (typeof state.cancellable.disconnect === 'function') state.cancellable.disconnect(state.cancelHandlerId);
                } catch (e) {}
                state.cancelHandlerId = null;
            }
            if (state.originalCancel && state.cancellable) {
                try { state.cancellable.cancel = state.originalCancel; } catch (e) {}
                state.originalCancel = null;
            }
            activeRequests.delete(state);
        }

        function settle(err) {
            if (state.settled) return;
            state.settled = true;
            cleanup();
            if (state.abortController) {
                try { state.abortController.abort(); } catch (e) {}
            }
            if (err && state.onEvent) {
                try { sanitizeError(err); } catch (e) {}
                const code = err.code || 'provider_error';
                if (code !== 'cancelled') {
                    state.onEvent({ type: 'error', error: { code, message: err.message || code } });
                }
            }
        }
        state.complete = settle;

        const cancelledError = Object.assign(new Error('cancelled'), { code: 'cancelled' });

        // register cancellation handler
        if (cancellable) {
            if (typeof cancellable.connect === 'function') {
                try {
                    state.cancelHandlerId = cancellable.connect('cancelled', () => {
                        settle(cancelledError);
                    });
                } catch (e) {}
            } else if (typeof cancellable.cancel === 'function') {
                try {
                    state.originalCancel = cancellable.cancel.bind(cancellable);
                    const orig = state.originalCancel;
                    cancellable.cancel = function patchedCancel() {
                        try { orig(); } catch (e) {}
                        settle(cancelledError);
                    };
                } catch (e) {}
            }
            if (_isCancelled(cancellable)) {
                return settle(cancelledError);
            }
        }

        state.timeoutId = _scheduleTimeout(timeoutMs, () => {
            if (state.settled) return;
            const e = new Error('AI request timeout');
            e.code = 'timeout';
            settle(e);
        });

        const httpStreamFetch = opts.httpStreamFetch || createDefaultStreamingHttpFetch();
        let fetchAbortHandler = null;
        if (state.abortController && !cancellable) {
            fetchAbortHandler = () => settle(cancelledError);
            try { state.abortController.signal.addEventListener('abort', fetchAbortHandler); } catch (e) {}
        }

        httpStreamFetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
            cancellable: cancellable,
            signal: state.abortController ? state.abortController.signal : undefined
        },
        // onChunk: feed raw SSE text to parser
        function onChunk(rawText) {
            if (state.settled || _isCancelled(cancellable)) return;
            if (parser) {
                parser.feed(rawText);
            }
        },
        // onDone: stream finished
        function onDone(err) {
            if (state.settled) return;
            if (_isCancelled(cancellable)) {
                return settle(cancelledError);
            }
            if (err) {
                if (err.name === 'AbortError' || String(err.message).includes('AbortError') || String(err.message).includes('aborted')) {
                    return settle(cancelledError);
                }
                // Preserve provider message; map code from status or keep err.code if already normalized
                let code = err.code;
                if (!code || code === 'provider_error' || code === 'network_error') {
                    if (typeof err.status === 'number') code = httpStatusToCode(err.status);
                    else if (!code) code = 'network_error';
                } else if (typeof err.status === 'number') {
                    const mapped = httpStatusToCode(err.status);
                    // status-derived auth/rate takes precedence over generic provider_error
                    if (mapped === 'auth_error' || mapped === 'rate_limited') code = mapped;
                }
                const rawMsg = (err.message && String(err.message).trim()) ? String(err.message).trim() : '';
                const fallback = code === 'auth_error' ? 'AI provider auth error' : code === 'rate_limited' ? 'AI rate limited' : (code === 'timeout' ? 'AI request timeout' : 'AI network error');
                // If provider gave a specific message (not just "HTTP 401"), keep it; else use fallback
                const message = (rawMsg && !/^HTTP\s+\d+$/i.test(rawMsg)) ? rawMsg : fallback;
                _sanitizedLog('stream onDone error', code, String(message).slice(0, 300));
                const e = new Error(message);
                e.code = code;
                if (typeof err.status === 'number') e.status = err.status;
                return settle(e);
            }
            // Flush parser — triggers complete event if not already done
            if (parser && !parser.isDone()) {
                parser.flush();
            }
            // If parser never emitted complete (e.g., no data received), settle without error
            if (!state.settled) {
                settle(null);
            }
        });
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        const pending = Array.from(activeRequests);
        const cancelledErr = Object.assign(new Error('cancelled'), { code: 'cancelled' });
        for (const state of pending) {
            if (state.settled) continue;
            // disconnect GIO handler before external cancel to avoid double complete via signal
            if (state.cancelHandlerId != null && state.cancellable) {
                try { if (typeof state.cancellable.disconnect === 'function') state.cancellable.disconnect(state.cancelHandlerId); } catch (e2) {}
                state.cancelHandlerId = null;
            }
            // propagate to external cancellable so holder sees cancelled
            try {
                if (state.originalCancel) state.originalCancel();
                else if (state.cancellable && typeof state.cancellable.cancel === 'function') state.cancellable.cancel();
            } catch (e2) {}
            // one-shot completion — guarantees callback, timeout cleanup, abort, activeRequests removal
            try {
                if (typeof state.complete === 'function') state.complete(cancelledErr);
                else {
                    // fallback if complete not yet wired
                    state.settled = true;
                    if (state.timeoutId) { _cancelTimeout(state.timeoutId); state.timeoutId = null; }
                    if (state.originalCancel && state.cancellable) { try { state.cancellable.cancel = state.originalCancel; } catch (e2) {} state.originalCancel = null; }
                    if (state.abortController) { try { state.abortController.abort(); } catch (e2) {} }
                    activeRequests.delete(state);
                    if (state.cb) { try { sanitizeError(cancelledErr); state.cb(cancelledErr); } catch (e2) {} }
                }
            } catch (e2) {}
        }
    }

    return { request, streamRequest, destroy, _buildUrl: buildChatCompletionsUrl };
}

module.exports = { createNineRouterProvider, NineRouterProvider: createNineRouterProvider, buildChatCompletionsUrl, buildRequestBody, parseResponseText, DEFAULT_TIMEOUT_MS };
