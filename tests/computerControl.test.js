const { test } = require('node:test');
const assert = require('node:assert');
const {
    KEYS, validatePoint, validateKey, sanitizeText, validateScroll,
    buildClickArgv, buildTypeArgv, buildKeyArgv, buildScrollArgv,
    pickBackend
} = require('../providers/computerControl.js');

// ---- whitelist keys ----

test('key whitelist: specials present, combos/unknown rejected', () => {
    for (const k of ['Return', 'Escape', 'Tab', 'BackSpace', 'Delete',
                     'Up', 'Down', 'Left', 'Right', 'Home', 'End',
                     'Page_Up', 'Page_Down', 'Space', 'F1', 'F12']) {
        assert.equal(validateKey(k), null, k + ' should be valid');
    }
    for (const bad of ['ctrl+c', 'Ctrl+C', 'foo', ';rm -rf /', '', 'super s']) {
        assert.equal(validateKey(bad), 'invalid-key', JSON.stringify(bad));
    }
});

// ---- coordinate validation ----

test('validatePoint: ints within bounds only; rejects junk/out-of-bounds', () => {
    const B = [1920, 1080];
    assert.equal(validatePoint(10, 20, B), null);
    assert.equal(validatePoint(0, 0, B), null);
    assert.equal(validatePoint(1919, 1079, B), null);
    for (const bad of [
        [-1, 5], [5, -1], [1920, 5], [5, 1080],          // out of bounds
        [1.5, 2], [1e3, 'x'], ['a', 2], [NaN, 1], [Infinity, 1]
    ]) {
        const e = validatePoint(bad[0], bad[1], B);
        assert.ok(e && e.error === 'invalid-coordinates', JSON.stringify(bad));
    }
    // zero-size screen means no display data yet
    assert.equal(validatePoint(1, 1, [0, 0]).error, 'invalid-coordinates');
});

// ---- text sanitization for type_text ----

test('sanitizeText: caps length, strips control chars, keeps printable', () => {
    assert.equal(sanitizeText('halo dunia'), 'halo dunia');
    assert.equal(sanitizeText('tab\there'), 'tabhere');
    assert.equal(sanitizeText('nl\nhere'), 'nlhere');
    assert.equal(sanitizeText('x'.repeat(600)).length, 500);
    assert.equal(sanitizeText('emoji 😀 ok'), 'emoji 😀 ok');
});

// ---- scroll validation ----

test('validateScroll: direction up|down, amount int 1..10 (default 3)', () => {
    assert.deepEqual(validateScroll({ direction: 'down' }), { direction: 'down', amount: 3 });
    assert.deepEqual(validateScroll({ direction: 'up', amount: 7 }), { direction: 'up', amount: 7 });
    assert.equal(validateScroll({ direction: 'left' }).error, 'invalid-direction');
    assert.equal(validateScroll({}).error, 'invalid-direction');
    assert.equal(validateScroll({ direction: 'down', amount: 0 }).error, 'invalid-amount');
    assert.equal(validateScroll({ direction: 'down', amount: 11 }).error, 'invalid-amount');
    assert.equal(validateScroll({ direction: 'down', amount: 2.5 }).error, 'invalid-amount');
});

// ---- xdotool argv builders (fixed argv, never a shell string) ----

test('argv builders: fixed shapes, text after -- separator', () => {
    assert.deepEqual(buildClickArgv(100, 200),
        ['xdotool', 'mousemove', '--sync', '100', '200', 'click', '1']);
    assert.deepEqual(buildClickArgv(5, 6, 'right'),
        ['xdotool', 'mousemove', '--sync', '5', '6', 'click', '3']);
    assert.deepEqual(buildTypeArgv('hai apa kabar'),
        ['xdotool', 'type', '--delay', '12', '--', 'hai apa kabar']);
    assert.deepEqual(buildKeyArgv('Return'), ['xdotool', 'key', '--', 'Return']);
    assert.deepEqual(buildScrollArgv('up', 4),
        ['xdotool', 'click', '--repeat', '4', '4']);
    assert.deepEqual(buildScrollArgv('down', 1),
        ['xdotool', 'click', '--repeat', '1', '5']);
});

// ---- backend picker (clutter preferred, then xdotool, else none) ----

test('pickBackend: clutter > xdotool > null', () => {
    assert.equal(pickBackend({ hasClutter: true, hasXdotool: false }), 'clutter');
    assert.equal(pickBackend({ hasClutter: false, hasXdotool: true }), 'xdotool');
    assert.equal(pickBackend({}), null);
});
