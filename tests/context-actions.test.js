const { test } = require('node:test');
const assert = require('node:assert');
const { getContextActions } = require('../providers/contextActions.js');

// helpers to build env
function appEnv(over = {}) {
    const calls = [];
    return {
        _calls: calls,
        canUninstall: true,
        getUserDesktopDir: () => '/home/yoji/Desktop',
        getAppFilename: () => '/usr/share/applications/firefox.desktop',
        isFavorite: () => false,
        addFavorite: (id) => calls.push(['addFavorite', id]),
        removeFavorite: (id) => calls.push(['removeFavorite', id]),
        ensurePanelLauncher: () => calls.push(['ensurePanelLauncher']),
        acceptNewLauncher: (id) => calls.push(['acceptNewLauncher', id]),
        acceptNewLauncherWithRetry: (id) => calls.push(['acceptNewLauncherWithRetry', id]),
        copyToDesktop: () => calls.push(['copyToDesktop']),
        uninstallApp: () => calls.push(['uninstallApp']),
        openFileLocation: () => true,
        addFileToDesktop: () => calls.push(['addFileToDesktop']),
        ...over
    };
}

// ── app: correct 4 actions + native icons + appId ───────────────────────
test('app → 4 native actions when eligible', () => {
    const env = appEnv();
    const res = { type: 'app', appId: 'firefox.desktop', title: 'Firefox' };
    const acts = getContextActions(res, env);
    assert.equal(acts.length, 4);
    const ids = acts.map(a => a.id);
    assert.deepEqual(ids, ['add_to_panel', 'add_to_desktop', 'add_to_favorites', 'uninstall']);
    assert.equal(acts[0].iconName, 'xsi-list-add');
    assert.equal(acts[1].iconName, 'xsi-computer');
    assert.equal(acts[2].iconName, 'xsi-non-starred');
    assert.equal(acts[3].iconName, 'xsi-edit-delete');
    // run uses appId, not title
    acts[0].run();
    assert.ok(env._calls.some(c => c[0] === 'acceptNewLauncherWithRetry' && c[1] === 'firefox.desktop'));
});

test('app: uninstall hidden when cannot uninstall', () => {
    const env = appEnv({ canUninstall: false });
    const acts = getContextActions({ type: 'app', appId: 'firefox.desktop' }, env);
    assert.ok(!acts.some(a => a.id === 'uninstall'));
    assert.equal(acts.length, 3);
});

test('app: add_to_desktop hidden when desktopDir null', () => {
    const env = appEnv({ getUserDesktopDir: () => null });
    const acts = getContextActions({ type: 'app', appId: 'firefox.desktop' }, env);
    assert.ok(!acts.some(a => a.id === 'add_to_desktop'));
});

test('app: add_to_desktop hidden when filename null', () => {
    const env = appEnv({ getAppFilename: () => null });
    const acts = getContextActions({ type: 'app', appId: 'firefox.desktop' }, env);
    assert.ok(!acts.some(a => a.id === 'add_to_desktop'));
    assert.ok(!acts.some(a => a.id === 'uninstall'));
});

test('app: missing appId → []', () => {
    assert.deepEqual(getContextActions({ type: 'app', appId: '' }, appEnv()), []);
    assert.deepEqual(getContextActions({ type: 'app' }, appEnv()), []);
});

// ── favorites toggle ─────────────────────────────────────────────────────
test('app favorites toggle: not favorite → Add, favorite → Remove + icon swap', () => {
    const notFav = appEnv({ isFavorite: () => false });
    const acts1 = getContextActions({ type: 'app', appId: 'a.desktop' }, notFav);
    const favItem1 = acts1.find(a => a.id === 'add_to_favorites');
    assert.ok(favItem1);
    assert.equal(favItem1.label, 'Add to favorites');
    assert.equal(favItem1.iconName, 'xsi-non-starred');
    favItem1.run();
    assert.ok(notFav._calls.some(c => c[0] === 'addFavorite'));

    const isFav = appEnv({ isFavorite: () => true });
    const acts2 = getContextActions({ type: 'app', appId: 'a.desktop' }, isFav);
    const favItem2 = acts2.find(a => a.id === 'remove_from_favorites');
    assert.ok(favItem2);
    assert.equal(favItem2.label, 'Remove from favorites');
    assert.equal(favItem2.iconName, 'xsi-starred');
    favItem2.run();
    assert.ok(isFav._calls.some(c => c[0] === 'removeFavorite'));
});

