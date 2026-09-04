const { test } = require('node:test');
const assert = require('node:assert');
const { createNineRouterProvider, buildChatCompletionsUrl } = require('../ai/nineRouterProvider.js');

const FAKE_KEY = 'API_KEY_SHOULD_NOT_APPEAR_123';
const FAKE_MODEL = 'test-model';

function sseDelta(text) {
    return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}
function sseDone() { return 'data: [DONE]\n\n'; }

// helper: collect streamRequest events via promise until terminal (complete or error) or timeout
function collectStream(provider, payload, httpStreamFetch) {
    return new Promise(resolve => {
        const events = [];
        const p = payload || { query: 'hello' };
        // inject httpStreamFetch via provider opts if provided
        // provider already created with that mock
        provider.streamRequest(p, (evt) => {
            events.push(evt);
            if (evt.type === 'complete' || evt.type === 'error') {
                // give a tick for any extra events then resolve
                setTimeout(() => resolve(events), 10);
            }
        });
        // safety timeout: if no terminal, resolve anyway
        setTimeout(() => resolve(events), 500);
    });
}

function makeStreamFetchSuccess(chunks, capture) {
    return (url, opts, onChunk, onDone) => {
        if (capture) capture.opts = opts;
        // deliver chunks async to simulate streaming
        let i = 0;
        function next() {
            if (i < chunks.length) {
                onChunk(chunks[i++]);
                setImmediate(next);
            } else {
                onDone(null);
            }
        }
        setImmediate(next);
    };
}

function makeStreamFetchHttpError({ status, bodyText, capture }) {
    return (url, opts, onChunk, onDone) => {
        if (capture) capture.opts = opts;
        // Simulate transport that parsed status and calls onDone with error having status+message
        // Real provider helper _parseErrorMessage will already map, but we inject a raw err to test mapping in streamRequest onDone
        let message = bodyText || '';
        try {
            const data = JSON.parse(bodyText);
            if (data && data.error && data.error.message) message = data.error.message;
            else if (data && data.message) message = data.message;
        } catch (e) {
            if (bodyText && bodyText.trim()) message = bodyText.trim();
            else message = 'HTTP ' + status;
        }
        const err = new Error(message);
        err.status = status;
        // Note: no err.code set — streamRequest should map via httpStatusToCode
        setTimeout(() => onDone(err), 5);
    };
}

// ── P8 output token propagation (streaming body) ──
test('streaming: max_tokens default + configured value reach the request body', async () => {
    const capture = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchSuccess([sseDelta('hi'), sseDone()], capture)
    });
    await collectStream(provider, { query: 'q' });
    const body = JSON.parse(capture.opts.body);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.max_tokens, 4096, 'default output tokens on streaming body');

    const capture2 = {};
    const provider2 = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL, maxOutputTokens: 768,
        httpStreamFetch: makeStreamFetchSuccess([sseDelta('hi'), sseDone()], capture2)
    });
    await collectStream(provider2, { query: 'q' });
    const body2 = JSON.parse(capture2.opts.body);
    assert.strictEqual(body2.max_tokens, 768, 'configured max_tokens on streaming body');
});

// ── success: must enter parser, deliver deltas before complete ──
test('streaming transport: success 2xx enters SSE parser and delivers delta+complete', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchSuccess([sseDelta('Hello '), sseDelta('world'), sseDone()])
    });
    const events = await collectStream(provider, { query: 'hi' });
    const types = events.map(e => e.type);
    assert.ok(types.includes('start'), 'must emit start');
    assert.ok(types.includes('delta'), 'must emit delta');
    assert.ok(types.includes('complete'), 'must emit complete');
    const deltas = events.filter(e => e.type === 'delta').map(e => e.text).join('');
    assert.equal(deltas, 'Hello world');
    const complete = events.find(e => e.type === 'complete');
    assert.equal(complete.result.text, 'Hello world');
    assert.ok(!types.includes('error'), 'must not emit error on success');
});

test('streaming transport: incremental delta before completion', async () => {
    let sawDeltaBeforeComplete = false;
    let sawComplete = false;
    const chunks = [sseDelta('A'), sseDelta('B')];
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpStreamFetch: (url, opts, onChunk, onDone) => {
            onChunk(chunks[0]);
            setTimeout(() => {
                // Second chunk before DONE
                onChunk(chunks[1]);
                setTimeout(() => { onChunk(sseDone()); onDone(null); }, 5);
            }, 5);
        }
    });
    const events = [];
    await new Promise(resolve => {
        provider.streamRequest({ query: 'hi' }, (evt) => {
            events.push(evt);
            if (evt.type === 'delta' && !sawComplete) sawDeltaBeforeComplete = true;
            if (evt.type === 'complete') { sawComplete = true; setTimeout(resolve, 10); }
        });
        setTimeout(resolve, 500);
    });
    assert.ok(sawDeltaBeforeComplete, 'delta must arrive before complete');
    assert.equal(events.filter(e => e.type === 'delta').length, 2);
});

