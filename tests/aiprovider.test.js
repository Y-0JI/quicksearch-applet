const { test } = require('node:test');
const assert = require('node:assert');
const { createAIProvider, DEFAULT_ENDPOINT, DEFAULT_MODEL, MAX_TOKENS } = require('../providers/aiProvider.js');

const OK_BODY = JSON.stringify({
    model: 'openai/gpt-4o-mini',
    choices: [{ message: { role: 'assistant', content: '  plocate adalah tool pencarian file.  ' } }]
});

function makeMockTransport(respond) {
    const calls = [];
    function transport(opts, cb) {
        calls.push(opts);
        respond(opts, cb, calls.length);
    }
    transport.calls = calls;
    return transport;
}

function makeProvider(transport, extra) {
    return createAIProvider(Object.assign({ apiKey: 'test-key', http: transport }, extra || {}));
}

test('success: parses answer, trims it, reports model', () => {
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: OK_BODY }));
    const p = makeProvider(t);
    p.ask('jelaskan plocate', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.answer, 'plocate adalah tool pencarian file.');
        assert.equal(res.model, 'openai/gpt-4o-mini');
    });
});

test('request shape: endpoint, headers, model, question, max_tokens', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = createAIProvider({
        apiKey: 'secret-key',
        model: 'anthropic/claude-3-haiku',
        endpoint: 'https://example.invalid/v1/chat',
        http: t
    });
    p.ask('hai', {}, () => {});
    assert.equal(captured.url, 'https://example.invalid/v1/chat');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['Authorization'], 'Bearer secret-key');
    assert.equal(captured.headers['Content-Type'], 'application/json');
    const body = JSON.parse(captured.body);
    assert.equal(body.model, 'anthropic/claude-3-haiku');
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[0].content, 'hai');
    assert.equal(body.stream, false); // proven terminal request shape
    assert.equal(body.max_tokens, MAX_TOKENS);
    assert.ok(captured.timeoutMs > 0);
});

test('http error body message surfaces as detail', () => {
    const errBody = JSON.stringify({ error: { message: 'Model tidak terdaftar' } });
    const t = makeMockTransport((o, cb) => cb(null, { status: 400, text: errBody }));
    const p = makeProvider(t);
    p.ask('q', {}, (err) => {
        assert.equal(err.error, 'http-400');
        assert.equal(err.detail, 'Model tidak terdaftar');
    });
});

test('defaults applied when not specified', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    p.ask('q', {}, () => {});
    assert.equal(captured.url, DEFAULT_ENDPOINT);
    const body = JSON.parse(captured.body);
    assert.equal(body.model, DEFAULT_MODEL);
});

test('http errors are normalized (401 / 429 / 500)', () => {
    for (const status of [401, 429, 500]) {
        const t = makeMockTransport((o, cb) => cb(null, { status: status, text: '{"error":"x"}' }));
        const p = makeProvider(t);
        p.ask('q', {}, (err) => {
            assert.equal(err.error, 'http-' + status);
        });
    }
});

test('malformed json -> bad-response', () => {
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: 'not-json{{' }));
    const p = makeProvider(t);
    p.ask('q', {}, (err) => assert.equal(err.error, 'bad-response'));
});

test('missing content -> bad-response', () => {
    const body = JSON.stringify({ choices: [] });
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: body }));
    const p = makeProvider(t);
    p.ask('q', {}, (err) => assert.equal(err.error, 'bad-response'));
});

test('network-level failure passes normalized error through', () => {
    const t = makeMockTransport((o, cb) => cb({ error: 'network', detail: 'connection refused' }));
    const p = makeProvider(t);
    p.ask('q', {}, (err) => {
        assert.equal(err.error, 'network');
        assert.equal(err.detail, 'connection refused');
    });
});

test('empty question -> empty-question without hitting transport', () => {
    const t = makeMockTransport(() => assert.fail('transport must not be called'));
    const p = makeProvider(t);
    p.ask('   ', {}, (err) => assert.equal(err.error, 'empty-question'));
    assert.equal(t.calls.length, 0);
});

test('empty key is allowed at engine level (gating lives in AIManager)', () => {
    let auth = '';
    const t = makeMockTransport((o, cb) => { auth = o.headers['Authorization']; cb(null, { status: 200, text: OK_BODY }); });
    const p = createAIProvider({ apiKey: '', http: t });
    p.ask('q', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(auth, 'Bearer ');
        assert.ok(res.answer.length > 0);
    });
    assert.equal(t.calls.length, 1);
});

test('default transport outside Cinnamon fails gracefully (no crash)', () => {
    const p = createAIProvider({ apiKey: 'k' }); // no injected http, node has no Soup
    p.ask('q', {}, (err) => {
        assert.ok(['no-http-transport', 'network'].includes(err.error));
    });
});

test('cancel() invalidates in-flight ask: late completion is discarded', () => {
    let finish;
    const t = makeMockTransport((o, cb) => { finish = () => cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    let called = 0;
    p.ask('q', {}, () => called++);
    p.cancel();          // user cancels before the response arrives
    finish();            // late network completion
    assert.equal(called, 0);
    // provider still usable afterwards
    p.ask('lagi', {}, (err, res) => {
        assert.equal(err, null);
        assert.ok(res.answer.length > 0);
    });
});

test('cancellable context forwarded to transport', () => {
    let seen = null;
    const fakeCancellable = { is_cancelled: () => false };
    const t = makeMockTransport((o, cb) => { seen = o.cancellable; cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    p.ask('q', { cancellable: fakeCancellable }, () => {});
    assert.equal(seen, fakeCancellable);
});
