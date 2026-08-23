const { test } = require('node:test');
const assert = require('node:assert');
const { tryCalculate } = require('../providers/calculatorProvider.js');

test('basic arithmetic', () => {
    assert.equal(tryCalculate('2+2').value, '4');
    assert.equal(tryCalculate('125*8').value, '1000');
    assert.equal(tryCalculate('(10+5)*2').value, '30');
    assert.equal(tryCalculate('100/4').value, '25');
});

test('floats, precedence, unary minus', () => {
    assert.equal(tryCalculate('2.5*4').value, '10');
    assert.equal(tryCalculate('2+3*4').value, '14');
    assert.equal(tryCalculate('-5+3').value, '-2');
    assert.equal(tryCalculate('10/4').value, '2.5');
});

test('plain number shows as result', () => {
    assert.deepEqual(tryCalculate('125'), { expression: '125', value: '125' });
});

test('rejects non-math and injection', () => {
    assert.equal(tryCalculate('firefox'), null);
    assert.equal(tryCalculate('document.pdf'), null);
    assert.equal(tryCalculate('process.exit(1)'), null);
    assert.equal(tryCalculate('__proto__'), null);
    assert.equal(tryCalculate('constructor'), null);
    assert.equal(tryCalculate('2+2; rm -rf /'), null);
    assert.equal(tryCalculate('alert(1)'), null);
    assert.equal(tryCalculate(''), null);
    assert.equal(tryCalculate('   '), null);
});