// ── file: open_location native ───────────────────────────────────────────
test('file → open_location with folder icon', () => {
    const env = appEnv({ getUserDesktopDir: () => null });
    // hide panel/favorites to isolate open_location
    env.filePanelSupported = false;
    env.fileFavoritesSupported = false;
    delete env.addFileToDesktop;
    const acts = getContextActions({ type: 'file', path: '/home/yoji/docs/report.pdf' }, env);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].id, 'open_location');
    assert.equal(acts[0].label, 'Open file location');
    assert.equal(acts[0].iconName, 'folder-symbolic');
});

test('file → with desktop/panel/favorites when supported', () => {
    const env = appEnv(); // has addFileToDesktop + defaults filePanelSupported not false
    env.filePanelSupported = true;
    env.fileFavoritesSupported = true;
    env.addFileToPanel = () => env._calls.push(['addFileToPanel']);
    env.addFileToFavorites = () => env._calls.push(['addFileToFavorites']);
    const acts = getContextActions({ type: 'file', path: '/home/yoji/file.txt' }, env);
    const ids = acts.map(a => a.id);
    assert.ok(ids.includes('open_location'));
    assert.ok(ids.includes('add_to_desktop'));
    assert.ok(ids.includes('add_to_panel'));
    assert.ok(ids.includes('add_to_favorites'));
});

test('file: missing path → []', () => {
    assert.deepEqual(getContextActions({ type: 'file', path: '' }, appEnv()), []);
});

// ── type isolation ───────────────────────────────────────────────────────
test('type isolation: app never gets open_location, file never gets uninstall', () => {
    const env = appEnv();
    const appActs = getContextActions({ type: 'app', appId: 'a.desktop' }, env);
    assert.ok(!appActs.some(a => a.id === 'open_location'));
    const fileActs = getContextActions({ type: 'file', path: '/tmp/a.txt' }, env);
    assert.ok(!fileActs.some(a => a.id === 'uninstall'));
});

test('web/url/calc/history/suggestion → []', () => {
    const env = appEnv();
    for (const t of ['web', 'url', 'calc', 'history', 'suggestion', 'unknown']) {
        assert.deepEqual(getContextActions({ type: t, title: 'x' }, env), [], t + ' should be []');
    }
});

test('null/undefined result → []', () => {
    assert.deepEqual(getContextActions(null, appEnv()), []);
    assert.deepEqual(getContextActions(undefined, appEnv()), []);
    assert.deepEqual(getContextActions({}, appEnv()), []);
});

// ── security: nasty paths never become shell ─────────────────────────────
test('nasty paths stay as data, not shell (no injection via run)', () => {
    const nasty = [
        '/home/user/test file.txt',
        '/home/user/a;b.txt',
        '/home/user/$(whoami).txt',
        '/home/user/`whoami`.txt',
        '/home/user/"quoted".txt',
        '/home/user/unicode — café.txt'
    ];
    for (const p of nasty) {
        const calls = [];
        const env = {
            getUserDesktopDir: () => '/tmp/Desktop',
            openFileLocation: (arg) => { calls.push(arg); return true; },
            addFileToDesktop: (arg) => calls.push('desktop:' + arg),
            addFileToPanel: () => {},
            addFileToFavorites: () => {}
        };
        const acts = getContextActions({ type: 'file', path: p }, env);
        // open_location must exist and its run must pass raw path, not shell-escaped concat
        const openAct = acts.find(a => a.id === 'open_location');
        assert.ok(openAct, 'open_location for ' + p);
        // action run should forward exact p
        const before = calls.length;
        openAct.run();
        assert.equal(calls[calls.length - 1], p, 'path forwarded verbatim for ' + p);
        // ensure no shell metachars were interpreted — helper itself does Gio, not shell
        assert.ok(!String(calls[calls.length - 1]).includes('whoami') || p.includes('whoami'), 'no expansion');
    }
});

test('app nasty appId is not interpolated into shell by helper', () => {
    const env = appEnv();
    // helper should treat appId as opaque id passed to acceptNewLauncher, not shell string
    const evilId = 'evil; rm -rf /.desktop';
    const acts = getContextActions({ type: 'app', appId: evilId }, env);
    acts[0].run();
    assert.ok(env._calls.some(c => c[1] === evilId), 'appId passed verbatim');
});

test('actions never throw', () => {
    const env = {
        canUninstall: true,
        getUserDesktopDir: () => { throw new Error('boom'); },
        getAppFilename: () => { throw new Error('boom'); },
        isFavorite: () => { throw new Error('boom'); }
    };
    assert.doesNotThrow(() => getContextActions({ type: 'app', appId: 'a.desktop' }, env));
    assert.doesNotThrow(() => getContextActions({ type: 'file', path: '/tmp/a.txt' }, {}));
});
