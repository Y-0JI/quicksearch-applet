const { test } = require('node:test');
const assert = require('node:assert');
const { tryCalculate } = require('../providers/calculatorProvider.js');

test('basic arithmetic (live-verified regression)', () => {
    assert.equal(tryCalculate('2+3').value, '5');
    assert.equal(tryCalculate('5-2').value, '3');
    assert.equal(tryCalculate('2*3').value, '6');
    assert.equal(tryCalculate('10/2').value, '5');
    assert.equal(tryCalculate('10%3').value, '1');
    assert.equal(tryCalculate('(2+3)*4').value, '20');
    assert.equal(tryCalculate('2.5*4').value, '10');
    assert.equal(tryCalculate('-5+2').value, '-3');
    assert.equal(tryCalculate('125*8').value, '1000');
    assert.equal(tryCalculate('(10+5)*2').value, '30');
    assert.equal(tryCalculate('100/4').value, '25');
});

test('floats, precedence, unary minus', () => {
    assert.equal(tryCalculate('2+3*4').value, '14');
    assert.equal(tryCalculate('10/4').value, '2.5');
});

test('division by zero rejected', () => {
    assert.equal(tryCalculate('10/0'), null);
    assert.equal(tryCalculate('5%0'), null);
});

test('exponent ^', () => {
    assert.equal(tryCalculate('2^3').value, '8');
    assert.equal(tryCalculate('2^3^2').value, '512'); // right-assoc
    assert.equal(tryCalculate('-2^2').value, '-4');   // -(2^2), math convention
    assert.equal(tryCalculate('2^-3').value, '0.125');
    assert.equal(tryCalculate('9^0.5').value, '3');
});

test('whitelisted functions', () => {
    assert.equal(tryCalculate('sqrt(16)').value, '4');
    assert.equal(tryCalculate('sqrt(sqrt(16))').value, '2');
    assert.equal(tryCalculate('abs(-5)').value, '5');
    assert.equal(tryCalculate('round(2.6)').value, '3');
    assert.equal(tryCalculate('round(2.4)').value, '2');
    assert.equal(tryCalculate('floor(2.9)').value, '2');
    assert.equal(tryCalculate('ceil(2.1)').value, '3');
    assert.equal(tryCalculate('sqrt((2+3)*4)+1').value, '5.472135955'); // mixed
    assert.equal(tryCalculate('sqrt 16'), null);              // parens required
});

test('domain errors and overflow rejected', () => {
    assert.equal(tryCalculate('sqrt(-1)'), null);
    assert.equal(tryCalculate('0^-1'), null);
    assert.equal(tryCalculate('999999999^99999'), null); // Infinity
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
    assert.equal(tryCalculate('sin(30)'), null);      // not whitelisted
    assert.equal(tryCalculate('eval(1)'), null);
    assert.equal(tryCalculate('Function("x")'), null); // uppercase blocked by gate
    assert.equal(tryCalculate('2+'), null);
    assert.equal(tryCalculate('2++'), null); // wait: unary + makes this valid? see next test
    assert.equal(tryCalculate('sqrt(16'), null);
    assert.equal(tryCalculate('(2+3'), null);
    assert.equal(tryCalculate(''), null);
    assert.equal(tryCalculate('   '), null);
});
