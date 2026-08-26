// ScreenCapture (Phase 10): on-demand screenshot via the session bus.
// Native D-Bus contract only — no shell, no continuous capture, nothing
// persisted: PNG lands in a unique temp file, is base64-encoded into a
// data URL, and the file is deleted immediately after reading.
//
// Pure CJS module: gi libs are lazily guarded so node --test can exercise
// the exported pure helpers. The DBus path itself is thin and verified at
// runtime inside Cinnamon (repo pattern: same as aiProvider's Soup default).
//
// Privacy rules enforced here:
//   - capture happens ONLY when called (no timers, no listeners)
//   - temp filename is never logged; failures surface as fixed error codes
//   - the data URL lives in memory until the agent run releases it

let Gio = null, GLib = null;
try { Gio = require('gi.Gio'); GLib = require('gi.GLib'); } catch (e) { /* plain node */ }

const DATA_URL_PREFIX = 'data:image/png;base64,';
const DBUS_TIMEOUT_MS = 8000;

// pure: binary -> base64 (Buffer in node, chunked btoa in GJS)
function bytesToBase64(u8) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
        return Buffer.from(u8).toString('base64');
    }
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
}

// pure: enforce the shared image ceiling before anything else touches it
function imageWithinLimits(dataUrl, maxChars) {
    return typeof dataUrl === 'string' &&
        dataUrl.lastIndexOf(DATA_URL_PREFIX, 0) === 0 &&
        dataUrl.length <= maxChars;
}

// Cinnamon implements the org.gnome.Shell.Screenshot D-Bus API; older
// builds expose it under org.Cinnamon.Screenshot. Try both, prefer shell.
const SERVICES = [
    { name: 'org.gnome.Shell.Screenshot', path: '/org/gnome/Shell/Screenshot' },
    { name: 'org.Cinnamon.Screenshot', path: '/org/Cinnamon/Screenshot' }
];

function createScreenCapture(opts) {
    opts = opts || {};
    const timeoutMs = Number(opts.timeoutMs) || DBUS_TIMEOUT_MS;

    // unique temp path per capture — collisions impossible across runs/users
    function tmpPath() {
        return GLib.get_tmp_dir() + '/quicksearch-shot-' +
            GLib.uuid_string_random() + '.png';
    }

    function proxyFor(service, cancellable, cb) {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
            null, service.name, service.path, service.name,
            cancellable, (src, res) => {
                try { cb(null, Gio.DBusProxy.new_for_bus_finish(res)); }
                catch (e) { cb(e); }
            });
    }

    // shoot(proxy, path, cancellable, cb): cb(err|falsy, okBool)
    function shoot(proxy, filePath, cancellable, cb) {
        proxy.call('Screenshot',
            new GLib.Variant('(bbs)', [false, false, filePath]),
            Gio.DBusCallFlags.NONE, timeoutMs, cancellable, (p, res) => {
                if (cancellable && cancellable.is_cancelled()) { cb('cancelled'); return; }
                try {
                    const [ok] = p.call_finish(res).deepUnpack();
                    cb(null, !!ok);
                } catch (e) { cb(e); }
            });
    }

    function readAndEncode(filePath, cancellable, done) {
        const file = Gio.File.new_for_path(filePath);
        file.load_contents_async(cancellable, (f, res) => {
            let bytes = null;
            try {
                const [ok, data] = f.load_contents_finish(res);
                if (ok) bytes = data;
            } catch (e) { /* read raced with cleanup: treat as failure */ }
            // transient guarantee: delete FIRST, success or not, before encoding
            try { file.delete(null); } catch (e2) { /* best-effort */ }
            if (!bytes) { done({ error: 'screenshot-unavailable' }); return; }
            done(null, DATA_URL_PREFIX + bytesToBase64(bytes));
        });
    }

    // capture(cancellable, cb): cb(err|null, dataUrl|null)
    // err codes only: 'cancelled' | {error:'screenshot-unavailable'}
    function capture(cancellable, cb) {
        if (!Gio || !GLib) { cb({ error: 'screenshot-unavailable' }); return; }
        const target = tmpPath();
        const tryService = i => {
            if (cancellable && cancellable.is_cancelled()) { cb({ error: 'cancelled' }); return; }
            if (i >= SERVICES.length) { cb({ error: 'screenshot-unavailable' }); return; }
            proxyFor(SERVICES[i], cancellable, (err, proxy) => {
                if (err) { tryService(i + 1); return; }
                shoot(proxy, target, cancellable, (err2, ok) => {
                    if (err2 === 'cancelled') { cleanup(); cb({ error: 'cancelled' }); return; }
                    if (err2 || !ok) {
                        cleanup();
                        tryService(i + 1);
                        return;
                    }
                    readAndEncode(target, cancellable, (err3, dataUrl) => {
                        if (cancellable && cancellable.is_cancelled()) { cb({ error: 'cancelled' }); return; }
                        if (err3) { cb(err3); return; }
                        cb(null, dataUrl);
                    });
                });
            });
        };
        // safety net: the temp file must never outlive this call chain
        const cleanup = () => { try { Gio.File.new_for_path(target).delete(null); } catch (e) {} };
        tryService(0);
    }

    return { capture: capture };
}

module.exports = {
    createScreenCapture,
    bytesToBase64,
    imageWithinLimits,
    DATA_URL_PREFIX
};
