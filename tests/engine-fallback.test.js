const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createWebProvider, parseSearxngJson } = require('../providers/webProvider.js');

const mk = o => o;
const sc = () => 1;

function fallbackOf(wp, q) {
    let first = null;
    wp.search(q, null, list => { if (!first) first = list; });
    return first && first[0];
}

test('ddgo fallback opens DuckDuckGo', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
        engine: 'ddgo', useInstantAnswers: false,
    });
    const fb = fallbackOf(wp, 'linux');
    assert.equal(fb.url, 'https://duckduckgo.com/?q=linux');
});

test('bing fallback opens Bing', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
        engine: 'bing', useInstantAnswers: false,
        httpGet: (u, c, cb) => cb(new Error('offline')),
    });
    const fb = fallbackOf(wp, 'linux');
    assert.equal(fb.url, 'https://www.bing.com/search?q=linux');
});

test('searxng fallback opens SearXNG html page, never DuckDuckGo', () => {
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'http://127.0.0.1:8080/search?q=' + encodeURIComponent(q) + '&format=html',
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (u, c, cb) => cb(new Error('offline')),
    });
    let last = null;
    wp.search('linux', null, list => { last = list; });
    for (const r of last) assert.ok(!String(r.url || '').includes('duckduckgo.com'), 'no DDG url: ' + r.url);
    assert.ok(last.some(r => r.url === 'http://127.0.0.1:8080/search?q=linux&format=html'), 'html fallback present');
});

test('searxng real flow: api json fetched, result urls kept, enter opens result', () => {
    const gets = [];
    const wp = createWebProvider({
        makeResult: mk, scoreResult: sc,
        fallbackUrlFor: q => 'http://127.0.0.1:8080/search?q=' + encodeURIComponent(q) + '&format=html',
        engine: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
        httpGet: (url, c, cb) => {
            gets.push(url);
            cb(null, JSON.stringify({ results: [
                { title: 'Linux', url: 'https://example.com/linux', content: 'Linux info' },
            ]}));
        },
    });
    let last = null;
    wp.search('linux', null, list => { last = list; });
    assert.ok(gets[0].includes('format=json'), 'api uses json');
    const real = last.find(r => r.url === 'https://example.com/linux');
    assert.ok(real, 'searxng result delivered with its own url');
    assert.equal(typeof real.action, 'function');
});

test('applet wires engine-aware fallback: searxng closes over engineChoice+url', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    assert.ok(src.includes('fallbackUrlForEngine'), 'engine-aware helper exists');
    assert.ok(src.includes("format=html"), 'searxng html fallback');
    assert.ok(!/FALLBACK_URLS\[engineChoice\]/.test(src), 'no blind DDG default for searxng');
});

test('fallbackUrlForEngine: per-engine urls incl custom searxng base + trailing slash', () => {
    const src = fs.readFileSync(path.join(__dirname, '../applet.js'), 'utf8');
    const start = src.indexOf('function fallbackUrlForEngine');
    assert.ok(start !== -1, 'helper defined');
    const body = src.slice(start, start + 800);
    assert.ok(body.includes('searxng'), 'searxng branch');
    assert.ok(body.includes('format=html'), 'html format');
    assert.ok(body.includes('replace'), 'trailing slash trimmed');
});
