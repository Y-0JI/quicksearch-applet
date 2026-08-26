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

test('execute: success path normalizes result', () => {
    const reg = createToolRegistry();
    reg.register(makeTool());
    reg.execute('echo', { text: 'hi' }, {}, (err, res) => {
        assert.equal(err, null);
        assert.deepEqual(res, { text: 'hi' });
    });
});

test('execute: unknown tool + invalid args short-circuit BEFORE execute', () => {
    const reg = createToolRegistry();
    let ran = 0;
    reg.register(makeTool({ execute: () => ran++ }));
    reg.execute('nope', {}, {}, e1 => assert.equal(e1.error, 'unknown-tool'));
    reg.execute('echo', {}, {}, e2 => assert.equal(e2.error, 'invalid-arguments'));       // missing required
    reg.execute('echo', { text: 5 }, {}, e3 => assert.equal(e3.error, 'invalid-arguments')); // bad type
    reg.execute('echo', { text: 'x', evil: 1 }, {}, e4 => assert.equal(e4.error, 'invalid-arguments')); // unknown key
    assert.equal(ran, 0, 'tool body never ran for invalid requests');
});

test('execute: thrown tool error normalized, never escapes registry', () => {
    const reg = createToolRegistry();
    reg.register(makeTool({ execute: () => { throw new Error('boom'); } }));
    reg.execute('echo', { text: 'x' }, {}, err => {
        assert.equal(err.error, 'tool-failed');
        assert.equal(err.message, 'boom');
    });
});

test('cancel(): stale async callback dropped, cancellable cancelled', () => {
    const reg = createToolRegistry();
    let cancelled = 0;
    const cancellable = { cancel: () => cancelled++ };
    let finish;
    reg.register(makeTool({ execute: (a, ctx, cb) => { finish = () => cb(null, { ok: 1 }); } }));
    let called = 0;
    reg.execute('echo', { text: 'x' }, { cancellable }, () => called++);
    reg.cancel();
    assert.equal(cancelled, 1, 'active run cancellable invoked');
    finish(); // late completion AFTER cancel
    assert.equal(called, 0, 'stale callback must never render');
    // new executions still work after cancel
    reg.execute('echo', { text: 'y' }, {}, (err, res) => assert.deepEqual(res, { text: 'y' }));
});

test('result normalization: list truncation + size cap', () => {
    const reg = createToolRegistry();
    reg.register(makeTool({ execute: (a, c, cb) => cb(null, { items: Array.from({ length: 25 }, (_, i) => i) }) }));
    reg.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(res.items.length, 11); // 10 + {truncated,total}
        assert.deepEqual(res.items[10], { truncated: true, total: 25 });
    });
    const big = createToolRegistry();
    // single long string is truncated to maxValueChars (500), not the total cap
    big.register(makeTool({ execute: (a, c, cb) => cb(null, { blob: 'x'.repeat(9999) }) }));
    big.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(res.blob.length, LIMITS.maxValueChars);
    });
    // total-serialized cap (> 4000 chars) triggers preview form
    const huge = createToolRegistry();
    const many = {};
    for (let i = 0; i < 20; i++) many['k' + i] = 'x'.repeat(LIMITS.maxValueChars);
    huge.register(makeTool({ execute: (a, c, cb) => cb(null, many) }));
    huge.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(res.truncated, true);
        assert.ok(res.preview.length <= LIMITS.maxResultChars);
    });
});

// ---- Phase 10: data-URL images bypass the 500-char text cap ----

test('image data URL survives per-string and total caps intact', () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(LIMITS.maxImageDataUrlChars - 30);
    const reg = createToolRegistry();
    reg.register(makeTool({ execute: (a, c, cb) => cb(null, { image: img }) }));
    reg.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.image, img, 'data URL must not be truncated');
    });
});

test('oversized data URL is capped at maxImageDataUrlChars (not previewed away)', () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(LIMITS.maxImageDataUrlChars);
    const reg = createToolRegistry();
    reg.register(makeTool({ execute: (a, c, cb) => cb(null, { image: img }) }));
    reg.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(err, null);
        assert.ok(res.image.startsWith('data:image/png;base64,'));
        assert.ok(res.image.length <= LIMITS.maxImageDataUrlChars);
    });
});

test('normal strings stay capped even when a data URL exists elsewhere', () => {
    const reg = createToolRegistry();
    reg.register(makeTool({ execute: (a, c, cb) => cb(null, {
        note: 'y'.repeat(999),
        image: 'data:image/jpeg;base64,Zm9v'
    }) }));
    reg.execute('echo', { text: 'x' }, {}, (err, res) => {
        assert.equal(res.note.length, LIMITS.maxValueChars);
        assert.equal(res.image, 'data:image/jpeg;base64,Zm9v');
    });
});
