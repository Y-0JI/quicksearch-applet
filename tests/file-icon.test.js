const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const origRequire = Module.prototype.require;

// ── controllable mock state ────────────────────────────────────────────────
let currentStdout = '';
let fileTypeMap = new Map(); // path -> FileType
let brokenSet = new Set();
let lastFlags = [];
let mimeIconOverride = null; // if set, content_type_get_icon returns this

const GioMock = {
    FileType: { UNKNOWN: 0, REGULAR: 1, DIRECTORY: 2, SYMBOLIC_LINK: 3 },
    FileQueryInfoFlags: { NONE: 0, FOLLOW_SYMLINKS: 1 },
    SubprocessFlags: { STDOUT_PIPE: 1, STDERR_SILENCE: 2 },
    File: {
        new_for_path(p) {
            return {
                query_file_type(flags) {
                    lastFlags.push(flags);
                    if (brokenSet.has(p)) throw new Error('not found: ' + p);
                    if (fileTypeMap.has(p)) return fileTypeMap.get(p);
                    // default: regular file for unknown paths
                    return GioMock.FileType.REGULAR;
                },
                query_info(attr, flags) {
                    lastFlags.push(flags);
                    if (brokenSet.has(p)) throw new Error('not found: ' + p);
                    const t = fileTypeMap.has(p) ? fileTypeMap.get(p) : GioMock.FileType.REGULAR;
                    return { get_file_type: () => t };
                },
                query_exists() { return !brokenSet.has(p); },
                get_uri() { return 'file://' + p; }
            };
        }
    },
    content_type_guess(p) {
        if (p.endsWith('.txt')) return ['text/plain', false];
        if (p.endsWith('.json')) return ['application/json', false];
        if (p.endsWith('.png')) return ['image/png', false];
        return ['application/octet-stream', false];
    },
    content_type_get_icon(type) {
        if (mimeIconOverride !== null) return mimeIconOverride;
        // broken paths simulate no icon -> fallback
        // caller handles path-based, but we use type; for broken test we set override to null
        return { toString: () => 'themed:' + type, _mime: type };
    },
    AppInfo: { launch_default_for_uri_async() {} },
    Subprocess: function (opts) {
        this.argv = opts.argv;
        this.init = () => {};
        this.send_signal = () => {};
        this.force_exit = () => {};
        this.communicate_utf8_async = (stdin, canc, cb) => {
            const obj = { communicate_utf8_finish: () => [true, currentStdout] };
            cb(obj, null);
        };
    },
    Cancellable: function () { this.is_cancelled = () => false; this.cancel = () => {}; }
};

const GLibMock = {
    PRIORITY_DEFAULT: 0,
    SOURCE_REMOVE: 0,
    find_program_in_path: () => '/usr/bin/plocate',
    get_home_dir: () => '/home/yoji',
    basename: (p) => path.posix.basename(p),
    path_get_dirname: (p) => path.posix.dirname(p),
    timeout_add: () => 1,
    source_remove: () => {},
    Bytes: function () {}
};

Module.prototype.require = function (id) {
    if (id === 'gi.Gio') return GioMock;
    if (id === 'gi.GLib') return GLibMock;
    return origRequire.apply(this, arguments);
};

// reload fileProvider with mocks — Gio captured in closure, restore global afterwards
delete require.cache[require.resolve('../providers/fileProvider.js')];
const { createFileProvider } = require('../providers/fileProvider.js');
Module.prototype.require = origRequire;

after(() => {
    // restore original require for any later consumers; delete mocked cache entry
    Module.prototype.require = origRequire;
    delete require.cache[require.resolve('../providers/fileProvider.js')];
});

function reset() {
    currentStdout = '';
    fileTypeMap = new Map();
    brokenSet = new Set();
    lastFlags = [];
    mimeIconOverride = null;
}

function makeHelpers() {
    return {
        makeResult: o => o,
        scoreResult: () => 1,
        pickFileBackend: () => 'plocate',
        sanitizeGlob: s => String(s).replace(/[\\*?\[\]]/g, ''),
        locations: ['/home/yoji'],
        timeoutMs: 4000
    };
}

