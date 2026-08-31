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
    assert.ok(c.includes('Exec=xdg-open ' + uri));
    assert.ok(!c.includes("'file://"), 'Exec must not shell-quote (percent-encoded uri)');
    assert.ok(c.includes('Icon=text-x-generic-symbolic'));
    assert.ok(c.includes('X-QuickSearch-File=true'));
    assert.ok(c.includes('X-QuickSearch-Path='));
    assert.equal(c, fl.buildFileLauncherContent(path, uri));
    // space path: uri is percent-encoded, Exec plain uri valid
    const nastyPath = '/home/user/test file.txt';
    const nastyUri = 'file:///home/user/test%20file.txt';
    const c2 = fl.buildFileLauncherContent(nastyPath, nastyUri);
    assert.ok(c2.includes('Exec=xdg-open ' + nastyUri));
    assert.ok(!c2.includes("'file://"), 'no shell quotes in Exec');
});

test('buildDesktopLauncherContent same as file launcher', () => {
    const p = '/home/yoji/file.txt';
    const u = 'file:///home/yoji/file.txt';
    assert.equal(fl.buildDesktopLauncherContent(p, u), fl.buildFileLauncherContent(p, u));
});

test('percent-encoded uri valid for specials', () => {
    // GIO percent-encodes: ; -> %3B, " -> %22, ` -> %60 etc
    const p = '/home/user/a;b.txt';
    const uri = 'file:///home/user/a%3Bb.txt';
    const c = fl.buildFileLauncherContent(p, uri);
    assert.ok(c.includes('Exec=xdg-open ' + uri));
});
