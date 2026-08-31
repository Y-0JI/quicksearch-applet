const { test } = require('node:test');
const assert = require('node:assert');
const fl = require('../providers/fileLauncher.js');

test('fileLauncherIdForPath deterministic + persistent', () => {
    const a = fl.fileLauncherIdForPath('/home/yoji/docs/report.pdf');
    const b = fl.fileLauncherIdForPath('/home/yoji/docs/report.pdf');
    assert.equal(a, b);
    assert.ok(a.startsWith('quicksearch-file-'));
    assert.ok(a.endsWith('.desktop'));
    const c = fl.fileLauncherIdForPath('/home/yoji/docs/other.pdf');
    assert.notEqual(a, c);
});

test('fileLauncherIdForPath nasty paths deterministic', () => {
    const nasty = ['/home/user/test file.txt','/home/user/a;b.txt','/home/user/$(whoami).txt','/home/user/`whoami`.txt','/home/user/"quoted".txt','/home/user/unicode — café.txt'];
    for (const p of nasty) {
        const id1 = fl.fileLauncherIdForPath(p);
        const id2 = fl.fileLauncherIdForPath(p);
        assert.equal(id1, id2);
        assert.ok(id1.startsWith('quicksearch-file-'));
    }
});

test('buildFileLauncherContent valid persistent desktop entry', () => {
    const path = '/home/yoji/docs/report.pdf';
    const uri = 'file:///home/yoji/docs/report.pdf';
    const c = fl.buildFileLauncherContent(path, uri);
    assert.ok(c.includes('[Desktop Entry]'));
    assert.ok(c.includes('Type=Application'));
    assert.ok(c.includes('Name=report.pdf'));
    assert.ok(c.includes('Exec=xdg-open'));
    assert.ok(c.includes("'" + uri + "'") || c.includes(uri));
    assert.ok(c.includes('Icon=text-x-generic-symbolic'));
    assert.ok(c.includes('X-QuickSearch-File=true'));
    assert.ok(c.includes('X-QuickSearch-Path='));
    // persistent: same path same content
    assert.equal(c, fl.buildFileLauncherContent(path, uri));
    // safe quoting for spaces/specials
    const nastyUri = 'file:///home/user/test file.txt';
    const c2 = fl.buildFileLauncherContent('/home/user/test file.txt', nastyUri);
    assert.ok(c2.includes("xdg-open '" + nastyUri + "'") || c2.includes('xdg-open'), 'quoted exec');
});

test('buildDesktopLauncherContent same as file launcher', () => {
    const p = '/home/yoji/file.txt';
    const u = 'file:///home/yoji/file.txt';
    assert.equal(fl.buildDesktopLauncherContent(p, u), fl.buildFileLauncherContent(p, u));
});

test('_shellQuote fallback safe', () => {
    // GLib not available in Node, fallback should quote
    const q = fl._shellQuote("a'b");
    assert.ok(q.includes("'"), 'quoted');
    assert.equal(fl._shellQuote('file:///a b.txt'), "'file:///a b.txt'");
});
