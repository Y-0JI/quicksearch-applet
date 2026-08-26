const { test } = require('node:test');
const assert = require('node:assert');
const { createAIProvider, DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_MAX_TOKENS } = require('../providers/aiProvider.js');

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
    assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS); // default raised for reasoning combos
    assert.ok(captured.timeoutMs > 0);
});

test('max_tokens override is forwarded', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = createAIProvider({ apiKey: 'k', http: t, maxTokens: 7777 });
    p.ask('q', {}, () => {});
    assert.equal(JSON.parse(captured.body).max_tokens, 7777);
});

test('finish_reason=length with usable content is still SUCCESS', () => {
    const body = JSON.stringify({ choices: [{ finish_reason: 'length',
        message: { role: 'assistant', content: 'jawaban parsial tapi ada' } }] });
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: body }));
    const p = makeProvider(t);
    p.ask('q', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.answer, 'jawaban parsial tapi ada');
    });
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

test('phase 5: cancel() aborts via cancellable -> cancelled error surfaces', () => {
    let cancelledFlag = false;
    let storedCb = null;
    const fakeCancellable = {
        is_cancelled: () => cancelledFlag,
        cancel: () => { cancelledFlag = true; } // simulate Gio behaviour
    };
    const t = makeMockTransport((o, cb) => {
        storedCb = () => {
            if (o.cancellable && o.cancellable.is_cancelled()) {
                cb({ error: 'cancelled' });
                return;
            }
            cb(null, { status: 200, text: OK_BODY });
        };
    });
    const p = createAIProvider({ apiKey: 'k', http: t, cancellable: fakeCancellable });
    let got = null;
    p.ask('q', {}, (err) => { got = err; });
    p.cancel(); // bumps gen AND aborts the real request
    storedCb(); // transport settles AFTER the cancel
    assert.ok(cancelledFlag, 'transport cancellable was cancelled');
    // cancelled passes through the stale guard (terminal state)
    assert.equal(got.error, 'cancelled');
});

test('phase 5: timeout error normalized from transport message', () => {
    const t = makeMockTransport((o, cb) => cb({ error: 'timeout', detail: 'Timed out' }));
    const p = makeProvider(t);
    p.ask('q', {}, (err) => {
        assert.equal(err.error, 'timeout');
        assert.equal(err.detail, 'Timed out');
    });
});

test('phase 5: non-cancelled stale completion is still dropped', () => {
    let finish;
    const t = makeMockTransport((o, cb) => { finish = () => cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    let called = 0;
    p.ask('q', {}, () => called++);
    p.ask('q2', {}, () => called++); // newer ask supersedes
    finish(); // OLD completion arrives late
    assert.equal(called, 1); // only the newer ask resolved
});

// ---- Phase 9: agent-loop tool support (additive) ----

test('phase 9: ctx.tools included in request body', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    const tools = [{ type: 'function', function: {
        name: 'calculator', description: 'd', parameters: { type: 'object', properties: {} } } }];
    p.ask('q', { tools }, () => {});
    assert.deepEqual(JSON.parse(captured.body).tools, tools);
});

test('phase 9: no ctx.tools -> body has NO tools key (legacy shape intact)', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    makeProvider(t).ask('q', {}, () => {});
    assert.equal('tools' in JSON.parse(captured.body), false);
});

test('phase 9: role tool + assistant tool_calls pass through to body', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    const rawCalls = [{ id: 'c1', type: 'function',
        function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }];
    p.ask('lanjut', { messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: rawCalls },
        { role: 'tool', tool_call_id: 'c1', content: '{"value":"4"}' }
    ] }, () => {});
    const msgs = JSON.parse(captured.body).messages;
    assert.equal(msgs[1].role, 'assistant');
    assert.deepEqual(msgs[1].tool_calls, rawCalls);
    assert.equal(msgs[2].role, 'tool');
    assert.equal(msgs[2].tool_call_id, 'c1');
    assert.equal(msgs[2].content, '{"value":"4"}');
});

test('phase 9: tool_calls response normalized BEFORE empty-content check', () => {
    const body = JSON.stringify({ model: 'm', choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_1', type: 'function',
            function: { name: 'search_files', arguments: '{"query":"laporan"}' } }] } }] });
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: body }));
    makeProvider(t).ask('q', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.answer, '');
        assert.deepEqual(res.toolCalls, [
            { id: 'call_1', name: 'search_files', argsJson: '{"query":"laporan"}' }]);
    });
});

test('phase 9: content + tool_calls together keeps both fields', () => {
    const body = JSON.stringify({ model: 'm', choices: [{ message: {
        role: 'assistant', content: 'sedang mencari...',
        tool_calls: [{ id: 't9', type: 'function',
            function: { name: 'search_web', arguments: '{"query":"cuaca"}' } }] } }] });
    const t = makeMockTransport((o, cb) => cb(null, { status: 200, text: body }));
    makeProvider(t).ask('q', {}, (err, res) => {
        assert.equal(err, null);
        assert.equal(res.answer, 'sedang mencari...');
        assert.equal(res.toolCalls.length, 1);
        assert.equal(res.toolCalls[0].name, 'search_web');
    });
});

// ---- Phase 10: multimodal content pass-through ----

test('phase 10: array (multimodal) content passes through untouched', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    const p = makeProvider(t);
    const IMG = 'data:image/png;base64,iVBORw0KGgo=';
    const content = [
        { type: 'text', text: '(screenshot layar terlampir)' },
        { type: 'image_url', image_url: { url: IMG } }
    ];
    p.ask('q', { messages: [{ role: 'user', content: content }] }, () => {});
    const msgs = JSON.parse(captured.body).messages;
    assert.equal(msgs[0].role, 'user');
    assert.deepEqual(msgs[0].content, content, 'multimodal shape must survive verbatim');
});

test('phase 10: string content still coerced exactly as before', () => {
    let captured = null;
    const t = makeMockTransport((o, cb) => { captured = o; cb(null, { status: 200, text: OK_BODY }); });
    makeProvider(t).ask('q', { messages: [{ role: 'user', content: 12345 }] }, () => {});
    assert.equal(JSON.parse(captured.body).messages[0].content, '12345');
});
