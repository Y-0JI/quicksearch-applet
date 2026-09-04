const { test } = require('node:test');
const assert = require('node:assert');
const { createNineRouterProvider, buildChatCompletionsUrl, buildRequestBody } = require('../ai/nineRouterProvider.js');

const FAKE_KEY = 'API_KEY_SHOULD_NOT_APPEAR_123';
const FAKE_MODEL = 'test-model';

function makeFetchMock({ status = 200, bodyText = '', shouldThrow = null, capture = null, delayMs = 0 } = {}) {
    // capture: { url, method, headers, body, cancellable }
    return (url, opts) => {
        if (capture) {
            capture.url = url;
            capture.method = opts.method;
            capture.headers = opts.headers;
            capture.body = opts.body;
            capture.cancellable = opts.cancellable;
        }
        if (shouldThrow) return Promise.reject(shouldThrow);
        if (delayMs > 0) return new Promise(resolve => setTimeout(() => resolve({ status, bodyText }), delayMs));
        return Promise.resolve({ status, bodyText });
    };
}

function okBody(text) {
    return JSON.stringify({ choices: [{ message: { content: text } }] });
}

function requestAsync(provider, payload, cancellable) {
    return new Promise((resolve, reject) => {
        const cb = (err, res) => err ? reject(err) : resolve(res);
        if (cancellable) provider.request(payload, cancellable, cb);
        else provider.request(payload, cb);
    });
}

// ── Endpoint ──
test('endpoint: 4 baseUrl variants produce same /v1/chat/completions', () => {
    const variants = [
        'http://localhost:3000',
        'http://localhost:3000/',
        'http://localhost:3000/v1',
        'http://localhost:3000/v1/',
    ];
    for (const v of variants) {
        const url = buildChatCompletionsUrl(v);
        assert.equal(url, 'http://localhost:3000/v1/chat/completions', `variant ${v}`);
        assert.ok(!url.includes('//chat'), `no double slash for ${v}`);
        assert.ok(!url.includes('/v1/v1'), `no double v1 for ${v}`);
    }
});

test('endpoint: custom host preserved', () => {
    const url = buildChatCompletionsUrl('https://api.9router.example.com');
    assert.equal(url, 'https://api.9router.example.com/v1/chat/completions');
});

// ── Request ──
test('request: POST with correct headers, model, messages, stream false', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('hello'), capture: cap })
    });
    const res = await requestAsync(provider, { query: 'hi', systemPrompt: 'sys' });
    assert.equal(cap.method, 'POST');
    assert.ok(cap.url.endsWith('/v1/chat/completions'));
    assert.equal(cap.headers['Authorization'], 'Bearer ' + FAKE_KEY);
    assert.equal(cap.headers['Content-Type'], 'application/json');
    const body = JSON.parse(cap.body);
    assert.equal(body.model, FAKE_MODEL);
    assert.equal(body.stream, false);
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(res.text, 'hello');
    assert.equal(res.type, 'answer');
});

test('request: groundingContext appended to user content', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('ok'), capture: cap })
    });
    await requestAsync(provider, { query: 'q', systemPrompt: 's', groundingContext: 'ctx' });
    const body = JSON.parse(cap.body);
    const userMsg = body.messages.find(m => m.role === 'user');
    assert.ok(userMsg.content.includes('q'));
    assert.ok(userMsg.content.includes('ctx'));
});

test('request: Authorization header contains apiKey value', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000',
        apiKey: FAKE_KEY,
        model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('x'), capture: cap })
    });
    await requestAsync(provider, { query: 'hi' });
    assert.equal(cap.headers['Authorization'], 'Bearer ' + FAKE_KEY);
});

// ── Response parsing ──
test('response: normal answer', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('answer text') })
    });
    const res = await requestAsync(provider, { query: 'q' });
    assert.equal(res.type, 'answer');
    assert.equal(res.text, 'answer text');
});

test('response: empty content is valid answer with empty text', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('') })
    });
    const res = await requestAsync(provider, { query: 'q' });
    assert.equal(res.type, 'answer');
    assert.equal(res.text, '');
});

test('response: invalid JSON -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: 'not json{' })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => {
        assert.equal(err.code, 'invalid_response');
        return true;
    });
});

test('response: missing choices -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({}) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'invalid_response'); return true; });
});

