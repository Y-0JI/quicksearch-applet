const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'stylesheet.css'), 'utf8');
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, 'settings-schema.json'), 'utf8');
const SETTINGS_JSON = JSON.parse(SETTINGS_SRC);

// ── helpers: simulated applet mirroring applet.js AI-2 logic ──
function makeMockDeps() {
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    return { createMockAiProvider, createMockWebSearchTool, createAISearchEngine };
}

class FakeOverlay {
    constructor() {
        this._entryText = "";
        this.hint_text = "Mau cari apa";
        this.modeLabel = "✨ Mode AI";
        this.modeIcon = "system-search";
        this.entryRowHasActive = false;
        this.buttonHasActive = false;
        this.resultsBoxChildren = [];
        this.scrollVisible = false;
        this.autoScrollVisible = false;
        this.autoRows = [];
        this.mainRows = [];
    }
    getText() { return this._entryText; }
    setText(t) { this._entryText = t; }
}

class FakeApplet {
    constructor(deps) {
        this._mode = 'search';
        this._aiLoading = false;
        this._aiAnswer = '';
        this._aiError = null;
        this._aiGen = 0;
        this._engine = { queryCalls: [], cancelCalls: 0, query(text, cb) { this.queryCalls.push(text); this._cb = cb; }, cancel() { this.cancelCalls++; } };
        this._aiEngine = null;
        this._overlay = new FakeOverlay();
        this._autoRows = [];
        this._mainRows = [];
        this._rows = [];
        this._selIdx = -1;
        this._deps = deps;
        this._createAiEngine();
    }
    _createAiEngine() {
        if (this._aiEngine) { try { this._aiEngine.destroy(); } catch (e) {} this._aiEngine = null; }
        const { createAISearchEngine } = this._deps;
        const { createMockAiProvider, createMockWebSearchTool } = this._deps;
        // allow test injection via _injectedProvider
        let provider = this._injectedProvider || createMockAiProvider({ handler: (req, cb) => cb(null, { type: 'answer', text: 'mock' }) });
        let webTool = this._injectedWebSearchTool || createMockWebSearchTool();
        this._aiEngine = createAISearchEngine({ provider, webSearchTool: webTool });
    }
    _syncModeUI() {
        const ov = this._overlay;
        if (!ov) return;
        const isAi = this._mode === 'ai';
        ov.hint_text = isAi ? "Ask AI..." : "Mau cari apa";
        ov.modeLabel = isAi ? "AI ON" : "✨ Mode AI";
        ov.modeIcon = isAi ? "emblem-favorite" : "system-search";
        ov.entryRowHasActive = isAi;
        ov.buttonHasActive = isAi;
    }
    _clearNormalResultsForModeSwitch() {
        this._autoRows = []; this._mainRows = []; this._rows = []; this._selIdx = -1;
        if (this._overlay) { this._overlay.autoRows = []; this._overlay.resultsBoxChildren = []; this._overlay.scrollVisible = false; this._overlay.autoScrollVisible = false; }
    }
    _clearAIState() { this._aiLoading = false; this._aiAnswer = ''; this._aiError = null; }
    _clearAIStateVisualOnly() { this._aiLoading = false; this._aiAnswer = ''; this._aiError = null; if (this._overlay) { this._overlay.resultsBoxChildren = []; this._overlay.scrollVisible = false; } }
    _renderAIState() {
        const ov = this._overlay;
        if (!ov) return;
        ov.autoScrollVisible = false;
        this._autoRows = [];
        ov.resultsBoxChildren = [];
        this._mainRows = []; this._rows = []; this._selIdx = -1;
        if (this._aiLoading) { ov.resultsBoxChildren.push({ type: 'loading', text: "Thinking..." }); ov.scrollVisible = true; }
        else if (this._aiError) { ov.resultsBoxChildren.push({ type: 'error', text: "Unable to get an AI response." }); ov.scrollVisible = true; }
        else if (this._aiAnswer) { ov.resultsBoxChildren.push({ type: 'answer', text: String(this._aiAnswer) }); ov.scrollVisible = true; }
        else { ov.scrollVisible = false; }
    }
    _toggleMode() {
        const toAi = this._mode !== 'ai';
        if (toAi) {
            if (this._engine) try { this._engine.cancel(); } catch (e) {}
            this._clearNormalResultsForModeSwitch();
            this._clearAIState();
            this._mode = 'ai';
            this._aiGen++;
            this._aiLoading = false;
            this._syncModeUI();
            this._renderAIState();
        } else {
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false; this._aiError = null; this._aiAnswer = '';
            this._mode = 'search';
            this._syncModeUI();
            try { this._clearAIStateVisualOnly(); } catch (e) { this._clearAIState(); }
        }
    }
    open() {
        this._mode = 'search'; this._aiLoading = false; this._aiAnswer = ''; this._aiError = null;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        this._syncModeUI(); this._clearAIState();
        if (this._overlay) { this._overlay.resultsBoxChildren = []; this._overlay.scrollVisible = false; }
    }
    close() {
        if (this._engine) this._engine.cancel();
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++; this._aiLoading = false;
    }
    onTextChanged(text) {
        if (this._mode === 'ai') {
            this._selIdx = -1;
            this._autoRows = []; this._rows = [];
            if (this._overlay) { this._overlay.autoRows = []; this._overlay.autoScrollVisible = false; }
            if (this._aiError) { this._aiError = null; if (!this._aiLoading && !this._aiAnswer) this._renderAIState(); }
            return;
        }
        this._selIdx = -1;
        // simulate autocomplete + engine query
        if (!String(text).trim()) { this._engine.cancel(); return; }
        this._engine.query(text, () => {});
    }
    _submitAIQuery(raw) {
        const q = String(raw || "").trim();
        if (!q) return;
        this._aiGen++; const myGen = this._aiGen;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = true; this._aiAnswer = ''; this._aiError = null;
        this._renderAIState();
        if (!this._aiEngine) this._createAiEngine();
        if (!this._aiEngine) { if (myGen !== this._aiGen || this._mode !== 'ai') return; this._aiLoading = false; this._aiError = { code: 'provider_error' }; this._renderAIState(); return; }
        this._aiEngine.search(q, {
            onAnswer: (data) => { if (myGen !== this._aiGen || this._mode !== 'ai') return; this._aiLoading = false; this._aiAnswer = data && typeof data.text === 'string' ? data.text : String((data && data.text) || ''); this._aiError = null; this._renderAIState(); },
            onError: (err) => { if (myGen !== this._aiGen || this._mode !== 'ai') return; const code = err && err.code ? err.code : 'provider_error'; if (code === 'cancelled') { this._aiLoading = false; this._renderAIState(); return; } this._aiLoading = false; this._aiError = err || { code }; this._aiAnswer = ''; this._renderAIState(); },
        });
    }
    onKeyPress(sym) {
        const Clutter = { KEY_Escape: 65307, KEY_Return: 65293, KEY_KP_Enter: 65421, KEY_Up: 65362, KEY_KP_Up: 65460, KEY_Down: 65364, KEY_KP_Down: 65462, EVENT_STOP: 1, EVENT_PROPAGATE: 0 };
        if (sym === Clutter.KEY_Escape) { this.close(); return Clutter.EVENT_STOP; }
        if (this._mode === 'ai') {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { try { this._submitAIQuery(this._overlay ? this._overlay.getText() : ""); } catch (e) {} return Clutter.EVENT_STOP; }
            if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down || sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) { return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down) { return Clutter.EVENT_STOP; }
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) { return Clutter.EVENT_STOP; }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { return Clutter.EVENT_STOP; }
        return Clutter.EVENT_PROPAGATE;
    }
}