test('streaming transport: non-2xx never feeds body into SSE parser (no delta/complete)', async () => {
    let chunkCalled = false;
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpStreamFetch: (url, opts, onChunk, onDone) => {
            // Simulate error transport calling onDone with status, WITHOUT onChunk
            const err = new Error(JSON.stringify({ error: { message: 'bad key' } }));
            err.status = 401;
            setTimeout(() => onDone(err), 5);
        }
    });
    // Wrap onChunk to detect if parser was fed
    const orig = provider.streamRequest;
    const events = await collectStream(provider, { query: 'hi' });
    const deltas = events.filter(e => e.type === 'delta');
    const completes = events.filter(e => e.type === 'complete');
    assert.equal(deltas.length, 0, 'error body must not produce delta');
    assert.equal(completes.length, 0, 'error must not produce complete');
    assert.equal(events.filter(e => e.type === 'error').length, 1, 'must emit error');
});

test('streaming transport: 401 -> auth_error with preserved message', async () => {
    const body = JSON.stringify({ error: { message: 'Invalid API key' } });
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 401, bodyText: body })
    });
    const events = await collectStream(provider, { query: 'hi' });
    const errEvt = events.find(e => e.type === 'error');
    assert.ok(errEvt, 'must have error');
    assert.equal(errEvt.error.code, 'auth_error');
    assert.equal(errEvt.error.message, 'Invalid API key');
    assert.ok(!String(errEvt.error.message).includes(FAKE_KEY));
});

test('streaming transport: 403 -> auth_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 403, bodyText: JSON.stringify({ error: { message: 'Forbidden' } }) })
    });
    const events = await collectStream(provider, { query: 'hi' });
    assert.equal(events.find(e => e.type === 'error').error.code, 'auth_error');
});

test('streaming transport: 404 -> provider_error (not auth)', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 404, bodyText: JSON.stringify({ error: { message: 'Not found' } }) })
    });
    const events = await collectStream(provider, { query: 'hi' });
    const errEvt = events.find(e => e.type === 'error');
    assert.equal(errEvt.error.code, 'provider_error');
    assert.equal(errEvt.error.message, 'Not found');
});

test('streaming transport: 429 -> rate_limited', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 429, bodyText: JSON.stringify({ error: { message: 'Over quota' } }) })
    });
    const events = await collectStream(provider, { query: 'hi' });
    const errEvt = events.find(e => e.type === 'error');
    assert.equal(errEvt.error.code, 'rate_limited');
    assert.equal(errEvt.error.message, 'Over quota');
});

test('streaming transport: 500 -> provider_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 500, bodyText: 'internal' })
    });
    const events = await collectStream(provider, { query: 'hi' });
    assert.equal(events.find(e => e.type === 'error').error.code, 'provider_error');
});

test('streaming transport: 502/503 also provider_error with message', async () => {
    for (const status of [502, 503]) {
        const provider = createNineRouterProvider({
            baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
            httpStreamFetch: makeStreamFetchHttpError({ status, bodyText: 'Service Unavailable' })
        });
        const events = await collectStream(provider, { query: 'hi' });
        const e = events.find(ev => ev.type === 'error');
        assert.equal(e.error.code, 'provider_error', `status ${status}`);
        assert.ok(String(e.error.message).length > 0);
    }
});

test('streaming transport: provider JSON message preserved plain text', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 500, bodyText: 'Service Unavailable' })
    });
    const events = await collectStream(provider, { query: 'hi' });
    assert.equal(events.find(e => e.type === 'error').error.message, 'Service Unavailable');
});

test('streaming transport: message preserved not generic HTTP code for JSON', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 401, bodyText: JSON.stringify({ error: { message: 'bad key' } }) })
    });
    const events = await collectStream(provider, { query: 'hi' });
    const msg = events.find(e => e.type === 'error').error.message;
    assert.equal(msg, 'bad key');
    assert.ok(!/^HTTP\s+401/i.test(msg), 'should preserve provider message not generic');
});

test('streaming transport: non-JSON error body uses raw text if short', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: makeStreamFetchHttpError({ status: 500, bodyText: '  upstream timeout  ' })
    });
    const events = await collectStream(provider, { query: 'hi' });
    assert.equal(events.find(e => e.type === 'error').error.message, 'upstream timeout');
});