test('response: empty choices -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({ choices: [] }) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'invalid_response'); return true; });
});

test('response: missing message -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({ choices: [{}] }) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'invalid_response'); return true; });
});

test('response: missing content -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({ choices: [{ message: {} }] }) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'invalid_response'); return true; });
});

test('response: non-string content -> invalid_response', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({ choices: [{ message: { content: 123 } }] }) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'invalid_response'); return true; });
});

test('response: error payload with 200 -> provider_error or invalid', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: JSON.stringify({ error: { message: 'oops' } }) })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => {
        assert.ok(['provider_error', 'invalid_response'].includes(err.code));
        return true;
    });
});

// ── HTTP errors ──
test('http error: 401 -> auth_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ status: 401, bodyText: 'unauthorized' })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'auth_error'); return true; });
});

test('http error: 403 -> auth_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ status: 403, bodyText: 'forbidden' })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'auth_error'); return true; });
});

test('http error: 429 -> rate_limited', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ status: 429, bodyText: 'rate' })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'rate_limited'); return true; });
});

test('http error: 500 -> provider_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ status: 500, bodyText: 'internal' })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'provider_error'); return true; });
});

test('http error: network exception -> network_error', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ shouldThrow: new Error('ECONNREFUSED') })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'network_error'); return true; });
});

test('http error: missing apiKey -> auth_error without HTTP', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: '', model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('x') })
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'auth_error'); return true; });
});

// ── Timeout ──
test('timeout: pending request times out', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 50,
        httpFetch: () => new Promise(() => {}) // never resolves
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => { assert.equal(err.code, 'timeout'); return true; });
});

test('timeout: late completion after timeout is ignored', async () => {
    let resolveFetch;
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 40,
        httpFetch: () => new Promise(resolve => { resolveFetch = resolve; })
    });
    let firstErr = null;
    const p1 = requestAsync(provider, { query: 'q' }).catch(e => { firstErr = e; throw e; });
    await assert.rejects(p1, err => { assert.equal(err.code, 'timeout'); return true; });
    // late resolve should not throw or change state
    if (resolveFetch) resolveFetch({ status: 200, bodyText: okBody('late') });
    // second request should still succeed
    const provider2 = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('second') })
    });
    const res = await requestAsync(provider2, { query: 'q2' });
    assert.equal(res.text, 'second');
});

// ── Cancellation ──
test('cancellation: cancelled request does not succeed', async () => {
    const cancellable = { is_cancelled: () => false, cancel() { this.is_cancelled = () => true; } };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: () => new Promise(resolve => setTimeout(() => resolve({ status: 200, bodyText: okBody('late') }), 30))
    });
    const promise = requestAsync(provider, { query: 'q' }, cancellable);
    // cancel before fetch resolves
    setTimeout(() => cancellable.cancel(), 10);
    await assert.rejects(promise, err => { assert.equal(err.code, 'cancelled'); return true; });
});

test('cancellation: destroy mid-pending is safe', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 500,
        httpFetch: () => new Promise(() => {})
    });
    const p = requestAsync(provider, { query: 'q' }).catch(() => {});
    provider.destroy();
    // next request should fail with provider_error (destroyed)
    await assert.rejects(requestAsync(provider, { query: 'q2' }), err => {
        assert.equal(err.code, 'provider_error');
        return true;
    });
});

