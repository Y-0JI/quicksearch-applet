// tests/ai-toolcall-markup.test.js - raw tool_calls XML must never reach the UI.
// T6 regression: model answered web_search with XML TEXT; it rendered verbatim.
// XML samples are built via concatenation so this file carries no raw markup.
const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../ai/toolCallMarkup.js');

function xmlDoc(query) {
    const t = 'tool_calls';
    const iv = 'invoke name="web_search"';
    const pm = 'parameter name="query"';
    return '<' + t + '>\n<' + iv + '>\n<' + pm + '>' + query + '</' + 'parameter>\n</' + 'invoke>\n</' + t + '>';
}

const Q = 'Linux Mint latest version September 2026';

test('A: full XML doc extracts tool + query', () => {
    const hit = T.extractXmlToolCall(xmlDoc(Q));
    assert.ok(hit, 'extracted');
    assert.equal(hit.tool, 'web_search');
    assert.equal(hit.query, Q);
});

test('B: full XML doc is recognized as only-markup', () => {
    assert.equal(T.isOnlyXmlToolCall(xmlDoc(Q)), true);
    assert.equal(T.isOnlyXmlToolCall('Versi terbaru adalah 22.3 ' + xmlDoc(Q)), false);
});

test('C: normal answer untouched', () => {
    assert.equal(T.extractXmlToolCall('Versi terbaru Linux Mint adalah 22.3.'), null);
    assert.equal(T.stripToolCallMarkup('Versi terbaru Linux Mint adalah 22.3.'), 'Versi terbaru Linux Mint adalah 22.3.');
});

test('D: embedded markup stripped, surrounding text kept', () => {
    const mixed = 'Hasil: ' + xmlDoc(Q) + ' selesai.';
    const clean = T.stripToolCallMarkup(mixed);
    assert.ok(clean.indexOf('tool_calls') === -1, 'no markup left: ' + clean);
    assert.ok(clean.indexOf('Hasil:') !== -1 && clean.indexOf('selesai.') !== -1, 'text kept: ' + clean);
});

test('E: query with empty tool or empty query rejected', () => {
    assert.equal(T.extractXmlToolCall(xmlDoc('   ')), null);
});

test('F: engine wires the markup guard on all answer paths', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiSearchEngine.js'), 'utf8');
    assert.ok(src.indexOf('toolCallMarkup') !== -1, 'helper loaded');
    assert.ok(src.indexOf('_xmlToolCallOf') !== -1, 'guard used');
    assert.ok(src.indexOf('_stripXmlToolCall') !== -1, 'strip used');
    assert.ok(src.indexOf('_looksLikePartialXmlToolCall') !== -1, 'stream hold-back used');
});

test('G: non-stream XML-only answer triggers grounding, UI gets clean answer', (t, done) => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let grounded = false;
    const provider = {
        request(payload, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            if (!payload.groundingContext) {
                return cb(null, { type: 'answer', text: xmlDoc('Linux Mint latest version') });
            }
            grounded = true;
            return cb(null, { type: 'answer', text: 'Versi terbaru Linux Mint adalah 22.3.' });
        }
    };
    const tool = {
        search(req, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            const q = (req && req.query) || 'x';
            cb(null, { type: 'tool_result', tool: 'web_search', query: q,
                sources: [{ title: 'Linux Mint 22.3 released', url: 'https://blog.linuxmint.com/?p=1', snippet: 'Linux Mint 22.3 Zena is now available.' }] });
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    engine.search('Apa versi terbaru Linux Mint saat ini?', {
        onAnswer: (d) => {
            try {
                assert.ok(grounded, 'web_search executed');
                assert.ok(d.text.indexOf('tool_calls') === -1, 'no markup in UI: ' + d.text);
                assert.ok(d.text.indexOf('22.3') !== -1, 'final answer shown');
                done();
            } catch (e) { done(e); }
        },
        onError: (e) => done(new Error('should ground, got error ' + (e && e.code)))
    });
});

test('H0: grounding trace logs leg/query/counts without credentials', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'aiSearchEngine.js'), 'utf8');
    assert.ok(src.indexOf('_logGroundingTrace(') !== -1, 'trace wired');
    for (const leg of ["'live'", "'tool'", "'live-stream'", "'tool-stream'"]) {
        assert.ok(src.indexOf('_logGroundingTrace(' + leg) !== -1, 'leg traced: ' + leg);
    }
    const traceIdx = src.indexOf('function _logGroundingTrace(');
    const traceBody = src.slice(traceIdx, traceIdx + 5000);
    assert.ok(traceBody.indexOf('relevantCount') !== -1, 'counts logged');
    assert.ok(traceBody.indexOf('decision=') !== -1, 'per-result decision logged');
    assert.ok(traceBody.toLowerCase().indexOf('apikey') === -1, 'no api key in trace');
    assert.ok(traceBody.toLowerCase().indexOf('authorization') === -1, 'no auth header in trace');
    assert.ok(traceBody.toLowerCase().indexOf('cookie') === -1, 'no cookies in trace');
});

test('H: streaming XML-only answer grounds without leaking markup deltas', (t, done) => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const seenDeltas = [];
    const { createMockStreamingAiProvider } = require('../ai/aiProvider.js');
    const provider = createMockStreamingAiProvider({
        handler: (payload, onEvent) => {
            if (payload.groundingContext) {
                onEvent({ type: 'start' });
                onEvent({ type: 'delta', text: 'Versi terbaru Linux Mint adalah 22.3.' });
                onEvent({ type: 'complete', result: { text: 'Versi terbaru Linux Mint adalah 22.3.', sources: [], grounded: false } });
                return;
            }
            const full = xmlDoc('Linux Mint latest version');
            onEvent({ type: 'start' });
            onEvent({ type: 'delta', text: full.slice(0, 40) });
            onEvent({ type: 'delta', text: full.slice(40) });
            onEvent({ type: 'complete', result: { text: full, sources: [], grounded: false } });
        }
    });
    const tool = {
        search(req, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            const q = (req && req.query) || 'x';
            cb(null, { type: 'tool_result', tool: 'web_search', query: q,
                sources: [{ title: 'Linux Mint 22.3 released', url: 'https://blog.linuxmint.com/?p=1', snippet: 'Linux Mint 22.3 Zena is now available.' }] });
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    engine.searchStream('Apa versi terbaru Linux Mint saat ini?', {
        onDelta: (chunk) => seenDeltas.push(String(chunk || '')),
        onComplete: (d) => {
            try {
                const leaked = seenDeltas.some(x => x.indexOf('tool_calls') !== -1 || x.indexOf('invoke') !== -1);
                assert.ok(!leaked, 'no markup delta leaked');
                assert.ok(d.text.indexOf('tool_calls') === -1, 'no markup in final');
                assert.ok(d.text.indexOf('22.3') !== -1, 'grounded answer shown');
                done();
            } catch (e) { done(e); }
        },
        onError: (e) => done(new Error('should ground, got ' + (e && e.code)))
    });
});
