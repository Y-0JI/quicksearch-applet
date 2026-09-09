const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isSettingsApp } = require('../utils.js');

test('settings app true', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Settings', description: 'Configure your system' }), true);
});

test('normal app false', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Text Editor', description: 'Simple text editor' }), false);
});

test('file named settings false', () => {
    assert.equal(isSettingsApp({ type: 'file', title: 'settings.txt', description: '' }), false);
});

test('indonesian pengaturan true', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Pengaturan Sistem', description: '' }), true);
});

test('preferensi true', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Preferensi Desktop', description: '' }), true);
});

test('normal queries no accidental match', () => {
    const normals = [
        ['firefox.desktop', 'Firefox Web Browser', 'firefox %u', 'GNOME;GTK;Network;WebBrowser;'],
        ['org.gnome.Terminal.desktop', 'Terminal', 'gnome-terminal', 'GNOME;GTK;System;TerminalEmulator;'],
        ['nemo.desktop', 'Files', 'nemo %U', 'GNOME;GTK;Utility;Core;'],
        ['org.gnome.Calculator.desktop', 'Calculator', 'gnome-calculator', 'GNOME;GTK;Utility;Calculator;'],
        ['xed.desktop', 'Text Editor', 'xed', 'GNOME;GTK;Utility;TextEditor;'],
    ];
    for (const [id, t, ex, cats] of normals) {
        assert.equal(isSettingsApp({ type: 'app', title: t, description: 'x', appId: id, execLine: ex, categories: cats }), false, t);
    }
    assert.equal(isSettingsApp(null), false);
    assert.equal(isSettingsApp({}), false);
});

test('third-party generic Categories=Settings stays App (not discovered)', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Cool Tweaks', description: 'tweak stuff', appId: 'cool-tweaks.desktop', execLine: 'cool-tweaks', categories: 'GNOME;GTK;Settings;' }), false);
    assert.equal(isSettingsApp({ type: 'file', title: 'settings.txt', path: '/a', categories: 'Settings;' }), false);
});

test('utility with Settings marker stays App (Disks guard)', () => {
    assert.equal(isSettingsApp({ type: 'app', title: 'Disks', description: 'Manage Drives', appId: 'org.gnome.DiskUtility.desktop', execLine: 'gnome-disks', categories: 'GNOME;GTK;Utility;X-GNOME-Utilities;Settings;HardwareSettings;' }), false);
});

test('cinnamon settings modules classified via runtime desktop-entry signals', () => {
    const mods = [
        ['cinnamon-settings.desktop', 'System Settings', 'env WEBKIT_DISABLE_COMPOSITING_MODE=1 cinnamon-settings', '', '', 'Settings;'],
        ['cinnamon-display-panel.desktop', 'Display', 'cinnamon-settings display', 'display', '', 'GTK;Settings;HardwareSettings;X-Cinnamon-Settings-Panel;'],
        ['cinnamon-network-panel.desktop', 'Network', 'cinnamon-settings network', 'network', '', 'GTK;Settings;HardwareSettings;X-Cinnamon-Settings-Panel;'],
        ['cinnamon-settings-sound.desktop', 'Sound', 'cinnamon-settings sound', '', '', 'Settings;'],
        ['cinnamon-settings-keyboard.desktop', 'Keyboard', 'cinnamon-settings keyboard', '', '', 'Settings;'],
        ['cinnamon-settings-mouse.desktop', 'Mouse and Touchpad', 'cinnamon-settings mouse', '', '', 'Settings;'],
        ['cinnamon-settings-power.desktop', 'Power Management', 'cinnamon-settings power', '', '', 'Settings;'],
        ['cinnamon-settings-users.desktop', 'Users and Groups', 'cinnamon-settings-users', '', '', 'System;Settings;'],
        ['cinnamon-settings-calendar.desktop', 'Date & Time', 'cinnamon-settings calendar', '', '', 'Settings;'],
        ['cinnamon-settings-privacy.desktop', 'Privacy', 'cinnamon-settings privacy', '', '', 'Settings;'],
        ['cinnamon-settings-panel.desktop', 'Panel', 'cinnamon-settings panel', '', '', 'Settings;'],
        ['gufw.desktop', 'Firewall Configuration', 'gufw', 'gufw', '1', 'GNOME;GTK;Settings;Security;X-GNOME-Settings-Panel;X-GNOME-SystemSettings;'],
        ['blueman-manager.desktop', 'Bluetooth Manager', 'blueman-manager', '', '', 'GTK;GNOME;Settings;HardwareSettings;'],
    ];
    for (const [id, title, ex, sp, gs, cats] of mods) {
        assert.equal(isSettingsApp({ type: 'app', title, description: 'x', appId: id, execLine: ex, settingsPanel: sp, gnomePanel: gs, gnomeSystem: gs, categories: cats }), true, title);
    }
});

