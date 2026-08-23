const { test } = require('node:test');
const assert = require('node:assert');
const { pickFileBackend } = require('../utils.js');

test('backend priority plocate > locate > find > none', () => {
    assert.equal(pickFileBackend({ hasPlocate: true, hasLocate: true, hasFind: true }), 'plocate');
    assert.equal(pickFileBackend({ hasPlocate: false, hasLocate: true, hasFind: true }), 'locate');
    assert.equal(pickFileBackend({ hasPlocate: false, hasLocate: false, hasFind: true }), 'find');
    assert.equal(pickFileBackend({ hasPlocate: false, hasLocate: false, hasFind: false }), null);
});

test('sanitizeGlob strips glob metachars from user query', () => {
    assert.equal(require('../utils.js').sanitizeGlob('my *file?.tx[t'), 'my file.txt');
    assert.equal(require('../utils.js').sanitizeGlob('plain-name_1'), 'plain-name_1');
});
