const { test } = require('node:test');
const assert = require('node:assert');
const { createPermissionPolicy, COMPUTER_TOOLS } = require('../providers/permissionPolicy.js');

test('default matrix: LOW/MEDIUM allow, HIGH confirm, unknown risk deny', () => {
    const p = createPermissionPolicy({});
    assert.equal(p.decide('calculator', 'LOW'), 'allow');
    assert.equal(p.decide('launch_app', 'MEDIUM'), 'allow');
    assert.equal(p.decide('delete_file', 'HIGH'), 'confirm');
    assert.equal(p.decide('mystery', undefined), 'deny'); // fail-closed
});

test('computer control gating: off -> deny for control tools only', () => {
    const p = createPermissionPolicy({ isComputerControlAllowed: () => false });
    for (const id of COMPUTER_TOOLS) {
        assert.equal(p.decide(id, 'MEDIUM'), 'deny', id);
    }
    // non-control MEDIUM tools unaffected
    assert.equal(p.decide('open_file', 'MEDIUM'), 'allow');
    assert.equal(p.decide('launch_app', 'MEDIUM'), 'allow');
});

test('computer control allowed -> normal matrix applies', () => {
    const p = createPermissionPolicy({ isComputerControlAllowed: () => true });
    for (const id of COMPUTER_TOOLS) {
        assert.equal(p.decide(id, 'MEDIUM'), 'allow', id);
    }
});

test('agent disabled denies everything (defense in depth)', () => {
    const p = createPermissionPolicy({ isAgentEnabled: () => false });
    assert.equal(p.decide('calculator', 'LOW'), 'deny');
    assert.equal(p.decide('click', 'MEDIUM'), 'deny');
    assert.equal(p.decide('whatever', 'HIGH'), 'deny');
});

test('custom matrix override works and stays centralized', () => {
    const p = createPermissionPolicy({
        matrix: { LOW: 'allow', MEDIUM: 'confirm', HIGH: 'confirm' }
    });
    assert.equal(p.decide('launch_app', 'MEDIUM'), 'confirm');
    assert.equal(p.decide('click', 'MEDIUM'), 'confirm');
    assert.equal(p.decide('calculator', 'LOW'), 'allow');
});

test('COMPUTER_TOOLS list matches Phase 11 pointer/window tools', () => {
    assert.deepEqual([...COMPUTER_TOOLS].sort(),
        ['click', 'focus_app', 'press_key', 'scroll', 'type_text']);
});
