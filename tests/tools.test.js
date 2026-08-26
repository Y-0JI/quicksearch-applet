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

test('all twelve tools registered with expected ids + risk levels', () => {
    const reg = registryWith(makeControlDeps());
    const ids = reg.list().map(t => t.id).sort();
    assert.deepEqual(ids, ['calculator', 'click', 'focus_app', 'get_screen', 'launch_app',
                           'open_file', 'open_url', 'press_key', 'scroll', 'search_files',
                           'search_web', 'type_text']);
    assert.equal(reg.get('launch_app').riskLevel, 'MEDIUM');
    assert.equal(reg.get('open_file').riskLevel, 'MEDIUM');
    assert.equal(reg.get('calculator').riskLevel, 'LOW');
    assert.equal(reg.get('get_screen').riskLevel, 'LOW');
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

// ---- Phase 10: get_screen ----

const IMG = 'data:image/png;base64,iVBORw0KGgo=';

test('get_screen: registered LOW risk, zero-arg schema', () => {
    const reg = registryWith(makeDeps());
    assert.equal(reg.get('get_screen').riskLevel, 'LOW');
    assert.deepEqual(reg.get('get_screen').inputSchema.required, []);
    assert.deepEqual(reg.get('get_screen').inputSchema.properties, {});
});

test('get_screen: success returns data URL, cancellable forwarded', () => {
    let seenCanc = 'none';
    const deps = makeDeps({ screenCapture: {
        capture: (cancellable, cb) => { seenCanc = cancellable; cb(null, IMG); } } });
    const [gs] = createDefaultTools(deps).filter(t => t.id === 'get_screen');
    gs.execute({}, { capabilities: { vision: true }, cancellable: { c: 1 } }, (e, r) => {
        assert.equal(e, null);
        assert.equal(r.image, IMG);
    });
    assert.ok(seenCanc && seenCanc.c === 1, 'cancellable passed through');
});

test('get_screen: vision NOT supported -> vision-not-supported, NO capture at all', () => {
    let captured = 0;
    const deps = makeDeps({ screenCapture: { capture: (c, cb) => { captured++; cb(null, IMG); } } });
    const [gs] = createDefaultTools(deps).filter(t => t.id === 'get_screen');
    // gate must fire BEFORE any pixels are taken (privacy + cost)
    gs.execute({}, { capabilities: { vision: false } }, e1 => assert.equal(e1.error, 'vision-not-supported'));
    gs.execute({}, {}, e2 => assert.equal(e2.error, 'vision-not-supported'));   // capabilities absent
    assert.equal(captured, 0, 'capture never invoked without vision capability');
});

test('get_screen: capture failure normalized (no display / session / iface)', () => {
    const deps = makeDeps({ screenCapture: {
        capture: (c, cb) => cb({ error: 'screenshot-unavailable' }) } });
    const [gs] = createDefaultTools(deps).filter(t => t.id === 'get_screen');
    gs.execute({}, { capabilities: { vision: true } },
        e => assert.equal(e.error, 'screenshot-unavailable'));
});

test('get_screen: cancelled capture surfaces as cancelled error', () => {
    const deps = makeDeps({ screenCapture: {
        capture: (c, cb) => cb({ error: 'cancelled' }) } });
    const [gs] = createDefaultTools(deps).filter(t => t.id === 'get_screen');
    gs.execute({}, { capabilities: { vision: true } },
        e => assert.equal(e.error, 'cancelled'));
});

test('get_screen: missing screenCapture dep -> unavailable', () => {
    const [gs] = createDefaultTools(makeDeps()).filter(t => t.id === 'get_screen');
    gs.execute({}, { capabilities: { vision: true } }, e => assert.equal(e.error, 'unavailable'));
});

// ---- Phase 11: computer control tools ----

function makeControlDeps(over) {
    const calls = [];
    const d = makeDeps(Object.assign({
        getScreenBounds: () => [1920, 1080],
        computerControl: {
            click: (x, y, button, canc, cb) => { calls.push(['click', x, y, button, !!canc]); cb(null, true); },
            typeText: (text, canc, cb) => { calls.push(['type', text]); cb(null, true); },
            pressKey: (key, canc, cb) => { calls.push(['key', key, !!canc]); cb(null, true); },
            scroll: (dir, amt, canc, cb) => { calls.push(['scroll', dir, amt]); cb(null, true); },
            focusApp: (q, canc, cb) => { calls.push(['focus', q]);
                cb(null, q === 'files' ? { focused: true, app: 'Files' } : { focused: false }); }
        }
    }, {}));
    d._calls = calls;
    return Object.assign(d, over || {});
}

const VISION_CTX = { capabilities: { vision: true }, cancellable: { c: 1 } };

test('phase 11: five control tools registered with expected risk levels', () => {
    const reg = registryWith(makeControlDeps());
    const ids = reg.list().map(t => t.id).sort();
    assert.deepEqual(ids, ['calculator', 'click', 'focus_app', 'get_screen', 'launch_app',
                           'open_file', 'open_url', 'press_key', 'scroll', 'search_files',
                           'search_web', 'type_text']);
    for (const id of ['click', 'type_text', 'press_key', 'scroll']) {
        assert.equal(reg.get(id).riskLevel, 'MEDIUM', id);
    }
    assert.equal(reg.get('focus_app').riskLevel, 'LOW');
});

test('phase 11 click: valid coords forwarded with button+cancellable', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'click');
    t.execute({ x: 100, y: 200 }, VISION_CTX, (e, r) => {
        assert.equal(e, null);
        assert.deepEqual(r, { clicked: true, x: 100, y: 200, button: 'left' });
    });
    assert.deepEqual(deps._calls[0], ['click', 100, 200, 'left', true]);
});