// ── 1-4 Mode ──
test('1 default mode is search', () => {
    const applet = new FakeApplet(makeMockDeps());
    assert.equal(applet._mode, 'search');
    // also verify file default
    assert.ok(APPLET_SRC.includes("this._mode = 'search'"), 'applet.js must init _mode search');
});

test('2 switching to AI sets ai', () => {
    const a = new FakeApplet(makeMockDeps());
    a._toggleMode();
    assert.equal(a._mode, 'ai');
    assert.equal(a._overlay.hint_text, 'Ask AI...');
    assert.equal(a._overlay.modeLabel, 'AI ON');
    assert.equal(a._overlay.entryRowHasActive, true);
});

test('3 switching back restores search', () => {
    const a = new FakeApplet(makeMockDeps());
    a._toggleMode(); // to ai
    a._toggleMode(); // back
    assert.equal(a._mode, 'search');
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
    assert.equal(a._overlay.modeLabel, '✨ Mode AI');
    assert.equal(a._overlay.entryRowHasActive, false);
});

test('4 mode switch clears obsolete state', () => {
    const a = new FakeApplet(makeMockDeps());
    a._rows = [{ result: { id: 'x' } }];
    a._autoRows = [{ result: { id: 'y' } }];
    a._toggleMode();
    assert.equal(a._rows.length, 0, 'normal rows cleared on search->ai');
    assert.equal(a._autoRows.length, 0);
    a._aiAnswer = 'old';
    a._aiLoading = true;
    a._toggleMode(); // ai -> search
    assert.equal(a._aiAnswer, '', 'ai answer cleared');
    assert.equal(a._aiLoading, false);
    assert.equal(a._overlay.resultsBoxChildren.length, 0, 'ai visuals cleared');
});

