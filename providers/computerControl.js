// ComputerControl (Phase 11): structured pointer/keyboard/window-focus
// injection. NO shell anywhere — fixed-argv subprocess at most (the exact
// pattern fileProvider already uses), or in-process Clutter virtual devices.
//
// Backend picked ONCE at creation:
//   'clutter'  — Clutter.Seat virtual devices inside the Cinnamon process
//   'xdotool'  — installed binary, fixed argv, text after '--'
//   null       — every op returns {error:'input-unavailable'}
//
// Validation is pure and TOTAL before any system effect: coordinates must be
// integers inside screen bounds, keys come from an explicit whitelist
// (no modifier combos this phase), text is capped and control-char free.
// All ops are async with cancellable support; failures surface as FIXED
// error codes only — nothing about the environment is ever logged here.

let Gio = null, GLib = null, Clutter = null;
try { Gio = require('gi.Gio'); GLib = require('gi.GLib'); } catch (e) { /* node */ }
try { Clutter = require('gi.Clutter'); } catch (e) { /* node */ }

const SUBPROCESS_TIMEOUT_MS = 3000;
const MAX_TEXT_CHARS = 500;

// explicit whitelist -> xdotool key name. No modifiers, no combos (Phase 11).
const KEYS = {
    Return: 'Return', Enter: 'Return', Escape: 'Escape', Tab: 'Tab',
    BackSpace: 'BackSpace', Delete: 'Delete',
    Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right',
    Home: 'Home', End: 'End', Page_Up: 'Page_Up', Page_Down: 'Page_Down',
    Space: 'space',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
};

// standard X keysyms for the clutter backend (latin-1 chars map 1:1)
const CLUTTER_KEYSYM = {
    Return: 65293, Escape: 65307, Tab: 65289, BackSpace: 65288,
    Delete: 65535, Up: 65362, Down: 65363, Left: 65350, Right: 65354,
    Home: 65360, End: 65355, Page_Up: 65365, Page_Down: 65366,
    F1: 65470, F2: 65471, F3: 65472, F4: 65473, F5: 65474, F6: 65475,
    F7: 65476, F8: 65477, F9: 65478, F10: 65479, F11: 65480, F12: 65481
};

// pure: null when OK, else fixed error string
function validateKey(key) {
    const k = String(key == null ? '' : key);
    return Object.prototype.hasOwnProperty.call(KEYS, k) ? null : 'invalid-key';
}

// pure: integers strictly inside bounds; zero bounds = no display data yet
function validatePoint(x, y, bounds) {
    const [w, h] = Array.isArray(bounds) ? bounds : [0, 0];
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { error: 'invalid-coordinates' };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'invalid-coordinates' };
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x >= w || y >= h) return { error: 'invalid-coordinates' };
    return null;
}

// pure: cap length, strip control chars (incl. \n \t), keep the rest
function sanitizeText(text) {
    let s = String(text == null ? '' : text)
        .replace(/[\x00-\x1F\x7F]/g, '');
    if (s.length > MAX_TEXT_CHARS) s = s.slice(0, MAX_TEXT_CHARS);
    return s;
}

// pure: {direction, amount} | {error}
function validateScroll(args) {
    const dir = String((args && args.direction) || '');
    if (dir !== 'up' && dir !== 'down') return { error: 'invalid-direction' };
    let amount = args && args.amount;
    if (amount === undefined || amount === null || amount === '') amount = 3;
    if (!Number.isInteger(amount) || amount < 1 || amount > 10) {
        return { error: 'invalid-amount' };
    }
    return { direction: dir, amount: amount };
}

// ---- xdotool fixed-argv builders (pure) ----

function buildClickArgv(x, y, button) {
    const code = button === 'right' ? '3' : button === 'middle' ? '2' : '1';
    return ['xdotool', 'mousemove', '--sync', String(x), String(y), 'click', code];
}
function buildTypeArgv(text) {
    // everything after '--' is literal text, never parsed as options
    return ['xdotool', 'type', '--delay', '12', '--', String(text)];
}
function buildKeyArgv(key) {
    return ['xdotool', 'key', '--', KEYS[key]];
}
function buildScrollArgv(direction, amount) {
    return ['xdotool', 'click', '--repeat', String(amount),
            direction === 'up' ? '4' : '5'];
}

// pure backend picker: clutter preferred (no external binary)
function pickBackend(avail) {
    if (avail.hasClutter) return 'clutter';
    if (avail.hasXdotool) return 'xdotool';
    return null;
}

// ---- async subprocess runner (fixed argv; mirrors fileProvider safety) ----

