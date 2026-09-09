const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { isSettingsApp } = require('../utils.js');

// Discovered membership fixtures: Set<appId> as built by the provider on a
// given machine. Classifier behavior must follow the SET, never names.
const SET_A = new Set(['display.desktop', 'network.desktop']);
const SET_B = new Set(['display.desktop', 'sound.desktop', 'keyboard.desktop']);

test('discovered member -> true, type gate holds', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Display', appId: 'display.desktop' }, SET_A), true);
    assert.equal(isSettingsApp({ type: 'file', title: 'settings.txt', path: '/a' }, SET_A), false);
    assert.equal(isSettingsApp(null, SET_A), false);
    assert.equal(isSettingsApp({}, SET_A), false);
});

test('title containing Settings without membership -> false', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Settings', description: 'Configure your system', appId: 's.desktop' }, new Set()), false);
    assert.equal(isSettingsApp({ type: 'app', title: 'Browser Settings', appId: 'b.desktop' }, SET_A), false);
    assert.equal(isSettingsApp({ type: 'app', title: 'Pengaturan Sistem', appId: 'p.desktop' }, SET_A), false);
});

test('third-party Categories=Settings without membership -> false', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Cool Tweaks', appId: 'cool-tweaks.desktop' }, SET_A), false);
});

test('third-party X-GNOME panel marker without membership -> false', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Firewall Configuration', appId: 'gufw.desktop' }, SET_A), false);
});

test('third-party Settings+HardwareSettings without membership -> false', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Bluetooth Manager', appId: 'blueman-manager.desktop' }, SET_A), false);
    assert.equal(isSettingsApp({ type: 'app', title: 'Disks', appId: 'org.gnome.DiskUtility.desktop' }, SET_A), false);
});

test('membership follows the machine: set A vs set B', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Network', appId: 'network.desktop' }, SET_A), true);
    assert.equal(isSettingsApp({ type: 'app', title: 'Network', appId: 'network.desktop' }, SET_B), false);
    assert.equal(isSettingsApp({ type: 'app', title: 'Sound', appId: 'sound.desktop' }, SET_A), false);
    assert.equal(isSettingsApp({ type: 'app', title: 'Sound', appId: 'sound.desktop' }, SET_B), true);
});

test('no module names or title heuristics in production classifier', () => {
    const src = fs.readFileSync(path.join(__dirname, '../utils.js'), 'utf8');
    const fn = src.slice(src.indexOf('function isSettingsApp'));
    for (const s of ['blueman', 'gufw', 'cinnamon-settings', 'cinnamon-display', 'cinnamon-network',
        'cinnamon-bluetooth', 'cinnamon-color', 'cinnamon-wacom', 'cinnamon-datetime',
        'pengaturan', 'preferensi', "indexOf('settings')", 'Categories', 'HardwareSettings',
        'X-GNOME', 'X-Cinnamon', 'execLine', 'settingsPanel']) {
        assert.ok(!fn.includes(s), 'classifier must not contain: ' + s);
    }
});

test('provider builds membership from local desktop entries, no name list', () => {
    const src = fs.readFileSync(path.join(__dirname, '../providers/appProvider.js'), 'utf8');
    assert.ok(src.includes('getSettingsApps'), 'provider exposes membership');
    assert.ok(src.includes('X-Cinnamon-Settings-Panel'), 'panel signal read at runtime');
    assert.ok(src.includes('cinnamon-settings'), 'exec signal read at runtime');
    for (const s of ['blueman', 'gufw', 'Bluetooth Manager', 'Firewall Configuration', 'SETTINGS_APPS']) {
        assert.ok(!src.includes(s), 'provider must not list modules: ' + s);
    }
});

