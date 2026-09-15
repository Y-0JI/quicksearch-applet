// ai/soupTextReader.js — crash-free Soup response reader (2026-09-15).
//
// Why: send_and_read_finish() returns GLib.Bytes (boxed). Finalizing the CJS boxed
// proxy SEGVs Cinnamon inside GC (core 2026-09-15: BoxedInstanceD2Ev -> g_mutex_lock,
// triggered by a weather query fanning out to 6 concurrent Soup fetches). Reading the
// message through Gio.InputStream (GObject, refcount-safe) + read_line_finish_utf8
// (plain JS string) never puts a boxed type on the JS heap.
//
// Single contract: readSoupMessageText(env, session, msg, cancellable, cb)
//   env: { GLib, Gio } (passed in — this module imports no gi itself, stays node-safe)
//   cb(err, text) exactly once. 10MB body cap. No UI, no provider coupling.
//
// setSoupRequestBodyFromText(env, msg, contentType, bodyStr) -> boolean
//   Boxed-free REQUEST body (2026-09-15): msg.set_request_body_from_bytes needs GLib.Bytes
//   (boxed) and finalizing that proxy SEGVs Cinnamon at GC (BoxedInstanceD2Ev, core 11:02 +
//   11:19 — the LLM POST rides this path on EVERY query, weather included). We instead write
//   the body through Gio.File (GObject, refcount-safe) and hand Soup an owned GInputStream via
//   set_request_body — no boxed type ever lands on the JS heap. Returns true on success; on
//   false the caller MUST abort the request (no Bytes fallback — that is the crash).
(function (globalThis) {
    'use strict';

    const MAX_BODY_CHARS = 10 * 1024 * 1024;

    function readSoupMessageText(env, session, msg, cancellable, cb) {
        if (typeof cb !== 'function') return;
        let done = false;
        const finish = (err, text) => {
            if (done) return; done = true;
            cb(err, text);
        };
        try {
            const GLib = (env && env.GLib) || null;
            const Gio = (env && env.Gio) || null;
            if (!session || typeof session.send_async !== 'function') return finish(new Error('no soup send_async'));
            if (!Gio || typeof Gio.DataInputStream !== 'function') return finish(new Error('no Gio DataInputStream'));
            const prio = (GLib && GLib.PRIORITY_DEFAULT != null) ? GLib.PRIORITY_DEFAULT : 0;
            session.send_async(msg, prio, cancellable || null, (sess, res) => {
                if (done) return;
                let stream = null;
                try { stream = sess.send_finish(res); } catch (e) { return finish(e); }
                if (!stream) return finish(new Error('no response stream'));
                let dis = null;
                try { dis = new Gio.DataInputStream({ base_stream: stream }); }
                catch (e) { try { stream.close_async(prio, null, function () {}); } catch (e2) {} return finish(e); }
                const chunks = [];
                let total = 0;
                const step = () => {
                    if (done) return;
                    try {
                        dis.read_line_async(prio, cancellable || null, (src, res2) => {
                            if (done) return;
                            let line = null;
                            try {
                                const out = src.read_line_finish_utf8(res2);
                                line = (out && out.length) ? out[0] : null;
                            } catch (e) { return finish(e); }
                            if (line === null || typeof line === 'undefined') {
                                try { stream.close_async(prio, null, function () {}); } catch (e) {}
                                return finish(null, chunks.join('\n'));
                            }
                            total += String(line).length + 1;
                            if (total > MAX_BODY_CHARS) {
                                try { stream.close_async(prio, null, function () {}); } catch (e) {}
                                return finish(new Error('body too large'));
                            }
                            chunks.push(line);
                            step();
                        });
                    } catch (e) { finish(e); }
                };
                step();
            });
        } catch (e) { finish(e); }
    }

    function setSoupRequestBodyFromText(env, msg, contentType, bodyStr) {
        try {
            const GLib = (env && env.GLib) || null;
            const Gio = (env && env.Gio) || null;
            if (!msg) return false;
            if (!Gio || !Gio.File) return false;
            if (typeof msg.set_request_body !== 'function') return false;
            const text = String(bodyStr || '');
            if (!text) return false;
            let bytes = null;
            try {
                if (typeof TextEncoder !== 'undefined') bytes = new TextEncoder().encode(text);
                else if (typeof imports !== 'undefined' && imports.byteArray && typeof imports.byteArray.fromString === 'function') bytes = imports.byteArray.fromString(text);
                else { bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xFF; }
            } catch (e) { bytes = null; }
            if (!bytes || bytes.length === 0) return false;
            let tmpPath = '/tmp/qs-body-' + Date.now() + '-' + Math.floor(Math.random() * 1e9) + '.tmp';
            let file = null;
            try { file = Gio.File.new_for_path(tmpPath); } catch (e) { return false; }
            if (!file) return false;
            let flags = 0;
            try { flags = (Gio.FileCreateFlags && Gio.FileCreateFlags.REPLACE_DESTINATION) ? Gio.FileCreateFlags.REPLACE_DESTINATION : 0; } catch (e) {}
            let ok = false;
            try { const r = file.replace_contents(bytes, null, false, flags, null); ok = Array.isArray(r) ? !!r[0] : !!r; } catch (e) { ok = false; }
            if (!ok) return false;
            let stream = null;
            try { stream = file.read(null); } catch (e) { try { file.delete(null); } catch (e2) {} return false; }
            if (!stream) { try { file.delete(null); } catch (e) {} return false; }
            try { msg.set_request_body(contentType, stream, bytes.length); }
            catch (e) { try { stream.close(null); } catch (e2) {} try { file.delete(null); } catch (e3) {} return false; }
            // Keep the stream reachable until Soup has sent the body, then close + delete.
            try { msg._qsBodyStream = stream; msg._qsBodyFile = file; msg._qsBodyPath = tmpPath; } catch (e) {}
            try {
                const doCleanup = () => {
                    try { stream.close(null); } catch (e) {}
                    try { Gio.File.new_for_path(tmpPath).delete(null); } catch (e) {}
                    return (GLib && GLib.SOURCE_REMOVE != null) ? GLib.SOURCE_REMOVE : false;
                };
                if (GLib && typeof GLib.timeout_add === 'function') GLib.timeout_add(GLib.PRIORITY_DEFAULT || 0, 10000, doCleanup);
                else setTimeout(doCleanup, 10000);
            } catch (e) {}
            return true;
        } catch (e) { return false; }
    }

    const mod = { readSoupMessageText: readSoupMessageText, setSoupRequestBodyFromText: setSoupRequestBodyFromText, MAX_BODY_CHARS: MAX_BODY_CHARS };
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (globalThis) globalThis.SoupTextReader = mod;
})(typeof global !== 'undefined' ? global : this);