test('phase 11 click: out-of-bounds / non-integer rejected BEFORE control', () => {
    const deps = makeControlDeps({
        getScreenBounds: () => [1920, 1080]
    });
    const [t] = createDefaultTools(deps).filter(x => x.id === 'click');
    let n = 0;
    for (const args of [{ x: 2000, y: 5 }, { x: -3, y: 5 }, { x: 1.5, y: 2 }, { x: 'a', y: 1 }]) {
        t.execute(args, VISION_CTX, e => {
            assert.equal(e.error, 'invalid-coordinates'); n++;
        });
    }
    assert.equal(n, 4);
    assert.equal(deps._calls.length, 0, 'control never touched for invalid input');
});

test('phase 11 click: bounds come from injected getScreenBounds', () => {
    const deps = makeControlDeps({ getScreenBounds: () => [800, 600] });
    const [t] = createDefaultTools(deps).filter(x => x.id === 'click');
    t.execute({ x: 900, y: 10 }, VISION_CTX, e => assert.equal(e.error, 'invalid-coordinates'));
    t.execute({ x: 799, y: 599 }, VISION_CTX, (e) => assert.equal(e, null));
});

test('phase 11 type_text: sanitized text sent; control chars stripped', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'type_text');
    t.execute({ text: 'halo\tdunia' }, VISION_CTX, (e, r) => {
        assert.equal(e, null);
        assert.equal(r.typed, 'halodunia');
    });
    assert.deepEqual(deps._calls[0], ['type', 'halodunia']);
});

test('phase 11 type_text: empty after sanitize -> invalid-text', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'type_text');
    t.execute({ text: '\n\t\x01' }, VISION_CTX, e => assert.equal(e.error, 'invalid-text'));
    assert.equal(deps._calls.length, 0);
});

test('phase 11 press_key: whitelist enforced; invalid key never dispatched', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'press_key');
    t.execute({ key: 'Return' }, VISION_CTX, (e, r) => {
        assert.equal(e, null); assert.deepEqual(r, { pressed: 'Return' });
    });
    t.execute({ key: 'ctrl+s' }, VISION_CTX, e => assert.equal(e.error, 'invalid-key'));
    t.execute({ key: 'Foo' }, VISION_CTX, e2 => assert.equal(e2.error, 'invalid-key'));
    assert.equal(deps._calls.length, 1);
    assert.deepEqual(deps._calls[0], ['key', 'Return', true]);
});