test('provider discovery: panel/exec entries join, third-party excluded, refresh on installed-changed', () => {
    const origRequire = Module.prototype.require;
    const entries = {
        'display.desktop': { Exec: 'cinnamon-settings display', 'X-Cinnamon-Settings-Panel': 'display' },
        'sound.desktop': { Exec: 'cinnamon-settings sound' },
        'sys-settings.desktop': { Exec: 'env WEBKIT_DISABLE_COMPOSITING_MODE=1 cinnamon-settings' },
        'users.desktop': { Exec: '/usr/bin/cinnamon-settings-users' },
        'network.desktop': { Exec: 'env FOO=bar cinnamon-settings network' },
        'firefox.desktop': { Exec: 'firefox %u' },
        'env-app.desktop': { Exec: 'env some-app' },
        'cool-tweaks.desktop': { Exec: 'cool-tweaks', Categories: 'GNOME;GTK;Settings;' },
        'gufw.desktop': { Exec: 'gufw' },
    };
    const fakeApps = Object.keys(entries).map(id => ({
        get_id: () => id,
        get_name: () => id.replace('.desktop', ''),
        get_description: () => '',
        open_new_window: () => {},
    }));
    let changeCb = null;
    const fakeAppsys = {
        get_all: () => fakeApps,
        connect: (sig, cb) => { changeCb = cb; return 7; },
        disconnect: () => {},
    };
    const fakeInfo = (id) => ({
        get_keywords: () => [],
        get_executable: () => (entries[id].Exec || '').split(' ')[0],
        get_string: (k) => entries[id][k] || '',
        get_icon: () => null,
        has_key: () => false,
    });
    Module.prototype.require = function (rid) {
        if (rid === 'gi.Gio') return { DesktopAppInfo: { new: fakeInfo } };
        if (rid === 'ui.main') return {};
        if (rid === 'gi.Cinnamon') return { AppSystem: { get_default: () => fakeAppsys } };
        return origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve('../providers/appProvider.js')];
    const { createAppProvider } = require('../providers/appProvider.js');
    Module.prototype.require = origRequire;
    const prov = createAppProvider({ makeResult: o => o, scoreResult: () => 1, limits: { app: 5 } });
    const set = prov.getSettingsApps();
    assert.ok(set.has('display.desktop'), 'display discovered');
    assert.ok(set.has('sound.desktop'), 'sound discovered');
    assert.ok(set.has('sys-settings.desktop'), 'env-prefixed cinnamon-settings discovered');
    assert.ok(set.has('users.desktop'), 'absolute-path cinnamon-settings-users discovered');
    assert.ok(set.has('network.desktop'), 'VAR=value-prefixed module discovered');
    assert.ok(!set.has('firefox.desktop'), 'firefox excluded');
    assert.ok(!set.has('env-app.desktop'), 'env third-party excluded');
    assert.ok(!set.has('cool-tweaks.desktop'), 'third-party Settings excluded');
    assert.ok(!set.has('gufw.desktop'), 'gnome-only marker excluded');
    assert.ok(typeof changeCb === 'function', 'installed-changed hooked');
    delete entries['sound.desktop'];
    fakeAppsys.get_all = () => Object.keys(entries).map(id => ({
        get_id: () => id, get_name: () => id, get_description: () => '', open_new_window: () => {},
    }));
    changeCb();
    const set2 = prov.getSettingsApps();
    assert.ok(!set2.has('sound.desktop'), 'membership refreshes after change');
    assert.ok(set2.has('display.desktop'), 'display kept');
    prov.destroy();
    delete require.cache[require.resolve('../providers/appProvider.js')];
});

test('badge + section share one classifier source', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('_isSettingsResult(r)'), 'single classifier helper');
    assert.ok(src.includes('isSettingsRow ? _("Settings") : "App"'), 'badge branch exists');
    assert.ok(!src.includes("typeKey === 'app' && !!utilsMod.isSettingsApp(r)"), 'no direct heuristic call in badge');
});

test('Settings chip present between Folders and Web; _setCategory accepts settings', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('"all", "app", "file", "folder", "settings", "web"'), 'valid list has settings');
    const chipIdx = src.indexOf('const _categories = [');
    const chipBlock = src.slice(chipIdx, chipIdx + 600);
    assert.ok(chipBlock.includes('"settings"'), 'chip added');
    assert.ok(chipBlock.indexOf('"folder"') < chipBlock.indexOf('"settings"') &&
        chipBlock.indexOf('"settings"') < chipBlock.indexOf('"web"'), 'chip order');
});

function sectionGroups(display, set) {
    const best = display[0];
    const appGroup = display.filter(r => {
        if (!r || r.type !== 'app' || r.id === best.id) return false;
        return !isSettingsApp(r, set);
    });
    const settingsGroup = display.filter(r => {
        if (!r || r.id === best.id || r.type !== 'app') return false;
        return isSettingsApp(r, set);
    });
    return { best, appGroup, settingsGroup };
}

test('settings member enters settings section, normal app stays in app', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const disp = makeResult({ type: 'app', title: 'Display', appId: 'display.desktop', score: scoreResult('keyword') });
    const editor = makeResult({ type: 'app', title: 'Text Editor', appId: 'e.desktop', score: scoreResult('keyword') });
    const top = makeResult({ type: 'file', title: 'exact.txt', path: '/a/exact.txt', score: scoreResult('file-exact') });
    const display = [top, disp, editor];
    const { best, appGroup, settingsGroup } = sectionGroups(display, SET_A);
    assert.equal(best.id, top.id);
    assert.deepEqual(settingsGroup.map(r => r.id), [disp.id]);
    assert.deepEqual(appGroup.map(r => r.id), [editor.id]);
});

test('best match settings not duplicated in section', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const disp = makeResult({ type: 'app', title: 'Display', appId: 'display.desktop', score: scoreResult('app-exact') });
    const editor = makeResult({ type: 'app', title: 'Text Editor', appId: 'e.desktop', score: scoreResult('keyword') });
    const display = [disp, editor];
    const { best, appGroup, settingsGroup } = sectionGroups(display, SET_A);
    assert.equal(best.id, disp.id);
    assert.deepEqual(settingsGroup.map(r => r.id), []);
    assert.deepEqual(appGroup.map(r => r.id), [editor.id]);
});

test('file/folder named settings never enter settings section', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const f = makeResult({ type: 'file', title: 'settings.txt', path: '/a/settings.txt', score: scoreResult('file-exact') });
    const { settingsGroup } = sectionGroups([f], new Set(['settings.txt']));
    assert.deepEqual(settingsGroup.map(r => r.id), []);
});

test('underlying result type stays app', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const disp = makeResult({ type: 'app', title: 'Display', appId: 'display.desktop', score: 1 });
    assert.equal(disp.type, 'app');
    assert.equal(isSettingsApp(disp, SET_A), true);
});