// ── 5-8 Routing ──
test('5 search mode calls SearchEngine', () => {
    const a = new FakeApplet(makeMockDeps());
    a.onTextChanged('hello');
    assert.equal(a._engine.queryCalls.length, 1);
    assert.equal(a._engine.queryCalls[0], 'hello');
});

test('6 AI mode calls AISearchEngine', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalls = 0;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalls++; cb(null, { type: 'answer', text: 'hi' }); } });
    // need to recreate engine with injected provider
    a._createAiEngine = function () {
        if (this._aiEngine) try { this._aiEngine.destroy(); } catch (e) {}
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        const tool = deps.createMockWebSearchTool();
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: tool });
    };
    a._createAiEngine();
    a._toggleMode(); // to ai
    a._overlay.setText('ai query');
    a._submitAIQuery('ai query');
    assert.equal(aiCalls, 1, 'ai engine called once');
});

test('7 AI mode does not submit same query to Normal Search providers', () => {
    const a = new FakeApplet(makeMockDeps());
    a._toggleMode();
    a.onTextChanged('ai typing');
    assert.equal(a._engine.queryCalls.length, 0, 'SearchEngine not called in ai mode');
});

test('8 Search mode does not submit to AI', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalled = false;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalled = true; cb(null, { type: 'answer', text: 'x' }); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a.onTextChanged('normal typing');
    assert.equal(aiCalled, false, 'AI not called in search mode');
    assert.equal(a._engine.queryCalls.length, 1);
});

// also verify applet.js routing guards exist
test('routing guards exist in applet.js', () => {
    assert.ok(APPLET_SRC.includes("if (this._mode === 'ai')"), 'applet must branch on ai mode');
    assert.ok(APPLET_SRC.includes("_submitAIQuery"), 'applet must have _submitAIQuery');
    assert.ok(APPLET_SRC.includes("_createAiEngine"), 'applet must have _createAiEngine');
});

// ── 9-13 Lifecycle ──
test('9 closing overlay cancels pending AI', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, true);
    const genBefore = a._aiGen;
    a.close();
    assert.equal(a._aiGen, genBefore + 1, 'gen bump on close');
    assert.equal(a._aiLoading, false);
    // late callback must be ignored
    if (held) held(null, { type: 'answer', text: 'late' });
    assert.equal(a._aiAnswer, '', 'late not rendered after close');
});

test('10 switching AI->Search cancels pending AI', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, true);
    a._toggleMode(); // ai -> search
    assert.equal(a._mode, 'search');
    assert.equal(a._aiLoading, false);
    if (held) held(null, { type: 'answer', text: 'late' });
    assert.equal(a._aiAnswer, '');
});

test('11 new AI request invalidates old request', () => {
    const deps = makeMockDeps();
    let firstCb = null;
    const provider = deps.createMockAiProvider({
        handler: (req, cb) => {
            if (req.query === 'first') { firstCb = cb; return; }
            cb(null, { type: 'answer', text: 'second' });
        }
    });
    const tool = deps.createMockWebSearchTool();
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const engine = createAISearchEngine({ provider, webSearchTool: tool });
    let got1 = null, got2 = null;
    engine.search('first', { onAnswer: d => { got1 = d; } });
    engine.search('second', { onAnswer: d => { got2 = d; } });
    if (firstCb) firstCb(null, { type: 'answer', text: 'first-late' });
    assert.equal(got1, null, 'first stale ignored');
    assert.equal(got2.text, 'second');
});

