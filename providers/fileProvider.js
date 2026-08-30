// File search: plocate/locate/find chain, async subprocess, cancellation,
// timeout, cache. Guardrails: limit applied by READER for find (no -quit);
// argv verified per-backend; cancellable owned by engine, passed in.
const Gio = require('gi.Gio');
const GLib = require('gi.GLib');

const MAX_CANDIDATES = 200;   // parsed from subprocess output
const SUBPROCESS_TIMEOUT_MS = 4000;
const CACHE_MAX = 50;

function createFileProvider(helpers) {
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    const pickFileBackend = helpers.pickFileBackend;
    const sanitizeGlob = helpers.sanitizeGlob;
    const locations = (helpers.locations && helpers.locations.length) ? helpers.locations : [GLib.get_home_dir()];
    const timeoutMs = helpers.timeoutMs || SUBPROCESS_TIMEOUT_MS;

    // backend detection ONCE at init (spec §5)
    const avail = {
        hasPlocate: !!GLib.find_program_in_path('plocate'),
        hasLocate: !!GLib.find_program_in_path('locate'),
        hasFind: !!GLib.find_program_in_path('find')
    };
    const backend = pickFileBackend(avail);

    const cache = new Map(); // key "query|loc0|backend" -> results array

    function search(query, cancellable, onDone) {
        if (!backend || !query || !query.trim()) { onDone([]); return; }

        const key = query + '|' + locations[0] + '|' + backend;
        if (cache.has(key)) {
            onDone(cache.get(key));
            return;
        }

        const argv = _buildArgv(query);
        if (!argv) { onDone([]); return; }

        try {
            const proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            });
            proc.init(null);
            let settled = false;
            const settle = (fn, arg) => {
                if (settled) return;   // exactly-once callback
                settled = true;
                fn(arg);
            };

            const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                // cancel() alone leaves the child running as an orphan -> kill it
                try { cancellable.cancel(); } catch (e) {}
                try { proc.send_signal(15); } catch (e) {}
                return GLib.SOURCE_REMOVE;
            });

            proc.communicate_utf8_async(null, cancellable, (obj, res) => {
                GLib.source_remove(timerId);
                if (!settled && cancellable.is_cancelled()) {
                    try { proc.force_exit(); } catch (e2) {}
                    settle(onDone, []);  // timed out / superseded: empty flush
                    return;
                }
                try {
                    const [, stdout] = obj.communicate_utf8_finish(res);
                    if (cancellable.is_cancelled()) { settle(onDone, []); return; }
                    const results = _parse(stdout, query);
                    _cachePut(key, results);
                    settle(onDone, results);
                } catch (e) {
                    settle(onDone, []);
                }
            });
        } catch (e) {
            onDone([]);
        }
    }

    function _buildArgv(query) {
        switch (backend) {
            case 'plocate':
                // newline output: GJS truncates NUL-delimited streams at first \0
                return ['plocate', '-n', String(MAX_CANDIDATES), '-i', '--', query];
            case 'locate':
                return ['locate', '-i', '-l', String(MAX_CANDIDATES), '--', query];
            case 'find': {
                // guardrail 1: NO -quit; reader applies the cap.
                const args = ['find'];
                for (let i = 0; i < locations.length; i++) args.push(locations[i]);
                args.push('-xdev', '-maxdepth', '5', '-iname', '*' + sanitizeGlob(query) + '*');
                return args;
            }
            default:
                return null;
        }
    }

    function _parse(stdout, query) {
        // newline-separated for all backends (NUL output truncates in GJS strings)
        let paths = stdout.split('\n').filter(p => p.length > 0);
        if (paths.length > MAX_CANDIDATES) paths = paths.slice(0, MAX_CANDIDATES); // guardrail 1

        const q = String(query).toLowerCase();
        const scored = [];
        for (let i = 0; i < paths.length; i++) {
            const p = paths[i];
            const base = GLib.basename(p).toLowerCase();
            let quality = null;
            if (base === q) quality = 'file-exact';
            else if (base.indexOf(q) === 0) quality = 'file-prefix';
            else quality = 'file-contains';

            scored.push(makeResult({
                type: 'file',
                title: GLib.basename(p) || p,
                description: GLib.path_get_dirname(p),
                icon: _iconForPath(p),
                path: p.replace(/\/+$/, '') || '/',
                score: scoreResult(quality),
                action: () => _openPath(p)
            }));
        }
        return scored;
    }

    function _cachePut(key, value) {
        if (cache.size >= CACHE_MAX) {
            const firstKey = cache.keys().next().value; // FIFO evict
            cache.delete(firstKey);
        }
        cache.set(key, value);
    }

    function destroy() {
        cache.clear();
    }

    return { search, destroy };
}

function _iconForPath(path) {
    try {
        const f = Gio.File.new_for_path(path);
        let t;
        try {
            t = f.query_file_type(Gio.FileQueryInfoFlags.FOLLOW_SYMLINKS, null);
        } catch (e) {
            const info = f.query_info('standard::type', Gio.FileQueryInfoFlags.FOLLOW_SYMLINKS, null);
            t = info.get_file_type();
        }
        if (t === Gio.FileType.DIRECTORY) return 'folder-symbolic';
    } catch (e) {}
    try {
        const [type] = Gio.content_type_guess(path, null, 0);
        const icon = Gio.content_type_get_icon(type);
        if (icon) return icon;
    } catch (e) {}
    return 'text-x-generic-symbolic';
}

// shared with the open_file tool (Phase 8): true when the path existed and a
// launch was attempted, false otherwise. Kept native — no shell.
function _openPath(path) {
    try {
        const clean = path.replace(/\/+$/, '') || '/';
        if (!Gio.File.new_for_path(clean).query_exists(null)) return false; // spec 24-G
        Gio.AppInfo.launch_default_for_uri_async(Gio.File.new_for_path(clean).get_uri(), null, null, null);
        return true;
    } catch (e) { return false; } // never crash applet (spec §18/24-K)
}

module.exports = { createFileProvider, openPath: _openPath };
