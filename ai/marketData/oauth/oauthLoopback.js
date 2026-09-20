// ai/marketData/oauth/oauthLoopback.js — one-shot localhost OAuth callback receiver.
// Reuses parseCallback()/state validation (no duplicate logic). Loopback only,
// short-lived, single transaction, explicit timeout + cancel + cleanup.
// Listener injected: createListener({port, onRequest}) -> {port, close()}.
// createNodeListener is the node/test listener; GJS listener lands here when
// Gio.SocketService wiring is added (same interface).
let browserFlowMod = null;
try { browserFlowMod = require('./oauthBrowserFlow.js'); } catch (e) {}
try { if (!browserFlowMod) browserFlowMod = require('./marketData/oauth/oauthBrowserFlow.js'); } catch (e) {}
try { if (!browserFlowMod) browserFlowMod = require('ai/marketData/oauth/oauthBrowserFlow.js'); } catch (e) {}

function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}

function createNodeListener(opts) {
    opts = opts || {};
    const http = require('node:http');
    const port = opts.port == null ? 0 : opts.port;
    const onRequest = opts.onRequest;
    const server = http.createServer((req, res) => {
        try { onRequest(req, res); } catch (e) {
            try { res.statusCode = 500; res.end('error'); } catch (e2) {}
        }
    });
    return {
        start() {
            return new Promise((resolve, reject) => {
                const onErr = (e) => reject(e);
                server.once('error', onErr);
                server.listen(port, '127.0.0.1', () => {
                    server.removeListener('error', onErr);
                    resolve(server.address().port);
                });
            });
        },
        close() {
            return new Promise((resolve) => {
                try { server.close(() => resolve()); } catch (e) { resolve(); }
                setTimeout(() => resolve(), 500).unref?.();
            });
        }
    };
}

function createLoopbackReceiver(opts) {
    opts = opts || {};
    const createListener = opts.createListener || createNodeListener;
    const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports.slice() : [0];
    const path = String(opts.path || '/callback');
    const state = String(opts.state || '');
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 120000;

    let listener = null;
    let info = null;
    let settled = false;
    let waiter = null;
    let waiterUsed = false;
    let timer = null;

    function _cleanup() {
        if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
        const l = listener;
        listener = null;
        if (l) {
            try {
                const r = l.close();
                if (r && typeof r.then === 'function') r.catch(() => {});
            } catch (e) {}
        }
    }
    function _settle(fn) {
        if (settled) return;
        settled = true;
        _cleanup();
        try { fn(); } catch (e) {}
    }
    function _resolveWaiter(value) {
        if (!waiter || waiterUsed) return;
        waiterUsed = true;
        try { waiter.resolve(value); } catch (e) {}
    }
    function _rejectWaiter(err) {
        if (!waiter || waiterUsed) return;
        waiterUsed = true;
        try { waiter.reject(err); } catch (e) {}
    }
    function _parse(url) {
        if (!browserFlowMod || typeof browserFlowMod.parseCallback !== 'function') {
            throw _err('oauth_callback_failed', 'Callback parser unavailable');
        }
        return browserFlowMod.parseCallback(url, state);
    }
    function _onRequest(req, res) {
        if (settled) {
            try { res.statusCode = 410; res.end('closed'); } catch (e) {}
            return;
        }
        let full = null;
        try {
            const host = (req.headers && req.headers.host) || ('127.0.0.1:' + (info ? info.port : 0));
            full = 'http://' + host + String(req.url || '');
        } catch (e) { full = String(req.url || ''); }
        let reqPath = '';
        try { reqPath = String(req.url || '').split('?')[0]; } catch (e) {}
        if (reqPath !== path) {
            try { res.statusCode = 404; res.end('not found'); } catch (e) {}
            return;
        }
        try {
            const out = _parse(full);
            try { res.statusCode = 200; res.end('ok'); } catch (e) {}
            _settle(() => _resolveWaiter(out));
        } catch (e) {
            try { res.statusCode = 400; res.end('rejected'); } catch (e2) {}
            _settle(() => _rejectWaiter(e));
        }
    }
    async function start() {
        if (info) return info;
        let lastErr = null;
        for (const p of ports) {
            const lis = createListener({ port: p, onRequest: _onRequest });
            try {
                const bound = await lis.start();
                listener = lis;
                info = { port: bound, url: 'http://127.0.0.1:' + bound + path };
                timer = setTimeout(() => {
                    _settle(() => _rejectWaiter(_err('oauth_callback_timeout', 'OAuth callback timeout')));
                }, timeoutMs);
                if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch (e) {} }
                return info;
            } catch (e) {
                lastErr = e;
                try { if (lis && typeof lis.close === 'function') lis.close(); } catch (e2) {}
            }
        }
        throw lastErr || _err('oauth_callback_failed', 'Loopback bind failed');
    }
    function waitForCallback() {
        if (settled) return Promise.reject(_err('oauth_receiver_closed', 'Loopback receiver closed'));
        return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    }
    async function cancel() {
        const had = !!waiter && !settled && !waiterUsed;
        _settle(() => {});
        if (had) _rejectWaiter(_err('oauth_callback_cancelled', 'OAuth callback cancelled'));
    }
    return { start, waitForCallback, cancel };
}

module.exports = { createLoopbackReceiver, createNodeListener };