test('classification follows discovered membership, not hardcoded names', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../utils.js'), 'utf8');
    const fn = src.slice(src.indexOf('function isSettingsApp'));
    assert.ok(!fn.includes('blueman') && !fn.includes('gufw') && !fn.includes('Bluetooth Manager') && !fn.includes('Firewall Configuration'), 'no module names in classifier');
});

test('settings section badge uses localized Settings, normal app stays App', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('isSettingsRow ? _("Settings") : "App"'), 'badge branch exists');
    assert.ok(src.includes("typeKey === 'app' && !!utilsMod.isSettingsApp(r)"), 'badge gated on app type');
});

test('production wiring: applet uses utilsMod.isSettingsApp + settings category', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('utilsMod.isSettingsApp'), 'applet calls production helper');
    assert.ok(src.includes('"all", "app", "file", "folder", "settings", "web"'), 'valid list has settings');
    assert.ok(src.includes("cat === 'settings'"), 'filter branch exists');
    const chipIdx = src.indexOf('const _categories = [');
    const chipSection = src.slice(chipIdx, chipIdx + 600);
    assert.ok(!chipSection.includes('"settings"'), 'no chip added');
});

function sectionGroups(display) {
    const best = display[0];
    const appGroup = display.filter(r => {
        if (!r || r.type !== 'app' || r.id === best.id) return false;
        return !isSettingsApp(r);
    });
    const settingsGroup = display.filter(r => {
        if (!r || r.id === best.id || r.type !== 'app') return false;
        return isSettingsApp(r);
    });
    return { best, appGroup, settingsGroup };
}

test('settings app enters settings section, normal app stays in app', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const setApp = makeResult({ type: 'app', title: 'Settings', description: 'Configure your system', appId: 's.desktop', score: scoreResult('keyword') });
    const editor = makeResult({ type: 'app', title: 'Text Editor', description: 'Simple text editor', appId: 'e.desktop', score: scoreResult('keyword') });
    const top = makeResult({ type: 'file', title: 'exact.txt', path: '/a/exact.txt', score: scoreResult('file-exact') });
    const display = [top, setApp, editor];
    const { best, appGroup, settingsGroup } = sectionGroups(display);
    assert.equal(best.id, top.id);
    assert.deepEqual(settingsGroup.map(r => r.id), [setApp.id]);
    assert.deepEqual(appGroup.map(r => r.id), [editor.id]);
});

test('best match settings not duplicated in section', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const setApp = makeResult({ type: 'app', title: 'Settings', description: 'Configure your system', appId: 's.desktop', score: scoreResult('app-exact') });
    const editor = makeResult({ type: 'app', title: 'Text Editor', description: 'x', appId: 'e.desktop', score: scoreResult('keyword') });
    const display = [setApp, editor];
    const { best, appGroup, settingsGroup } = sectionGroups(display);
    assert.equal(best.id, setApp.id);
    assert.deepEqual(settingsGroup.map(r => r.id), []);
    assert.deepEqual(appGroup.map(r => r.id), [editor.id]);
});

test('file/folder named settings never enter settings section', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const f = makeResult({ type: 'file', title: 'settings.txt', path: '/a/settings.txt', score: scoreResult('file-exact') });
    const display = [f];
    const { settingsGroup } = sectionGroups(display);
    assert.deepEqual(settingsGroup.map(r => r.id), []);
});

test('ranking order preserved when settings split out', () => {
    const { makeResult, scoreResult } = require('../result.js');
    const mk = (t, n, sc) => makeResult(t === 'app'
        ? { type: t, title: 't' + n, appId: 'id' + n, score: sc }
        : { type: t, title: 't' + n, path: '/p/' + n, score: sc });
    const file = mk('file', 1, 180);
    const app = mk('app', 2, 150);
    const web = mk('web', 3, 90);
    const sorted = [file, app, web];
    assert.deepEqual(sorted.map(r => r.id), [file.id, app.id, web.id]);
    const { appGroup } = sectionGroups(sorted);
    assert.deepEqual(appGroup.map(r => r.id), [app.id]);
});
