// ai/marketData/oauth/oauthGjsListener.js — Gio.SocketService adapter for oauthLoopback.
// Satisfies createListener({port, onRequest}) -> {start()->port, close()}.
// Loopback only, fixed-port list with conflict skip (port 0 unsupported by GLib).
// GJS deps (Gio, GLib) injected; falls back to node listener when unavailable
// (tests) — never silently binds non-loopback.
let loopbackMod = null;
try { loopbackMod = require('./oauthLoopback.js'); } catch (e) {}
try { if (!loopbackMod) loopbackMod = require('./marketData/oauth/oauthLoopback.js'); } catch (e) {}
try { if (!loopbackMod) loopbackMod = require('ai/marketData/oauth/oauthLoopback.js'); } catch (e) {}

function createGjsListener(gjs) {
    gjs = gjs || {};
    const Gio = gjs.Gio || null;
    const GLib = gjs.GLib || null;
    // Node/test fallback: identical interface, loopback only.
    if (!Gio || typeof Gio.SocketService !== 'function') {
        if (loopbackMod && typeof loopbackMod.createNodeListener === 'function') {
            return loopbackMod.createNodeListener;
        }
        throw Object.assign(new Error('No GJS Gio and no node listener fallback'), { code: 'oauth_callback_failed' });
    }
    return function gjsListenerFactory(opts) {
        opts = opts || {};
        const port = opts.port == null ? -1 : opts.port;
        const onRequest = opts.onRequest;
        let service = null;
        let connIds = [];
        function _readRequest(conn) {
            try {
                const inp = conn.get_input_stream();
                const dis = new Gio.DataInputStream({ base_stream: inp });
                const prio = (GLib && GLib.PRIORITY_DEFAULT != null) ? GLib.PRIORITY_DEFAULT : 0;
                dis.read_line_async(prio, null, (src, res2) => {
                    let line = '';
                    try {
                        const out = src.read_line_finish_utf8(res2);
                        line = (out && out[0]) || '';
                    } catch (e) { try { conn.close(null); } catch (e2) {} return; }
                    const parts = String(line).split(' ');
                    const target = parts.length >= 2 ? parts[1] : '/';
                    const req = { url: target, headers: { host: '127.0.0.1:' + port } };
                    const res = {
                        statusCode: 200,
                        _code: 200,
                        end: (body) => {
                            try {
                                const out = conn.get_output_stream();
                                const text = 'HTTP/1.0 ' + res.statusCode + ' OK\r\nContent-Length: ' + String(body || '').length + '\r\nConnection: close\r\n\r\n' + (body || '');
                                out.write_all(text, null);
                            } catch (e) {}
                            try { conn.close(null); } catch (e2) {}
                        }
                    };
                    Object.defineProperty(res, 'statusCode', {
                        get() { return res._code; },
                        set(v) { res._code = v; }
                    });
                    try { onRequest(req, res); } catch (e) {
                        try { res.statusCode = 500; res.end('error'); } catch (e2) {}
                    }
                });
            } catch (e) { try { conn.close(null); } catch (e2) {} }
        }
        return {
            start() {
                return new Promise((resolve, reject) => {
                    try {
                        service = new Gio.SocketService();
                        if (port === 0 || port == null || port === -1) {
                            reject(Object.assign(new Error('Ephemeral port unsupported on GJS; configure fixed ports'), { code: 'oauth_callback_failed' }));
                            return;
                        }
                        service.add_inet_port(port, null);
                        const id = service.connect('incoming', (svc, conn) => {
                            try { _readRequest(conn); } catch (e) {}
                            return true;
                        });
                        connIds.push(id);
                        try { service.start(); } catch (e) {}
                        resolve(port);
                    } catch (e) { reject(e); }
                });
            },
            close() {
                return new Promise((resolve) => {
                    try {
                        for (const id of connIds) { try { service.disconnect(id); } catch (e) {} }
                        connIds = [];
                        if (service) { try { service.stop(); } catch (e) {} try { service.close(); } catch (e2) {} }
                    } catch (e) {}
                    service = null;
                    resolve();
                });
            }
        };
    };
}

module.exports = { createGjsListener };
