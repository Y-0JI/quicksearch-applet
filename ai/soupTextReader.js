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

    const mod = { readSoupMessageText: readSoupMessageText, MAX_BODY_CHARS: MAX_BODY_CHARS };
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (globalThis) globalThis.SoupTextReader = mod;
})(typeof global !== 'undefined' ? global : this);
