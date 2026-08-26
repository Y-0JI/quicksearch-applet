const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createDefaultTools } = require('../providers/tools/index.js');
const { createToolRegistry } = require('../providers/toolRegistry.js');

function makeDeps(over) {
    const d = {
        tryCalculate: q => q === '2+2' ? { expression: '2+2', value: '4' } : null,
        detectUrl: q => /^https?:\/\/\S+$|^[\w-]+(\.[a-z]{2,})\S*$/i.test(q) ? q : null,
        openUri: url => { d._opened = d._opened || []; d._opened.push(url); },
        openPath: p => p === '/tmp/exists.txt',
        fileProvider: { search: (q, c, cb) => cb([{ title: 'a.txt', path: '/home/a.txt' }]) },
        webProvider: { search: (q, c, cb) => {
            cb([{ title: 'fallback', url: 'https://ddg/?q=x', description: '' }]);
            setTimeout(() => cb([
                { title: 'fallback', url: 'https://ddg/?q=x', description: '' },
                { title: 'Answer', url: 'https://x.com/a', description: 'desc' }]), 0);
        } },
        appProvider: { searchApps: q => q === 'files'
            ? [{ title: 'Files', appId: 'org.gnome.Nautilus.desktop', action: () => { d._launched = true; } }] : [] },
        timers: (() => { return {
            after: (ms, fn) => { d._graceFn = fn; return 1; },
            clear: () => { d._graceFn = null; } }; })()
    };
    return Object.assign(d, over || {});
}

function registryWith(deps) {
    const reg = createToolRegistry();
    for (const t of createDefaultTools(deps)) reg.register(t);
    return reg;
}

test('all six tools registered with expected ids + risk levels', () => {
    const reg = registryWith(makeDeps());
    const ids = reg.list().map(t => t.id).sort();
    assert.deepEqual(ids, ['calculator', 'launch_app', 'open_file', 'open_url', 'search_files', 'search_web']);
    assert.equal(reg.get('launch_app').riskLevel, 'MEDIUM');
    assert.equal(reg.get('open_file').riskLevel, 'MEDIUM');
    assert.equal(reg.get('calculator').riskLevel, 'LOW');
});

test('calculator: valid expression -> {expression,value}; invalid -> error', () => {
    const deps = makeDeps();
    const [calc] = createDefaultTools(deps).filter(t => t.id === 'calculator');
    calc.execute({ expression: '2+2' }, {}, (e, r) => { assert.equal(e, null); assert.equal(r.value, '4'); });
    calc.execute({ expression: 'import os' }, {}, e2 => assert.equal(e2.error, 'invalid-expression'));
});

test('search_files: maps provider results to {title,path}, passes cancellable', () => {
    let passedCanc = 'none';
    const deps = makeDeps({ fileProvider: { search: (q, c, cb) => { passedCanc = c; cb([
        { title: 'a.txt', path: '/h/a.txt', icon: 'ICON', score: 9, action: () => {} }] ); } } });
    const [sf] = createDefaultTools(deps).filter(t => t.id === 'search_files');
    sf.execute({ query: 'a' }, { cancellable: { x: 1 } }, (e, r) => {
        assert.equal(e, null);
        assert.deepEqual(r.files, [{ title: 'a.txt', path: '/h/a.txt' }]); // UI fields stripped
        assert.ok(passedCanc && passedCanc.x === 1);
    });
});

test('search_web: waits for upgrade delivery, finishes early on second delivery', () => {
    const deps = makeDeps();
    const [sw] = createDefaultTools(deps).filter(t => t.id === 'search_web');
    sw.execute({ query: 'x' }, {}, (e, r) => {
        assert.equal(e, null);
        assert.equal(r.results.length, 2);
        assert.deepEqual(r.results[1], { title: 'Answer', url: 'https://x.com/a', summary: 'desc' });
    });
});

test('search_web: falls back to first delivery after grace timer', () => {
    const deps = makeDeps({ webProvider: { search: (q, c, cb) => { cb([{ title: 'fallback', url: 'https://ddg/?q=x', description: '' }]); } } });
    const [sw] = createDefaultTools(deps).filter(t => t.id === 'search_web');
    sw.execute({ query: 'x' }, {}, (e, r) => {
        assert.equal(r.results.length, 1); // fallback only
    });
    deps._graceFn(); // grace expired, upgrade never came
});

test('open_url: http(s) opens via injected openUri; javascript:/file: REJECTED', () => {
    const deps = makeDeps();
    const [ou] = createDefaultTools(deps).filter(t => t.id === 'open_url');
    ou.execute({ url: 'https://example.com' }, {}, (e, r) => {
        assert.equal(e, null); assert.deepEqual(deps._opened, ['https://example.com']);
    });
    ou.execute({ url: 'javascript:alert(1)' }, {}, e2 => assert.equal(e2.error, 'invalid-url'));
    ou.execute({ url: 'file:///etc/passwd' }, {}, e3 => assert.equal(e3.error, 'invalid-url'));
});

test('open_file: existing path opens; missing -> file-not-found', () => {
    const deps = makeDeps();
    const [of_] = createDefaultTools(deps).filter(t => t.id === 'open_file');
    of_.execute({ path: '/tmp/exists.txt' }, {}, (e, r) => { assert.equal(e, null); assert.equal(r.opened, '/tmp/exists.txt'); });
    of_.execute({ path: '/nope/missing.txt' }, {}, e2 => assert.equal(e2.error, 'file-not-found'));
});

test('launch_app: reuses provider action (no arbitrary executable); no match -> app-not-found', () => {
    const deps = makeDeps();
    const [la] = createDefaultTools(deps).filter(t => t.id === 'launch_app');
    la.execute({ app: 'files' }, {}, (e, r) => {
        assert.equal(e, null); assert.equal(r.launched, 'Files'); assert.equal(deps._launched, true);
    });
    la.execute({ app: 'totally-not-an-app' }, {}, e2 => assert.equal(e2.error, 'app-not-found'));
    la.execute({ app: '../../bin/sh' }, {}, e3 => assert.equal(e3.error, 'app-not-found')); // never executed raw
});

test('SECURITY: tool sources contain no shell/exec primitives', () => {
    for (const f of ['../providers/toolRegistry.js', '../providers/tools/index.js']) {
        const src = fs.readFileSync(require.resolve(f), 'utf8');
        assert.ok(!/child_process|spawnSync|spawn\(|\bexec(Sync)?\(|\/bin\/sh|system\(/.test(src), 'no shell in ' + f);
    }
});