test('phase 11 scroll: direction+amount validated; defaults applied', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'scroll');
    t.execute({ direction: 'down' }, VISION_CTX, (e, r) => {
        assert.equal(e, null); assert.deepEqual(r, { scrolled: 'down', amount: 3 });
    });
    t.execute({ direction: 'up', amount: 12 }, VISION_CTX, e => assert.equal(e.error, 'invalid-amount'));
    t.execute({ direction: 'left' }, VISION_CTX, e2 => assert.equal(e2.error, 'invalid-direction'));
    assert.equal(deps._calls.length, 1);
});

test('phase 11 focus_app: found -> focused:true; unknown -> app-not-found', () => {
    const deps = makeControlDeps();
    const [t] = createDefaultTools(deps).filter(x => x.id === 'focus_app');
    t.execute({ app: 'files' }, VISION_CTX, (e, r) => {
        assert.equal(e, null); assert.deepEqual(r, { focused: true, app: 'Files' });
    });
    t.execute({ app: 'no-such-app-xyz' }, VISION_CTX, e2 => assert.equal(e2.error, 'app-not-found'));
});

test('phase 11 cancellation: cancellable reaches every control op', () => {
    let gotCanc = 0;
    const deps = makeDeps({ getScreenBounds: () => [1920, 1080], computerControl: {
        click: (x, y, b, c, cb) => { if (c) gotCanc++; cb(null, true); },
        typeText: (t2, c, cb) => { if (c) gotCanc++; cb(null, true); },
        pressKey: (k, c, cb) => { if (c) gotCanc++; cb(null, true); },
        scroll: (d2, a, c, cb) => { if (c) gotCanc++; cb(null, true); },
        focusApp: (q, c, cb) => { if (c) gotCanc++; cb(null, { focused: true }); }
    } });
    for (const id of ['click', 'type_text', 'press_key', 'scroll']) {
        const [t] = createDefaultTools(deps).filter(x => x.id === id);
        const args = id === 'click' ? { x: 1, y: 1 } : id === 'type_text' ? { text: 'a' }
            : id === 'press_key' ? { key: 'Tab' } : { direction: 'down' };
        t.execute(args, { capabilities: { vision: true }, cancellable: { z: 1 } }, () => {});
    }
    const [f] = createDefaultTools(deps).filter(x => x.id === 'focus_app');
    f.execute({ app: 'x' }, { cancellable: { z: 1 } }, () => {});
    assert.equal(gotCanc, 5);
});

test('phase 11 control backend unavailable -> normalized error from ops', () => {
    const deps = makeDeps({ getScreenBounds: () => [1920, 1080], computerControl: {
        click: (x, y, b, c, cb) => cb({ error: 'input-unavailable' }),
        typeText: (t2, c, cb) => cb({ error: 'input-unavailable' }),
        pressKey: (k, c, cb) => cb({ error: 'input-unavailable' }),
        scroll: (d2, a, c, cb) => cb({ error: 'input-unavailable' }),
        focusApp: (q, c, cb) => cb({ error: 'input-unavailable' })
    } });
    const tools = {};
    for (const t of createDefaultTools(deps)) tools[t.id] = t;
    tools.click.execute({ x: 1, y: 1 }, VISION_CTX, e1 => assert.equal(e1.error, 'input-unavailable'));
    tools.type_text.execute({ text: 'a' }, VISION_CTX, e2 => assert.equal(e2.error, 'input-unavailable'));
    tools.press_key.execute({ key: 'Tab' }, VISION_CTX, e3 => assert.equal(e3.error, 'input-unavailable'));
    tools.scroll.execute({ direction: 'down' }, VISION_CTX, e4 => assert.equal(e4.error, 'input-unavailable'));
    tools.focus_app.execute({ app: 'x' }, {}, e5 => assert.equal(e5.error, 'input-unavailable'));
});
