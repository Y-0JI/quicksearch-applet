const { test } = require('node:test');
const assert = require('node:assert');
const { createAIManager } = require('../providers/aiManager.js');
const { createAIProvider, REGISTRY } = require('../providers/aiProvider.js');

const OK_BODY = JSON.stringify({
    model: 'm',
    choices: [{ message: { role: 'assistant', content: 'jawaban' } }]
});

// manager-level mock: intercepts at the HTTP transport of the engine
function makeManager(providerId, cfg, respond, extra) {
    let lastOpts = null;
    function http(opts, cb) {
        lastOpts = opts;
        respond(opts, cb);
    }
    const mgr = createAIManager(Object.assign({
        getProviderId: () => providerId,
        getConfig: () => cfg,
        registry: REGISTRY,
        http: http,
        createProviderEngine: (cfg2) => createAIProvider(Object.assign({ http: http }, cfg2))
    }, extra || {}));
    mgr._lastOpts = () => lastOpts;
    return mgr;
}

test('9router: empty endpoint/model fall back to registry defaults, no key needed', () => {
    const mgr = makeManager('9router', { apiKey: '', model: '', endpoint: '' },
        (o, cb) => {
            assert.equal(o.url, 'http://127.0.0.1:20128/v1/chat/completions');
            assert.equal(JSON.parse(o.body).model, '');
            cb(null, { status: 200, text: OK_BODY });
        });
    mgr.ask('q', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.answer, 'jawaban');
    });
});

test('config overrides registry defaults (endpoint + key)', () => {
    const mgr = makeManager('openrouter', { endpoint: 'https://my.proxy/v1', apiKey: 'k1' },
        (o, cb) => {
            assert.equal(o.url, 'https://my.proxy/v1');
            assert.equal(o.headers['Authorization'], 'Bearer k1');
            cb(null, { status: 200, text: OK_BODY });
        });
    mgr.ask('q', {}, (err) => assert.equal(err, null));
});

test('needsKey providers gate on empty key (9router does not)', () => {
    let hits = 0;
    const openr = makeManager('openrouter', { apiKey: '' }, (o, cb) => { hits++; cb(null, { status: 200, text: OK_BODY }); });
    openr.ask('q', {}, (err) => assert.equal(err.error, 'no-api-key'));
    assert.equal(hits, 0);

    const r9 = makeManager('9router', { apiKey: '' }, (o, cb) => { hits++; cb(null, { status: 200, text: OK_BODY }); });
    r9.ask('q', {}, (err) => { assert.equal(err, null); });
    assert.equal(hits, 1);

    // user MAY still set a key on needsKey=false providers
    const custom = makeManager('custom', { endpoint: 'http://x/v1', apiKey: 'optional' },
        (o, cb) => {
            assert.equal(o.headers['Authorization'], 'Bearer optional');
            cb(null, { status: 200, text: OK_BODY });
        });
    custom.ask('q', {}, (err) => assert.equal(err, null));
});

test('openai/custom without endpoint -> no-endpoint', () => {
    for (const id of ['openai', 'custom']) {
        const m = makeManager(id, {}, (o, cb) => cb(null, { status: 200, text: OK_BODY }));
        m.ask('q', {}, (err) => assert.equal(err.error, 'no-endpoint'));
    }
});

test('unknown provider id -> unknown-provider', () => {
    const m = makeManager('ollama', {}, (o, cb) => cb(null, { status: 200, text: OK_BODY }));
    m.ask('q', {}, (err) => assert.equal(err.error, 'unknown-provider'));
});

test('cancel() invalidates in-flight ask through the manager', () => {
    let finish;
    const mgr = makeManager('9router', {}, (o, cb) => { finish = () => cb(null, { status: 200, text: OK_BODY }); });
    let called = 0;
    mgr.ask('q', {}, () => called++);
    mgr.cancel();
    finish();
    assert.equal(called, 0);
});