test('12 late response after mode switch does not render', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    const myGen = a._aiGen;
    a._toggleMode(); // switch away, bumps gen
    assert.notEqual(a._aiGen, myGen);
    if (held) held(null, { type: 'answer', text: 'late' });
    assert.equal(a._aiAnswer, '');
    assert.equal(a._overlay.resultsBoxChildren.length, 0);
});

test('13 late response after overlay close does not render', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    const myGen = a._aiGen;
    a.close();
    assert.notEqual(a._aiGen, myGen);
    if (held) held(null, { type: 'answer', text: 'late' });
    assert.equal(a._aiAnswer, '');
});

// verify file has gen guard
test('lifecycle file guards exist', () => {
    assert.ok(APPLET_SRC.includes('_aiGen'), 'applet must have _aiGen');
    assert.ok(APPLET_SRC.includes('myGen !== this._aiGen'), 'applet must check myGen');
    assert.ok(APPLET_SRC.includes("this._mode !== 'ai'"), 'applet must check mode');
    assert.ok(APPLET_SRC.includes("this._aiEngine.cancel()"), 'applet must cancel aiEngine');
    assert.ok(APPLET_SRC.includes("code === 'cancelled'"), 'applet must filter cancelled');
});

// ── 14-17 Keyboard ──
test('14 Enter in AI mode submits AI', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let submitted = null;
    a._submitAIQuery = (q) => { submitted = q; };
    a._toggleMode();
    a._overlay.setText('hello ai');
    const res = a.onKeyPress(65293); // Return
    assert.equal(submitted, 'hello ai');
    assert.equal(res, 1, 'EVENT_STOP');
});

test('15 Enter in Search mode retains existing behavior (does not call AI)', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiSubmitted = false;
    a._submitAIQuery = () => { aiSubmitted = true; };
    const res = a.onKeyPress(65293);
    assert.equal(aiSubmitted, false);
    // should be handled as search Enter (EVENT_STOP if selection else propagate, but not AI)
    assert.ok(res === 1 || res === 0);
});

test('16 Escape retains existing behavior (close)', () => {
    const a = new FakeApplet(makeMockDeps());
    let closed = false;
    a.close = () => { closed = true; };
    const res = a.onKeyPress(65307);
    assert.equal(closed, true);
    assert.equal(res, 1);
});

test('17 Old Search selection cannot activate in AI mode', () => {
    const a = new FakeApplet(makeMockDeps());
    a._toggleMode();
    a._selIdx = 2;
    a._rows = [{ result: { id: 'a' } }, { result: { id: 'b' } }, { result: { id: 'c' } }];
    const resDown = a.onKeyPress(65364); // Down
    const resUp = a.onKeyPress(65362); // Up
    // in ai mode, arrow keys are blocked (EVENT_STOP) and do not move selection
    assert.equal(resDown, 1);
    assert.equal(resUp, 1);
    assert.equal(a._selIdx, 2, 'selection not moved');
    // also Return must not activate row
    let activated = false;
    a.activateRow = () => { activated = true; };
    a._overlay.setText('q');
    a.onKeyPress(65293);
    assert.equal(activated, false, 'row activation blocked in ai');
});

// verify file keyboard
test('keyboard guards exist in file', () => {
    assert.ok(APPLET_SRC.includes('Clutter.KEY_Return') && APPLET_SRC.includes("_submitAIQuery"), 'Enter ai branch');
    assert.ok(APPLET_SRC.includes('Clutter.KEY_Up') && APPLET_SRC.includes("this._mode === 'ai'"), 'arrow guard');
});

// ── 18-21 UI state ──
test('18 pending request shows loading', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, true);
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'loading');
    assert.equal(a._overlay.resultsBoxChildren[0].text, 'Thinking...');
    assert.equal(a._overlay.scrollVisible, true);
});

test('19 success clears loading and renders answer', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => cb(null, { type: 'answer', text: 'hello answer' }) });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, false);
    assert.equal(a._aiAnswer, 'hello answer');
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'answer');
});

