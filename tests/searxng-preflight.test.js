// SearXNG pre-flight availability check tests (Phase 14 latency).
// TEST-ONLY: no real network. Injected httpGet transport.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebProvider } = require('../providers/webProvider.js');

function make(searxngUrl, httpGet) {
    return createWebProvider({
        makeResult: o => o,
        scoreResult: () => 1,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'searxng',
        searxngUrl: searxngUrl || 'http://127.0.0.1:8080',
        httpGet: httpGet || ((url, c, cb) => cb(null, '{"results":[]}'))
    });
}

test('preflight: available → search proceeds with HTTP', (_, done) => {
    let httpCalls = 0;
    const wp = make('http://127.0.0.1:8080', (url, c, cb) => { httpCalls++; cb(null, '{"results":[]}'); });
    wp.preflight(err => {
        assert.equal(err, null, 'no error on available instance');
        httpCalls = 0;
        wp.search('test query', null, () => {
            // Instant fallback fires synchronously; httpGet fires after.
            // Use setTimeout(0) to check after httpGet completes.
            setTimeout(() => {
                assert.ok(httpCalls >= 1, 'search made HTTP call after successful preflight');
                wp.destroy();
                done();
            }, 0);
        });
    });
});

test('preflight: unavailable → search skips HTTP entirely', (_, done) => {
    let httpCalls = 0;
    const wp = make('http://127.0.0.1:19999', (url, c, cb) => {
        httpCalls++;
        cb(new Error('connection refused'));
    });
    wp.preflight(err => {
        assert.ok(err, 'preflight reports error');
        httpCalls = 0;
        wp.search('test query', null, () => {
            assert.equal(httpCalls, 0, 'search skipped HTTP after failed preflight');
            wp.destroy();
            done();
        });
    });
});

test('preflight: non-searxng engine → preflight is a no-op', (_, done) => {
    let httpCalls = 0;
    const wp = createWebProvider({
        makeResult: o => o,
        scoreResult: () => 1,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'ddgo',
        httpGet: (url, c, cb) => { httpCalls++; cb(null, '{}'); }
    });
    wp.preflight(err => {
        assert.equal(err, null, 'no error for non-searxng engine');
        assert.equal(httpCalls, 0, 'no HTTP call for non-searxng preflight');
        wp.destroy();
        done();
    });
});

test('preflight: custom searxng URL is pinged', (_, done) => {
    let pingedUrl = '';
    const wp = make('http://localhost:9090', (url, c, cb) => {
        pingedUrl = url;
        cb(null, '{"results":[]}');
    });
    wp.preflight(err => {
        assert.equal(err, null);
        assert.ok(pingedUrl.startsWith('http://localhost:9090'), 'preflight used custom URL: ' + pingedUrl);
        assert.ok(pingedUrl.includes('format=json'), 'preflight requested JSON format');
        wp.destroy();
        done();
    });
});

test('preflight: destroy resets availability cache', (_, done) => {
    const wp = make('http://127.0.0.1:8080', (url, c, cb) => cb(null, '{"results":[]}'));
    wp.preflight(err => {
        assert.equal(err, null);
        wp.destroy();
        let httpCalls = 0;
        const wp2 = make('http://127.0.0.1:8080', (url, c, cb) => { httpCalls++; cb(null, '{"results":[]}'); });
        wp2.search('test', null, () => {
            setTimeout(() => {
                assert.ok(httpCalls >= 1, 'search attempted HTTP after destroy reset');
                wp2.destroy();
                done();
            }, 0);
        });
    });
});

test('preflight: fast failure when endpoint unreachable', (_, done) => {
    const t0 = Date.now();
    const wp = make('http://10.255.255.1:1', (url, c, cb) => {
        cb(new Error('ECONNREFUSED'));
    });
    wp.preflight(err => {
        const dt = Date.now() - t0;
        assert.ok(err, 'preflight reports error');
        assert.ok(dt < 500, 'preflight failed fast: ' + dt + 'ms');
        wp.destroy();
        done();
    });
});
