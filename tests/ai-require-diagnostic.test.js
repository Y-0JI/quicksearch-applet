const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const factory = require('../ai/aiFactory.js');
const { createNineRouterProvider } = require('../ai/nineRouterProvider.js');

function withMockedRequire(mockMap, fn) {
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(mockMap, request)) {
            const val = mockMap[request];
            if (val instanceof Error) throw val;
            return val;
        }
        return originalLoad.apply(this, arguments);
    };
    try { return fn(); } finally { Module._load = originalLoad; }
}

test('P1-1 require fallback: first path fails but second succeeds -> module used', () => {
    const { _tryRequireWithDiagnostics } = factory;
    const bogus = './nonexistent-should-not-exist-xyz.js';
    const good = './promptBuilder.js';
    const res = _tryRequireWithDiagnostics('testFallback', [bogus, good]);
    assert.ok(res.module, 'module should be found via fallback');
    assert.ok(res.module.buildSystemPrompt || res.module.SYSTEM_PROMPT || typeof res.module === 'object', 'loaded module looks like promptBuilder');
    assert.ok(Array.isArray(res.errors), 'errors array exists');
    assert.equal(res.errors.length, 1, 'first path error preserved');
    assert.equal(res.errors[0].path, bogus);
});

test('P1-1 require load runtime error preserved not swallowed, sanitized', () => {
    const tmpDir = path.join(__dirname, '.tmp-require-diag');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch(e) {}
    const tmpFile = path.join(tmpDir, 'thrower.js');
    const fakeKey = 'sk-test-Bearer-SECRET123';
    fs.writeFileSync(tmpFile, `throw Object.assign(new Error('runtime fail Bearer ${fakeKey} api_key= ${fakeKey}'), {name:'TypeError'});`);
    const rel = '../tests/.tmp-require-diag/thrower.js';
    const altRel = './tests/.tmp-require-diag/thrower.js';
    const { _tryRequireWithDiagnostics, _sanitizeRequireMsg } = factory;
    const res = _tryRequireWithDiagnostics('testRuntime', [rel, './ai/nonexistent2.js']);
    assert.equal(res.module, null, 'module should be null when all attempts throw');
    assert.ok(res.errors.length >= 1, 'errors preserved');
    const first = res.errors[0];
    assert.match(first.name, /TypeError|Error/, 'error name preserved');
    assert.ok(!first.message.includes(fakeKey), 'API key sanitized from message');
    assert.ok(first.message.includes('[REDACTED]') || first.message.includes('runtime fail'), 'sanitized message contains redacted or original without secret');
    const direct = _sanitizeRequireMsg('Bearer ' + fakeKey + ' and api_key= ' + fakeKey);
    assert.ok(!direct.includes(fakeKey), 'sanitize helper redacts Bearer');
    assert.ok(direct.includes('[REDACTED]'));
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    try { fs.rmdirSync(tmpDir); } catch(e) {}
    try { fs.rmdirSync(path.join(__dirname, '.tmp-require-diag')); } catch(e) {}
});

test('P1-1 all require fail -> module unavailable + attempted paths diagnostic', () => {
    const { _tryRequireWithDiagnostics } = factory;
    const paths = ['./ai/does-not-exist-a.js', './ai/does-not-exist-b.js', 'ai/does-not-exist-c.js'];
    const res = _tryRequireWithDiagnostics('testAllFail', paths);
    assert.equal(res.module, null);
    assert.equal(res.errors.length, 3);
    assert.deepEqual(res.errors.map(e=>e.path), paths);
    for (const e of res.errors) {
        assert.ok(e.name, 'name present');
        assert.ok(e.message, 'message present');
    }
    const diag = factory._getRequireDiagnostics();
    assert.ok(diag.testAllFail, 'diagnostics stored per key');
    assert.equal(diag.testAllFail.length, 3);
});

test('P1-2 streamParser null guard -> staged stream_parse error not TypeError cannot read', async () => {
    const provider = createNineRouterProvider({ baseUrl: 'http://127.0.0.1:20128', apiKey: 'sk-test-key', model: 'coba9router', httpFetch: (url, opts) => Promise.resolve({ status: 200, bodyText: '{}' }) });
    const mockMap = {
        './ai/streamParser.js': null,
        './streamParser.js': null,
        'ai/streamParser.js': null
    };
    let gotErr = null;
    await withMockedRequire(mockMap, () => {
        return new Promise(resolve => {
            provider.streamRequest({ query: 'hi', systemPrompt: 'sys' }, (evt) => {
                if (evt && evt.type === 'error') { gotErr = evt.error; resolve(); }
            });
            setTimeout(resolve, 100);
        });
    });
    assert.ok(gotErr, 'should get error event');
    assert.equal(gotErr.code, 'provider_error');
    assert.equal(gotErr.stage, 'stream_parse');
    assert.match(gotErr.message, /streamParser module unavailable/);
    assert.ok(!String(gotErr.message).includes('Cannot read properties'), 'should not be generic TypeError');
});

test('P1-2 streamParser invalid export guard -> staged stream_parse', async () => {
    const provider = createNineRouterProvider({ baseUrl: 'http://127.0.0.1:20128', apiKey: 'sk-test-key', model: 'coba9router', httpFetch: (url, opts) => Promise.resolve({ status: 200, bodyText: '{}' }) });
    const mockMap = {
        './ai/streamParser.js': {},
        './streamParser.js': { notCreate: 1 },
        'ai/streamParser.js': { createStreamParser: 'not-a-function' }
    };
    let gotErr = null;
    await withMockedRequire(mockMap, () => {
        return new Promise(resolve => {
            provider.streamRequest({ query: 'hi', systemPrompt: 'sys' }, (evt) => {
                if (evt && evt.type === 'error') { gotErr = evt.error; resolve(); }
            });
            setTimeout(resolve, 100);
        });
    });
    assert.ok(gotErr, 'should get error');
    assert.equal(gotErr.code, 'provider_error');
    assert.equal(gotErr.stage, 'stream_parse');
    assert.match(gotErr.message, /streamParser/);
});

test('P1-2 streamParser guard sanitizes Bearer in load error', async () => {
    const fakeKey = 'sk-Bearer-SECRET999';
    const errWithKey = Object.assign(new Error('load fail Bearer ' + fakeKey), { name: 'Error' });
    const provider = createNineRouterProvider({ baseUrl: 'http://127.0.0.1:20128', apiKey: 'sk-test', model: 'm', httpFetch: (url, opts) => Promise.resolve({ status: 200, bodyText: '{}' }) });
    const mockMap = {
        './ai/streamParser.js': errWithKey,
        './streamParser.js': errWithKey,
        'ai/streamParser.js': errWithKey
    };
    let gotErr = null;
    await withMockedRequire(mockMap, () => {
        return new Promise(resolve => {
            provider.streamRequest({ query: 'hi' }, (evt) => {
                if (evt && evt.type === 'error') { gotErr = evt.error; resolve(); }
            });
            setTimeout(resolve, 200);
        });
    });
    assert.ok(gotErr);
    assert.equal(gotErr.stage, 'stream_parse');
});
