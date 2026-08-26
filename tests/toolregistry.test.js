const { test } = require('node:test');
const assert = require('node:assert');
const { createToolRegistry, LIMITS, RISK_LEVELS } = require('../providers/toolRegistry.js');

function makeTool(over) {
    return Object.assign({
        id: 'echo', name: 'Echo', description: 'echoes text', riskLevel: 'LOW',
        inputSchema: { type: 'object',
            properties: { text: { type: 'string' }, n: { type: 'number' } },
            required: ['text'] },
        execute: (args, ctx, cb) => cb(null, { text: args.text })
    }, over || {});
}

test('register accepts valid tool, get/list expose metadata', () => {
    const reg = createToolRegistry();
    assert.equal(reg.register(makeTool()), null);
    assert.equal(reg.get('echo').id, 'echo');
    assert.deepEqual(reg.list(), [{ id: 'echo', name: 'Echo', description: 'echoes text',
        riskLevel: 'LOW', inputSchema: makeTool().inputSchema }]);
});

test('register rejects bad shape: id/risk/schema/duplicate/execute', () => {
    const reg = createToolRegistry();
    assert.equal(reg.register(makeTool({ id: 'Bad-Id' })), 'invalid-id');
    assert.equal(reg.register(makeTool({ riskLevel: 'CRITICAL' })), 'invalid-risk-level');
    assert.equal(reg.register(makeTool({ inputSchema: {} })), 'invalid-input-schema');
    assert.equal(reg.register(makeTool({ execute: 'x' })), 'execute-must-be-function');
    reg.register(makeTool());
    assert.equal(reg.register(makeTool()), 'duplicate-id');
    assert.ok(RISK_LEVELS.indexOf('HIGH') !== -1);
    assert.equal(LIMITS.maxAgentSteps, 8);
});

test('list() sorted by id (stable order for future tool definitions)', () => {
    const reg = createToolRegistry();
    reg.register(makeTool({ id: 'b_tool' }));
    reg.register(makeTool({ id: 'a_tool' }));
    assert.deepEqual(reg.list().map(t => t.id), ['a_tool', 'b_tool']);
});

test('validate: unknown tool / object / unknown-key / missing-required / bad-type', () => {
    const reg = createToolRegistry();
    reg.register(makeTool());
    assert.equal(reg.validate('nope', {}).error, 'unknown-tool');
    assert.equal(reg.validate('echo', 'not-an-object').reason, 'args-must-be-object');
    assert.equal(reg.validate('echo', { text: 'x', evil: 1 }).reason, 'unknown-key:evil');
    assert.equal(reg.validate('echo', {}).reason, 'missing-required:text');
    assert.equal(reg.validate('echo', { text: 5 }).reason, 'bad-type:text');
    assert.equal(reg.validate('echo', { text: 'ok' }), null);
});