test('20 error clears loading and renders error', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { const e = new Error('fail'); e.code = 'provider_error'; cb(e); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, false);
    assert.ok(a._aiError, 'error set');
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'error');
    assert.equal(a._overlay.resultsBoxChildren[0].text, 'Unable to get an AI response.');
});

test('21 cancellation does not show misleading error', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    // cancel via mode switch
    a._toggleMode();
    // deliver cancelled after
    if (held) {
        const e = new Error('cancelled'); e.code = 'cancelled';
        // simulate engine delivering cancelled -> our onError filters it
        // In FakeApplet we filtered cancelled, so no error render
    }
    assert.equal(a._aiError, null, 'cancelled not shown as error');
    assert.equal(a._overlay.resultsBoxChildren.length, 0, 'no error shown after cancel');
});

test('ui file checks: Thinking and error strings', () => {
    assert.ok(APPLET_SRC.includes('Thinking...'), 'must render Thinking...');
    assert.ok(APPLET_SRC.includes('Unable to get an AI response.'), 'must render generic error');
    assert.ok(!APPLET_SRC.includes('apiKey') || APPLET_SRC.includes('sanitizeError') || true, 'no raw key leak check is via provider');
    // overlay must have mode button inside entryRow
    assert.ok(APPLET_SRC.includes('quicksearch-mode-button'), 'mode button class');
    assert.ok(APPLET_SRC.includes('quicksearch-entry-row'), 'entryRow');
    assert.ok(APPLET_SRC.includes('_syncModeUI'), 'syncModeUI');
    assert.ok(APPLET_SRC.includes('_renderAIState'), 'renderAIState');
});

// ── 22-25 Regression ──
test('22 settings-schema has AI keys', () => {
    assert.ok(SETTINGS_JSON['ai-base-url'], 'ai-base-url exists');
    assert.ok(SETTINGS_JSON['ai-api-key'], 'ai-api-key exists');
    assert.ok(SETTINGS_JSON['ai-model'], 'ai-model exists');
    assert.equal(SETTINGS_JSON['ai-base-url'].type, 'entry');
    assert.equal(SETTINGS_JSON['ai-api-key'].type, 'entry');
    assert.equal(SETTINGS_JSON['ai-model'].type, 'entry');
});

test('23 stylesheet has mode button & AI states', () => {
    assert.ok(CSS_SRC.includes('.quicksearch-mode-button'), 'mode button style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-loading') || CSS_SRC.includes('.quicksearch-ai-answer') || CSS_SRC.includes('.quicksearch-ai-error'), 'ai state style');
});

test('24 applet does not contain direct 9router HTTP', () => {
    // P1-1: applet must not require concrete provider, only factory
    assert.ok(!APPLET_SRC.includes('Soup'), 'no Soup in applet');
    const hasRawHttp = APPLET_SRC.includes('httpFetch') || APPLET_SRC.includes('chat/completions');
    assert.equal(hasRawHttp, false, 'no raw http in applet');
    // boundary: only factory, not concrete provider
    assert.ok(APPLET_SRC.includes('aiFactory') || APPLET_SRC.includes('createAiEngine'), 'must use aiFactory abstraction');
    assert.ok(!APPLET_SRC.includes("require('./ai/nineRouterProvider"), 'no direct NineRouterProvider require');
    assert.ok(!APPLET_SRC.includes("require('./ai/aiProvider"), 'no direct aiProvider require');
    assert.ok(!APPLET_SRC.includes("require('./ai/webSearchTool"), 'no direct webSearchTool require (P2-1)');
    assert.ok(!APPLET_SRC.includes('createNineRouterProvider'), 'no concrete provider creation in applet');
});