function runArgv(argv, cancellable, cb) {
    try {
        const proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
        });
        proc.init(null);
        let settled = false;
        const settle = ok => {
            if (settled) return;
            settled = true;
            cb(null, ok);
        };
        const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SUBPROCESS_TIMEOUT_MS, () => {
            try { proc.send_signal(15); } catch (e) {}
            settle(false); // timed out
            return GLib.SOURCE_REMOVE;
        });
        proc.wait_check_async(cancellable, (p, res) => {
            GLib.source_remove(timerId);
            if (settled) return;
            let ok = false;
            try { ok = p.wait_check_finish(res); }
            catch (e) {
                if (/cancel/i.test(String(e.message || ''))) { cb('cancelled'); return; }
                ok = false;
            }
            settle(ok);
        });
    } catch (e) {
        cb({ error: 'input-unavailable' });
    }
}

// ---- factory ----

function createComputerControl(opts) {
    opts = opts || {};
    // host supplies live screen size; [0,0] until first read succeeds
    const getBounds = opts.getBounds || (() => [0, 0]);

    function detectClutter() {
        try {
            if (!Clutter || !Clutter.Seat ||
                typeof Clutter.Seat.prototype.create_virtual_device !== 'function' ||
                !Clutter.InputDeviceType) return false;
            const seat = Clutter.get_default_backend().get_default_seat();
            if (!seat) return false;
            seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            return true;
        } catch (e) { return false; }
    }

    const hasXdootool = !!(GLib && GLib.find_program_in_path &&
                           GLib.find_program_in_path('xdotool'));
    const backend = opts.backend || pickBackend({
        hasClutter: detectClutter(),
        hasXdotool: hasXdootool
    });

    // ---- clutter backend ----

    let vp = null, vk = null;
    function ensureDevices() {
        if (vp) return true;
        try {
            const seat = Clutter.get_default_backend().get_default_seat();
            vp = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            vk = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            return !!(vp && vk);
        } catch (e) { return false; }
    }

    const nowMs = () => (GLib && GLib.get_monotonic_time ? GLib.get_monotonic_time() / 1000 : Date.now());

    function clMoveTo(x, y, cb) {
        try {
            const cur = global.get_pointer(); // [x, y] screen coords
            vp.notify_relative_motion(Math.floor(nowMs()), x - cur[0], y - cur[1]);
            cb(null, true);
        } catch (e) { cb({ error: 'input-unavailable' }); }
    }
    function clButton(button, state, cb) {
        try {
            const code = button === 'right' ? 3 : button === 'middle' ? 2 : 1;
            const pressed = state === 'press';
            vp.notify_button(Math.floor(nowMs()), code,
                pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
            cb(null, true);
        } catch (e) { cb({ error: 'input-unavailable' }); }
    }
    function clType(text, cb) {
        try {
            const t = Math.floor(nowMs());
            for (const ch of text) {
                const code = ch.charCodeAt(0);
                if (code < 32 || code > 126) continue; // non-latin: clutter path limit
                const needsShift = /[A-Z!@#$%^&*()_+{}|:"<>?~]/.test(ch);
                const ks = needsShift ? ch.toLowerCase().charCodeAt(0) : code;
                if (needsShift) vk.notify_key(t, 65505, Clutter.KeyState.PRESSED);
                vk.notify_key(t, ks, Clutter.KeyState.PRESSED);
                vk.notify_key(t, ks, Clutter.KeyState.RELEASED);
                if (needsShift) vk.notify_key(t, 65505, Clutter.KeyState.RELEASED);
            }
            cb(null, true);
        } catch (e) { cb({ error: 'input-unavailable' }); }
    }
    function clKey(key, cb) {
        try {
            const name = KEYS[key];
            const ks = name === 'space' ? 32 : CLUTTER_KEYSYM[name];
            vk.notify_key(Math.floor(nowMs()), ks, Clutter.KeyState.PRESSED);
            vk.notify_key(Math.floor(nowMs()), ks, Clutter.KeyState.RELEASED);
            cb(null, true);
        } catch (e) { cb({ error: 'input-unavailable' }); }
    }
    function clScroll(direction, amount, cb) {
        try {
            const dir = direction === 'up'
                ? Clutter.ScrollDirection.UP : Clutter.ScrollDirection.DOWN;
            for (let i = 0; i < amount; i++) {
                vp.notify_scroll(Math.floor(nowMs()) + i, 0, 0, dir,
                    Clutter.ScrollSource.WHEEL);
            }
            cb(null, true);
        } catch (e) { cb({ error: 'input-unavailable' }); }
    }

    // ---- public ops (backend-agnostic) ----

    function click(x, y, button, cancellable, cb) {
        if (backend === 'clutter') {
            if (!ensureDevices()) { cb({ error: 'input-unavailable' }); return; }
            clMoveTo(x, y, err => {
                if (err) { cb(err); return; }
                clButton(button || 'left', 'press', e2 => {
                    if (e2) { cb(e2); return; }
                    clButton(button || 'left', 'release', e3 => cb(e3 ? e3 : null));
                });
            });
            return;
        }
        if (backend === 'xdotool') {
            runArgv(buildClickArgv(x, y, button), cancellable, (err, ok) => {
                cb(err === 'cancelled' ? { error: 'cancelled' }
                     : err ? err : (ok ? null : { error: 'input-failed' }));
            });
            return;
        }
        cb({ error: 'input-unavailable' });
    }

    function typeText(text, cancellable, cb) {
        if (backend === 'clutter') {
            if (!ensureDevices()) { cb({ error: 'input-unavailable' }); return; }
            clType(text, res => cb(res && res.error ? res : null));
            return;
        }
        if (backend === 'xdotool') {
            runArgv(buildTypeArgv(text), cancellable, (err, ok) => {
                cb(err === 'cancelled' ? { error: 'cancelled' }
                     : err ? err : (ok ? null : { error: 'input-failed' }));
            });
            return;
        }
        cb({ error: 'input-unavailable' });
    }

    function pressKey(key, cancellable, cb) {
        if (backend === 'clutter') {
            if (!ensureDevices()) { cb({ error: 'input-unavailable' }); return; }
            clKey(key, res => cb(res && res.error ? res : null));
            return;
        }
        if (backend === 'xdotool') {
            runArgv(buildKeyArgv(key), cancellable, (err, ok) => {
                cb(err === 'cancelled' ? { error: 'cancelled' }
                     : err ? err : (ok ? null : { error: 'input-failed' }));
            });
            return;
        }
        cb({ error: 'input-unavailable' });
    }

    function scroll(direction, amount, cancellable, cb) {
        if (backend === 'clutter') {
            if (!ensureDevices()) { cb({ error: 'input-unavailable' }); return; }
            clScroll(direction, amount, res => cb(res && res.error ? res : null));
            return;
        }
        if (backend === 'xdotool') {
            runArgv(buildScrollArgv(direction, amount), cancellable, (err, ok) => {
                cb(err === 'cancelled' ? { error: 'cancelled' }
                     : err ? err : (ok ? null : { error: 'input-failed' }));
            });
            return;
        }
        cb({ error: 'input-unavailable' });
    }

    // focus: raise an existing window when possible, else activate the app.
    // AppSystem lookup only — a raw executable can never be started here.
    function focusApp(query, cancellable, cb) {
        try {
            const Cinnamon = require('gi.Cinnamon');
            const Main = require('ui.main');
            const appsys = Cinnamon.AppSystem.get_default();
            const q = String(query == null ? '' : query).trim();
            if (!q) { cb({ error: 'app-not-found' }); return; }
            let app = appsys.lookup_app(q) || null;
            if (!app) {
                const needle = q.toLowerCase();
                for (const a of appsys.get_all(false)) {
                    if (String(a.get_name() || '').toLowerCase().indexOf(needle) !== -1) {
                        app = a; break;
                    }
                }
            }
            if (!app) { cb(null, { focused: false }); return; }
            let win = null;
            try {
                const nameLc = String(app.get_name() || '').toLowerCase();
                for (const wa of global.get_window_actors()) {
                    const mw = wa.meta_window;
                    const ids = [mw.get_gtk_app_id(), mw.get_wm_class()]
                        .map(s => String(s || '').toLowerCase()).filter(Boolean);
                    if (ids.some(id => id.indexOf(nameLc) !== -1 ||
                                       nameLc.indexOf(id) !== -1)) {
                        win = mw; break;
                    }
                }
            } catch (e) { /* window scan optional */ }
            if (win && typeof Main.activateWindow === 'function') {
                Main.activateWindow(win);
                cb(null, { focused: true, mode: 'window', app: app.get_name() });
                return;
            }
            app.activate();
            cb(null, { focused: true, mode: 'app', app: app.get_name() });
        } catch (e) {
            cb({ error: 'input-unavailable' });
        }
    }

    return {
        click, typeText, pressKey, scroll, focusApp,
        backend: backend // exposed for diagnostics only (a short string)
    };
}

module.exports = {
    createComputerControl,
    KEYS, validatePoint, validateKey, sanitizeText, validateScroll,
    buildClickArgv, buildTypeArgv, buildKeyArgv, buildScrollArgv,
    pickBackend, MAX_TEXT_CHARS
};