// ── Integration with AISearchEngine: stale protection ──
test('integration: engine stale protects NineRouterProvider', async () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
    // provider that holds first request
    let firstCb = null;
    const provider = {
        request(payload, cancellable, cb) {
            if (typeof cancellable === 'function') { cb = cancellable; cancellable = null; }
            if (payload.query === 'first') { firstCb = cb; return; }
            // second resolves immediately
            setTimeout(() => cb(null, { type: 'answer', text: 'second' }), 5);
        },
        destroy() {}
    };
    const tool = createMockWebSearchTool();
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let gotFirst = null, gotSecond = null;
    engine.search('first', { onAnswer: d => { gotFirst = d; } });
    // start second — should gen bump and cancel first's cancellable
    await new Promise(r => setTimeout(r, 10));
    engine.search('second', { onAnswer: d => { gotSecond = d; } });
    // late first
    if (firstCb) firstCb(null, { type: 'answer', text: 'first-late' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(gotFirst, null);
    assert.equal(gotSecond.text, 'second');
});

// ── Secret safety ──
test('secret safety: errors never contain apiKey', async () => {
    const cases = [
        makeFetchMock({ bodyText: 'not json' }),
        makeFetchMock({ bodyText: JSON.stringify({}) }),
        makeFetchMock({ status: 401, bodyText: 'unauthorized' }),
        makeFetchMock({ status: 429, bodyText: 'rate' }),
        makeFetchMock({ status: 500, bodyText: 'oops' }),
        makeFetchMock({ shouldThrow: new Error('network') }),
    ];
    for (const fetch of cases) {
        const provider = createNineRouterProvider({
            baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
            httpFetch: fetch
        });
        try {
            await requestAsync(provider, { query: 'q' });
            assert.fail('should have thrown');
        } catch (err) {
            assert.ok(!String(err.message).includes(FAKE_KEY), `leak in message: ${err.message}`);
            assert.ok(!String(err.code).includes(FAKE_KEY));
            // check cause too if present
            if (err.cause) assert.ok(!String(err.cause.message || err.cause).includes(FAKE_KEY));
        }
    }
});

// ── Final Gate mandatory: hanging cancel, destroy, AbortError ──
test('gate: hanging transport immediate cancelled on cancel, late success ignored', async () => {
    let resolveFetch;
    let rejectFetch;
    const hangingFetch = () => new Promise((res, rej) => { resolveFetch = res; rejectFetch = rej; });
    const cancellable = { _c: false, is_cancelled() { return this._c; }, cancel() { this._c = true; } };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 5000,
        httpFetch: hangingFetch
    });
    let cbCalls = 0;
    let cbErr = null;
    provider.request({ query: 'q' }, cancellable, (err, res) => { cbCalls++; cbErr = err || res; });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(cbCalls, 0, 'not yet completed before cancel');
    cancellable.cancel();
    // must settle promptly, not wait for timeout (5000ms) — give 80ms budget
    await new Promise(r => setTimeout(r, 40));
    assert.equal(cbCalls, 1, 'cancel delivers exactly once promptly');
    assert.equal(cbErr.code, 'cancelled');
    // late fetch success must not produce second callback or success
    if (resolveFetch) resolveFetch({ status: 200, bodyText: okBody('late-should-be-ignored') });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(cbCalls, 1, 'late success ignored after cancel');
});

test('gate: Gio Cancellable connect path immediate cancelled', async () => {
    let handler = null;
    let handlerId = 0;
    let cancelled = false;
    const gioCancel = {
        is_cancelled() { return cancelled; },
        connect(sig, cb) { assert.equal(sig, 'cancelled'); handler = cb; return ++handlerId; },
        disconnect(id) { if (id === handlerId) handler = null; },
        cancel() { cancelled = true; if (handler) handler(); }
    };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 5000,
        httpFetch: () => new Promise(() => {})
    });
    let errCode = null;
    provider.request({ query: 'q' }, gioCancel, (err) => { errCode = err && err.code; });
    await new Promise(r => setTimeout(r, 5));
    gioCancel.cancel();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(errCode, 'cancelled');
});

test('gate: destroy pending must await completion cancelled (Promise)', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 5000,
        httpFetch: () => new Promise(() => {}) // hanging forever
    });
    const p = requestAsync(provider, { query: 'q' });
    // destroy while pending — must settle the awaiting Promise, not hang
    setTimeout(() => provider.destroy(), 10);
    await assert.rejects(p, err => { assert.equal(err.code, 'cancelled'); return true; });
    // second destroy + next request still provider_error
    assert.doesNotThrow(() => provider.destroy());
    await assert.rejects(requestAsync(provider, { query: 'q2' }), err => { assert.equal(err.code, 'provider_error'); return true; });
});

test('gate: destroy pending late response ignored', async () => {
    let resolveFetch;
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 5000,
        httpFetch: () => new Promise(res => { resolveFetch = res; })
    });
    let cbCalls = 0;
    let cbErr = null;
    provider.request({ query: 'q' }, (err) => { cbCalls++; cbErr = err; });
    provider.destroy();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(cbCalls, 1, 'destroy must complete pending with cancelled');
    assert.equal(cbErr && cbErr.code, 'cancelled');
    if (resolveFetch) resolveFetch({ status: 200, bodyText: okBody('late-after-destroy') });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(cbCalls, 1, 'late success ignored after destroy');
    assert.doesNotThrow(() => provider.destroy(), 'double-destroy after pending must not throw');
    await assert.rejects(requestAsync(provider, { query: 'q2' }), err => { assert.equal(err.code, 'provider_error'); return true; });
});

