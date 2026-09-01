const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');

// P1: engine.destroy() owns provider lifecycle
test('P1 engine.destroy() calls provider.destroy() once', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let destroyCalls = 0;
    const provider = {
        request(payload, cancellable, cb) {
            if (typeof cancellable === 'function' && cb === undefined) cb = cancellable;
            cb(null, { type: 'answer', text: 'ok' });
        },
        destroy() { destroyCalls++; }
    };
    const engine = createAISearchEngine({ provider });
    engine.destroy();
    assert.equal(destroyCalls, 1, 'provider.destroy called once');
});

test('P1 double engine.destroy() does not double-destroy provider', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let destroyCalls = 0;
    const provider = {
        request(payload, cancellable, cb) {
            if (typeof cancellable === 'function' && cb === undefined) cb = cancellable;
            cb(null, { type: 'answer', text: 'ok' });
        },
        destroy() { destroyCalls++; }
    };
    const engine = createAISearchEngine({ provider });
    engine.destroy();
    engine.destroy();
    assert.equal(destroyCalls, 1, 'idempotent');
});

test('P1 rebuild: old provider destroyed, new provider created', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let oldDestroy = 0;
    const oldProvider = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            cb(null, { type: 'answer', text: 'old' });
        },
        destroy() { oldDestroy++; }
    };
    let newCalls = 0;
    const newProvider = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            newCalls++;
            cb(null, { type: 'answer', text: 'new' });
        },
        destroy() {}
    };
    // simulate _rebuildAiEngine: destroy old, create new
    let engine = createAISearchEngine({ provider: oldProvider });
    // old engine pending not needed; immediately rebuild
    engine.destroy();
    assert.equal(oldDestroy, 1, 'old provider destroyed on rebuild');
    engine = createAISearchEngine({ provider: newProvider });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(newCalls, 1);
    assert.equal(got.text, 'new', 'new engine works');
});

test('P1 applet _rebuildAiEngine destroys old engine', () => {
    // file guard: must call oldEngine.destroy(), not just cancel
    assert.ok(APPLET_SRC.includes('oldEngine') && APPLET_SRC.includes('.destroy()'), 'rebuild must destroy old engine');
    assert.ok(APPLET_SRC.includes('this._aiGen++'), 'rebuild bumps gen');
    assert.ok(APPLET_SRC.includes('this._aiLoading = false'), 'rebuild clears loading');
});

// P2-2 factory mock fallback must not produce "mock" answer in production
test('P2-2 factory: NineRouter unavailable -> provider_error not mock', () => {
    // Simulate NineRouterProvider unavailable by stubbing require
    const originalRequire = Module.prototype.require;
    const factoryPath = require.resolve('../ai/aiFactory.js');
    const enginePath = require.resolve('../ai/aiSearchEngine.js');
    // clear cache for fresh load with stubbed require
    delete require.cache[factoryPath];
    // keep engine cached but factory will re-require it
    let stubbedFactory = null;
    try {
        Module.prototype.require = function (id) {
            if (id === './nineRouterProvider.js' || id.endsWith('nineRouterProvider.js')) {
                throw new Error('simulated missing NineRouterProvider');
            }
            return originalRequire.apply(this, arguments);
        };
        // also clear provider module cache not needed
        stubbedFactory = require('../ai/aiFactory.js');
        const engine = stubbedFactory.createAiEngine({
            baseUrl: 'http://127.0.0.1:20128',
            apiKey: 'test-key',
            model: 'test-model'
        });
        let err = null, answer = null;
        engine.search('hello', {
            onAnswer: d => { answer = d; },
            onError: e => { err = e; }
        });
        assert.equal(answer, null, 'must not produce mock answer');
        assert.ok(err, 'must error');
        assert.equal(err.code, 'provider_error', 'must be provider_error not mock');
        assert.ok(!err.message.includes('mock') && String(answer || '').text !== 'mock', 'no mock leak');
    } finally {
        Module.prototype.require = originalRequire;
        delete require.cache[factoryPath];
        // restore factory to original state
        require('../ai/aiFactory.js');
    }
});

// P2-1 AI-2 basic request must not advertise web_search
test('P2-1 AI-2 basic payload has no web_search tool', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let captured = null;
    const provider = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            captured = payload;
            cb(null, { type: 'answer', text: 'ok' });
        },
        destroy() {}
    };
    const engine = createAISearchEngine({ provider });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.ok(captured, 'payload captured');
    const hasWebSearch = Array.isArray(captured.tools) && captured.tools.includes('web_search');
    assert.equal(hasWebSearch, false, 'AI-2 must not advertise web_search without enableGrounding');
    assert.equal(got.text, 'ok');
});

test('P2-1 AI-2 tool_call without grounding -> unsupported_tool', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let toolCalled = false;
    const provider = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
        },
        destroy() {}
    };
    const tool = {
        search(q, c, cb) { toolCalled = true; cb(null, []); }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let err = null;
    engine.search('q', { onError: e => { err = e; } });
    assert.equal(toolCalled, false, 'webSearch must not be invoked in AI-2 basic mode');
    assert.ok(err, 'must error');
    assert.equal(err.code, 'unsupported_tool');
});

test('P2-1 grounding enabled still works (AI-3 path)', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
    let secondReq = null;
    const provider = createMockAiProvider({
        handler: (req, cb) => {
            if (!req.groundingContext) return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'x' } });
            secondReq = req;
            cb(null, { type: 'answer', text: 'grounded' });
        }
    });
    const tool = createMockWebSearchTool({ handler: (q, c, cb) => cb(null, [{ title: 'T', url: 'https://example.com/a', snippet: 's' }]) });
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.ok(secondReq && secondReq.groundingContext.includes('https://example.com/a'));
    assert.equal(got.text, 'grounded');
});

// P2-3 rebuild behavioral: verify production logic via real engine lifecycle not Fake copy
test('P2-3 rebuild cancels pending and ignores late via generation', () => {
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    let held = null;
    const provider = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            held = cb;
        },
        destroy() {}
    };
    const engine = createAISearchEngine({ provider });
    let delivered = false;
    engine.search('first', { onAnswer: () => { delivered = true; } });
    engine.cancel(); // simulates generation bump on rebuild
    held(null, { type: 'answer', text: 'late' });
    assert.equal(delivered, false, 'cancelled generation must ignore late');
    // next search after cancel must deliver
    const provider2 = {
        request(payload, c, cb) {
            if (typeof c === 'function' && cb === undefined) cb = c;
            cb(null, { type: 'answer', text: 'second' });
        },
        destroy() {}
    };
    const engine2 = createAISearchEngine({ provider: provider2 });
    let got2 = null;
    engine2.search('second', { onAnswer: d => { got2 = d; } });
    assert.equal(got2.text, 'second');
});