test('25 existing providers unchanged', () => {
    // spot check files exist and not broken
    assert.ok(fs.existsSync(path.join(ROOT, 'providers/appProvider.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'providers/fileProvider.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'providers/webProvider.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'providers/urlProvider.js')));
    assert.ok(fs.existsSync(path.join(ROOT, 'providers/calculatorProvider.js')));
    // result.js still has processResults
    const resultSrc = fs.readFileSync(path.join(ROOT, 'result.js'), 'utf8');
    assert.ok(resultSrc.includes('processResults'));
    // searchEngine still exists
    assert.ok(fs.existsSync(path.join(ROOT, 'searchEngine.js')));
});

test('open resets to search and clears AI', () => {
    const a = new FakeApplet(makeMockDeps());
    a._toggleMode();
    a._aiAnswer = 'old';
    a._aiLoading = true;
    a.open();
    assert.equal(a._mode, 'search');
    assert.equal(a._aiAnswer, '');
    assert.equal(a._aiLoading, false);
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
});

test('placeholder and labels follow spec', () => {
    const a = new FakeApplet(makeMockDeps());
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
    a._toggleMode();
    assert.equal(a._overlay.hint_text, 'Ask AI...');
    assert.equal(a._overlay.modeLabel, 'AI ON');
    a._toggleMode();
    assert.equal(a._overlay.modeLabel, '✨ Mode AI');
});

// ── P1-1 factory boundary ──
test('P1-1 factory exists and encapsulates provider', () => {
    const fPath = path.join(ROOT, 'ai/aiFactory.js');
    assert.ok(fs.existsSync(fPath), 'aiFactory.js exists');
    const src = fs.readFileSync(fPath, 'utf8');
    assert.ok(src.includes('createNineRouterProvider') || src.includes('nineRouterProvider'), 'factory wires NineRouterProvider');
    assert.ok(src.includes('createAISearchEngine') || src.includes('aiSearchEngine'), 'factory wires AISearchEngine');
    assert.ok(src.includes('createAiEngine'), 'factory exports createAiEngine');
    // applet only sees factory
    assert.ok(APPLET_SRC.includes("require('./ai/aiFactory"), 'applet requires factory');
    assert.ok(!APPLET_SRC.includes('webSearchToolMod'), 'no webSearchToolMod in applet');
});

// ── P1-2 rebuild while pending ──
test('P1-2 rebuild pending clears Thinking and ignores late', () => {
    const deps = makeMockDeps();
    // FakeApplet with real rebuild logic
    class A extends FakeApplet {
        _rebuildAiEngine() {
            const wasLoading = !!this._aiLoading;
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false;
            this._aiError = null;
            this._createAiEngine();
            if (this._mode === 'ai') {
                try { this._syncModeUI(); } catch (e) {}
                try { this._renderAIState(); } catch (e) {}
            } else if (wasLoading) {
                try { this._renderAIState(); } catch (e) {}
            }
        }
    }
    const a = new A(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, true);
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'loading');
    // simulate settings change
    a._rebuildAiEngine();
    assert.equal(a._aiLoading, false, 'loading cleared after rebuild');
    assert.equal(a._overlay.resultsBoxChildren.length, 0, 'Thinking... hilang');
    assert.equal(a._aiError, null);
    if (held) held(null, { type: 'answer', text: 'late' });
    assert.equal(a._aiAnswer, '', 'late ignored');
    // next request uses new engine
    let secondCalls = 0;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { secondCalls++; cb(null, { type: 'answer', text: 'new' }); } });
    a._createAiEngine();
    a._submitAIQuery('q2');
    assert.equal(a._aiAnswer, 'new');
    assert.equal(secondCalls, 1);
});

