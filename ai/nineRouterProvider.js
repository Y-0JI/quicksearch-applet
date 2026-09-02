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
        const err = new Error('AI provider error');
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
                // send() returns InputStream for chunked reading
                if (typeof s.send === 'function') {
                    s.send(msg, cancellable, (sess, res) => {
                        try {
                            const inputStream = sess.send_finish(res);
                            if (!inputStream) { onDone(new Error('no input stream')); return; }
                            _readStreamChunks(inputStream, onChunk, onDone);
                        } catch (e) {
                            const status = typeof msg.get_status === 'function' ? msg.get_status() : (msg.status_code || 0);
                            if (status >= 200 && status < 300) {
                                // send failed but status OK — fallback to full read
                                _fallbackFullRead(s, msg, onChunk, onDone);
                            } else {
                                onDone(e);
                            }
                        }
                    });
                } else {
                    // Fallback: full read then split into chunks
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
                    const err = new Error('HTTP ' + res.status);
                    err.status = res.status;
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
function _readStreamChunks(inputStream, onChunk, onDone) {
    const bufferSize = 4096;
    let finished = false;
    function readNext() {
        if (finished) return;
        try {
            inputStream.read_bytes_async(bufferSize, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                if (finished) return;
                try {
                    const bytes = stream.read_bytes_finish(result);
                    if (!bytes || bytes.get_size() === 0) {
                        finished = true;
                        try { inputStream.close(null); } catch (e) {}
                        onDone(null);
                        return;
                    }
                    let text = '';
                    try { text = new TextDecoder().decode(bytes.get_data()); } catch (e) { text = String(bytes.get_data()); }
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
                const status = typeof msg.get_status === 'function' ? msg.get_status() : (msg.status_code || 200);
                if (status < 200 || status >= 300) {
                    const err = new Error('HTTP ' + status);
                    err.status = status;
                    return onDone(err);
                }
                if (text) onChunk(text);
                onDone(null);
            } catch (e) { onDone(e); }
        });
    } catch (e) { onDone(e); }
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
                const e = new Error(code === 'auth_error' ? 'AI provider auth error' : code === 'rate_limited' ? 'AI rate limited' : 'AI provider unavailable');
                e.code = code;
                e.status = status;
                return complete(e);
            }
            try {
                const parsed = parseResponseText(text, status);
                return complete(null, parsed);
            } catch (e) {
                if (e._status) e.code = httpStatusToCode(e._status);
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
                const code = (typeof err.status === 'number') ? httpStatusToCode(err.status) : 'network_error';
                const message = code === 'auth_error' ? 'AI provider auth error' : code === 'rate_limited' ? 'AI rate limited' : 'AI network error';
                const e = new Error(message);
                e.code = code;
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
