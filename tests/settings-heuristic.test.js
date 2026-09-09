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
    for (const t of ['Firefox Web Browser', 'Firewall Configuration', 'Text Editor', 'Terminal', 'Files']) {
        assert.equal(isSettingsApp({ type: 'app', title: t, description: 'x' }), false, t);
    }
    assert.equal(isSettingsApp(null), false);
    assert.equal(isSettingsApp({}), false);
});

test('production wiring: applet uses utilsMod.isSettingsApp + settings category', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('utilsMod.isSettingsApp'), 'applet calls production helper');
    assert.ok(src.includes('"all", "app", "file", "folder", "settings", "web"'), 'valid list has settings');
    assert.ok(src.includes("cat === 'settings'"), 'filter branch exists');
    assert.ok(!src.includes('["settings", _("Settings")]'), 'no chip added');
    assert.ok(!src.includes('["settings", "Settings"]'), 'no chip added (plain)');
});