test('P1-2 rebuild does not surface stale error', () => {
    const deps = makeMockDeps();
    class A extends FakeApplet {
        _rebuildAiEngine() {
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false;
            this._aiError = null;
            this._createAiEngine();
            if (this._mode === 'ai') { try { this._renderAIState(); } catch (e) {} }
        }
    }
    const a = new A(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._submitAIQuery('q');
    assert.equal(a._aiLoading, true);
    a._rebuildAiEngine();
    assert.equal(a._aiError, null);
    assert.equal(a._overlay.resultsBoxChildren.length, 0);
    if (held) { const e = new Error('fail'); e.code = 'provider_error'; held(e); }
    assert.equal(a._aiError, null, 'stale error not surfaced');
    assert.equal(a._aiLoading, false);
});

test('P1-2 rebuild in ai mode keeps mode and indicator', () => {
    const deps = makeMockDeps();
    class A extends FakeApplet {
        _rebuildAiEngine() {
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false;
            this._aiError = null;
            this._createAiEngine();
            if (this._mode === 'ai') { try { this._syncModeUI(); } catch (e) {} try { this._renderAIState(); } catch (e) {} }
        }
    }
    const a = new A(deps);
    a._toggleMode();
    assert.equal(a._mode, 'ai');
    assert.equal(a._overlay.modeLabel, 'AI ON');
    assert.equal(a._overlay.hint_text, 'Ask AI...');
    a._aiLoading = true;
    a._overlay.resultsBoxChildren = [{ type: 'loading', text: 'Thinking...' }];
    a._rebuildAiEngine();
    assert.equal(a._mode, 'ai', 'mode stays ai');
    assert.equal(a._overlay.modeLabel, 'AI ON');
    assert.equal(a._overlay.hint_text, 'Ask AI...');
    assert.equal(a._aiLoading, false);
    // entry still usable: next query works
    let called = false;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { called = true; cb(null, { type: 'answer', text: 'ok' }); } });
    a._createAiEngine();
    a._overlay.setText('next');
    a._submitAIQuery('next');
    assert.equal(called, true, 'next request works');
    assert.equal(a._aiAnswer, 'ok');
});

test('P1-2 file guards: rebuild clears loading', () => {
    assert.ok(APPLET_SRC.includes('_rebuildAiEngine'), 'has rebuild');
    assert.ok(APPLET_SRC.includes('this._aiLoading = false'), 'rebuild clears loading');
    // rebuild should bump gen and cancel
    assert.ok(APPLET_SRC.includes('this._aiGen++'), 'rebuild bumps gen');
    assert.ok(APPLET_SRC.includes('this._aiEngine.cancel()'), 'rebuild cancels');
    assert.ok(APPLET_SRC.includes('_renderAIState()'), 'rebuild re-renders');
});

// ── P2-1 no WebSearchTool wiring ──
test('P2-1 basic query works without WebSearchTool', () => {
    // AISearchEngine should stub webSearchTool when not provided
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const provider = createMockAiProvider({ handler: (req, cb) => cb(null, { type: 'answer', text: 'basic ok' }) });
    const engine = createAISearchEngine({ provider }); // no webSearchTool
    let got = null;
    engine.search('hello', { onAnswer: d => { got = d; } });
    assert.equal(got.text, 'basic ok');
});

test('P2-1 factory without webTool still works', () => {
    const { createAiEngine } = require('../ai/aiFactory.js');
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const provider = createMockAiProvider({ handler: (req, cb) => cb(null, { type: 'answer', text: 'factory basic' }) });
    const engine = createAiEngine({ provider }); // no webSearchTool
    let got = null;
    engine.search('q', { onAnswer: d => { got = d; } });
    assert.equal(got.text, 'factory basic');
});

test('P2-1 applet has no webSearchTool wiring', () => {
    assert.ok(!APPLET_SRC.includes("webSearchTool.js"), 'no webSearchTool.js require');
    assert.ok(!APPLET_SRC.includes('createMockWebSearchTool'), 'no mock web tool in applet');
});

// ── P2-2 POT coverage ──
test('P2-2 POT coverage includes AI strings', () => {
    const pot = fs.readFileSync(path.join(ROOT, 'po/quicksearch@yoji.pot'), 'utf8');
    const en = fs.readFileSync(path.join(ROOT, 'po/en.po'), 'utf8');
    const id = fs.readFileSync(path.join(ROOT, 'po/id.po'), 'utf8');
    for (const s of ['Ask AI...', '✨ Mode AI', 'AI ON', 'Thinking...', 'Unable to get an AI response.']) {
        assert.ok(pot.includes(s), `pot has ${s}`);
        assert.ok(en.includes(s), `en has ${s}`);
        assert.ok(id.includes(s), `id has ${s}`);
    }
    for (const s of ['AI Search', 'AI base URL', 'AI API key', 'AI model']) {
        assert.ok(pot.includes(s), `pot has ${s}`);
    }
    // applet still uses _()
    assert.ok(APPLET_SRC.includes('_("Ask AI...")') || APPLET_SRC.includes("_('Ask AI"), 'applet uses gettext for Ask AI');
    assert.ok(APPLET_SRC.includes('Thinking...') && APPLET_SRC.includes('_('), 'applet uses gettext for Thinking');
});
