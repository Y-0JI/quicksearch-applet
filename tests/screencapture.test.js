const { test } = require('node:test');
const assert = require('node:assert');
const { bytesToBase64, imageWithinLimits, DATA_URL_PREFIX } = require('../providers/screenCapture.js');

test('bytesToBase64: known vectors', () => {
    // PNG magic bytes
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(bytesToBase64(pngMagic), 'iVBORw0KGgo=');
    assert.equal(bytesToBase64(new Uint8Array([])), '');
    assert.equal(bytesToBase64(new Uint8Array([102, 111, 111])), 'Zm9v'); // "foo"
});

test('imageWithinLimits: prefix + ceiling enforced, junk rejected', () => {
    assert.equal(DATA_URL_PREFIX, 'data:image/png;base64,');
    assert.ok(imageWithinLimits('data:image/png;base64,Zm9v', 1000));
    assert.ok(!imageWithinLimits('data:image/png;base64,' + 'x'.repeat(1001), 1000));
    assert.ok(!imageWithinLimits('text/plain;base64,Zm9v', 1000));
    assert.ok(!imageWithinLimits(undefined, 1000));
});