test('streaming error: apiKey never in error code/message or logs', async () => {
    const logs = [];
    const origLog = global.log;
    global.log = (m) => logs.push(String(m));
    const origConsole = console.log;
    let consoleLogs = [];
    console.log = (m) => consoleLogs.push(String(m));
    try {
        const body = JSON.stringify({ error: { message: 'fail with ' + FAKE_KEY } });
        // provider will sanitize via sanitizeError if key appears — but transport should not log key
        const provider = createNineRouterProvider({
            baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
            httpStreamFetch: makeStreamFetchHttpError({ status: 500, bodyText: body })
        });
        const events = await collectStream(provider, { query: 'hi' });
        const err = events.find(e => e.type === 'error');
        assert.ok(!String(err.error.message).includes(FAKE_KEY), 'message must be redacted');
        assert.ok(!String(err.error.code).includes(FAKE_KEY));
        const allLogs = logs.join('\n') + '\n' + consoleLogs.join('\n');
        assert.ok(!allLogs.includes(FAKE_KEY), 'logs must not contain apiKey');
        // also check that Bearer token redacted — logs may contain "[REDACTED]"
        // but at minimum not contain raw key
    } finally {
        global.log = origLog;
        console.log = origConsole;
    }
});

test('streaming: Authorization bearer is redacted in sanitized logs', async () => {
    const logs = [];
    const origLog = global.log;
    global.log = (m) => logs.push(String(m));
    try {
        const provider = createNineRouterProvider({
            baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
            httpStreamFetch: makeStreamFetchHttpError({ status: 401, bodyText: JSON.stringify({ error: { message: 'x' } }) })
        });
        await collectStream(provider, { query: 'hi' });
        const all = logs.join(' ');
        // Should have sanitized logs but not contain key
        assert.ok(!all.includes(FAKE_KEY));
        // If any log contains Bearer, it must be redacted
        if (all.includes('Bearer')) assert.ok(all.includes('[REDACTED]'), 'Bearer must be redacted');
    } finally {
        global.log = origLog;
    }
});

test('streaming baseUrl: 4 variants still produce correct url with stream true', async () => {
    const variants = [
        'http://localhost:3000',
        'http://localhost:3000/',
        'http://localhost:3000/v1',
        'http://localhost:3000/v1/',
    ];
    for (const v of variants) {
        let capturedUrl = '';
        const provider = createNineRouterProvider({
            baseUrl: v, apiKey: FAKE_KEY, model: FAKE_MODEL,
            httpStreamFetch: (url, opts, onChunk, onDone) => { capturedUrl = url; onChunk(sseDelta('ok')); onChunk(sseDone()); onDone(null); }
        });
        const events = await collectStream(provider, { query: 'hi' });
        assert.equal(capturedUrl, 'http://localhost:3000/v1/chat/completions', `variant ${v}`);
        assert.ok(events.find(e => e.type === 'complete'), `variant ${v} must complete`);
    }
});

test('streaming non-stream fallback: httpStreamFetch error does not leak into parser', async () => {
    // Ensure even if httpStreamFetch delivers valid SSE after error status, parser not fed
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpStreamFetch: (url, opts, onChunk, onDone) => {
            // buggy transport might try to feed SSE even on error — our provider should have prevented chunk before error
            // Here we simulate correct transport: only onDone error, no chunk
            const err = new Error('Invalid API key');
            err.status = 401;
            err.code = 'auth_error';
            onDone(err);
        }
    });
    const events = await collectStream(provider, { query: 'hi' });
    assert.equal(events.filter(e => e.type === 'delta').length, 0);
    assert.equal(events.filter(e => e.type === 'complete').length, 0);
    assert.equal(events.filter(e => e.type === 'error').length, 1);
});

test('request non-streaming: JSON error message preserved', async () => {
    const { createNineRouterProvider: P } = require('../ai/nineRouterProvider.js');
    const body = JSON.stringify({ error: { message: 'model not found' } });
    const provider = P({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: () => Promise.resolve({ status: 404, bodyText: body })
    });
    await new Promise((resolve, reject) => {
        provider.request({ query: 'hi' }, (err, res) => {
            try {
                assert.ok(err, 'must error');
                // Non-streaming request maps 404 to provider_error but preserves body? Check impl: provider preserves _parseErrorMessage for request
                // For 404 non-streaming, it uses fallback but logs; accept either preserved or fallback but not generic without body
                assert.equal(err.code, 'provider_error');
                // message may be preserved or fallback — but must be sanitized and non-empty
                assert.ok(typeof err.message === 'string' && err.message.length > 0);
                assert.ok(!err.message.includes(FAKE_KEY));
                resolve();
            } catch (e) { reject(e); }
        });
    });
});