test('gate: double destroy idempotent no throw no double callback', () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('x') })
    });
    assert.doesNotThrow(() => provider.destroy());
    assert.doesNotThrow(() => provider.destroy());
    assert.doesNotThrow(() => provider.destroy());
});

test('gate: fetch AbortError mapped to cancelled not network_error', async () => {
    const abortErr = Object.assign(new Error('AbortError'), { name: 'AbortError' });
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: () => Promise.reject(abortErr)
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => {
        assert.equal(err.code, 'cancelled', 'AbortError must become cancelled');
        return true;
    });
});

test('gate: aborted message substring also maps to cancelled', async () => {
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: () => Promise.reject(new Error('aborted by signal'))
    });
    await assert.rejects(requestAsync(provider, { query: 'q' }), err => {
        assert.equal(err.code, 'cancelled');
        return true;
    });
});

test('gate: one-shot completion — cancel wins over late timeout', async () => {
    let resolveFetch;
    const cancellable = { _c: false, is_cancelled() { return this._c; }, cancel() { this._c = true; } };
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        timeoutMs: 40,
        httpFetch: () => new Promise(res => { resolveFetch = res; })
    });
    let codes = [];
    provider.request({ query: 'q' }, cancellable, (err) => { if (err) codes.push(err.code); else codes.push('success'); });
    await new Promise(r => setTimeout(r, 5));
    cancellable.cancel();
    await new Promise(r => setTimeout(r, 70));
    assert.equal(codes.length, 1, 'exactly one terminal');
    assert.equal(codes[0], 'cancelled', 'cancel must win, not timeout');
    if (resolveFetch) resolveFetch({ status: 200, bodyText: okBody('late') });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(codes.length, 1, 'late ignored after cancel+timeout race');
});

// ── P8 output token propagation ──
test('max_tokens: default 4096 reaches request body', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
        httpFetch: makeFetchMock({ bodyText: okBody('x'), capture: cap })
    });
    await requestAsync(provider, { query: 'q' });
    const body = JSON.parse(cap.body);
    assert.strictEqual(body.max_tokens, 4096, 'default output tokens');
});

test('max_tokens: configured value reaches request body', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL, maxOutputTokens: 1024,
        httpFetch: makeFetchMock({ bodyText: okBody('x'), capture: cap })
    });
    await requestAsync(provider, { query: 'q' });
    const body = JSON.parse(cap.body);
    assert.strictEqual(body.max_tokens, 1024);
});

test('max_tokens: clamped into [512, 16384]', async () => {
    const cap = {};
    const provider = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL, maxOutputTokens: 99,
        httpFetch: makeFetchMock({ bodyText: okBody('x'), capture: cap })
    });
    await requestAsync(provider, { query: 'q' });
    let body = JSON.parse(cap.body);
    assert.strictEqual(body.max_tokens, 512, 'low clamped up');
    const cap2 = {};
    const provider2 = createNineRouterProvider({
        baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL, maxOutputTokens: 90000,
        httpFetch: makeFetchMock({ bodyText: okBody('x'), capture: cap2 })
    });
    await requestAsync(provider2, { query: 'q' });
    body = JSON.parse(cap2.body);
    assert.strictEqual(body.max_tokens, 16384, 'high clamped down');
});

// ── buildRequestBody shape ──
test('buildRequestBody: contains model, messages, stream false', () => {
    const json = buildRequestBody('m', 'sys', 'user q');
    const obj = JSON.parse(json);
    assert.equal(obj.model, 'm');
    assert.equal(obj.stream, false);
    assert.equal(obj.messages.length, 2);
    assert.equal(obj.messages[0].role, 'system');
    assert.equal(obj.messages[1].role, 'user');
});

test('buildRequestBody: no systemPrompt omits system message', () => {
    const json = buildRequestBody('m', '', 'q');
    const obj = JSON.parse(json);
    assert.equal(obj.messages.length, 1);
    assert.equal(obj.messages[0].role, 'user');
});