function searchSync(provider, query, stdout) {
    currentStdout = stdout;
    let out = null;
    provider.search(query, { is_cancelled: () => false }, list => { out = list; });
    return out;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('directory → folder-symbolic', () => {
    reset();
    fileTypeMap.set('/home/yoji/.local', GioMock.FileType.DIRECTORY);
    fileTypeMap.set('/home/yoji/site.local', GioMock.FileType.DIRECTORY);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'local', '/home/yoji/.local\n/home/yoji/site.local\n');
    assert.equal(res.length, 2);
    assert.equal(res[0].icon, 'folder-symbolic');
    assert.equal(res[1].icon, 'folder-symbolic');
    // FOLLOW_SYMLINKS must be used
    assert.ok(lastFlags.every(f => f === GioMock.FileQueryInfoFlags.FOLLOW_SYMLINKS));
});

test('symlink → directory → folder-symbolic (FOLLOW_SYMLINKS)', () => {
    reset();
    fileTypeMap.set('/tmp/link-to-dir', GioMock.FileType.DIRECTORY);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'link', '/tmp/link-to-dir\n');
    assert.equal(res.length, 1);
    assert.equal(res[0].icon, 'folder-symbolic');
});

test('regular file → MIME GIcon (not generic, not folder)', () => {
    reset();
    fileTypeMap.set('/home/yoji/document.txt', GioMock.FileType.REGULAR);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'doc', '/home/yoji/document.txt\n');
    assert.equal(res.length, 1);
    assert.ok(typeof res[0].icon === 'object', 'MIME should be GIcon object');
    assert.equal(res[0].icon._mime, 'text/plain');
});

test('symlink → regular file → MIME GIcon', () => {
    reset();
    fileTypeMap.set('/tmp/link-to-file.txt', GioMock.FileType.REGULAR);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'link', '/tmp/link-to-file.txt\n');
    assert.equal(res.length, 1);
    assert.ok(typeof res[0].icon === 'object');
    assert.equal(res[0].icon._mime, 'text/plain');
});

test('broken/missing → text-x-generic-symbolic', () => {
    reset();
    brokenSet.add('/tmp/broken-link');
    mimeIconOverride = null; // content_type_get_icon returns null for broken
    // override to return null for this test
    const origGetIcon = GioMock.content_type_get_icon;
    GioMock.content_type_get_icon = () => null;
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'broken', '/tmp/broken-link\n');
    assert.equal(res.length, 1);
    assert.equal(res[0].icon, 'text-x-generic-symbolic');
    GioMock.content_type_get_icon = origGetIcon;
});

test('missing path with MIME fallback disabled → generic', () => {
    reset();
    brokenSet.add('/nonexistent/file.xyz');
    const origGetIcon = GioMock.content_type_get_icon;
    GioMock.content_type_get_icon = () => null;
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'file', '/nonexistent/file.xyz\n');
    assert.equal(res[0].icon, 'text-x-generic-symbolic');
    GioMock.content_type_get_icon = origGetIcon;
});

test('mixed files and folders in one result set', () => {
    reset();
    fileTypeMap.set('/home/yoji/.local', GioMock.FileType.DIRECTORY);
    fileTypeMap.set('/home/yoji/document.txt', GioMock.FileType.REGULAR);
    fileTypeMap.set('/home/yoji/image.png', GioMock.FileType.REGULAR);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'yoji', '/home/yoji/.local\n/home/yoji/document.txt\n/home/yoji/image.png\n');
    assert.equal(res[0].icon, 'folder-symbolic');
    assert.ok(typeof res[1].icon === 'object' && res[1].icon._mime === 'text/plain');
    assert.ok(typeof res[2].icon === 'object' && res[2].icon._mime === 'image/png');
});

test('folder detection not based on trailing slash', () => {
    reset();
    // no trailing slash, but still directory
    fileTypeMap.set('/home/yoji/.local', GioMock.FileType.DIRECTORY);
    const prov = createFileProvider(makeHelpers());
    const res = searchSync(prov, 'local', '/home/yoji/.local\n');
    assert.equal(res[0].path, '/home/yoji/.local');
    assert.equal(res[0].icon, 'folder-symbolic');
});
