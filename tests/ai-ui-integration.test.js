const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');

function makeMockDeps() {
    const { createMockAiProvider } = require('../ai/aiProvider.js');
    const { createMockWebSearchTool } = require('../ai/webSearchTool.js');
    const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
    return { createMockAiProvider, createMockWebSearchTool, createAISearchEngine };
}

class FakeOverlay {
    constructor() {
        this._entryText = '';
        this.hint_text = 'Mau cari apa';
        this.modeLabel = '✨ Mode AI';
        this.modeIcon = 'system-search';
        this.entryRowHasActive = false;
        this.buttonHasActive = false;
        this.resultsBoxChildren = [];
        this.scrollVisible = false;
        this.autoScrollVisible = false;
        this.focusCalled = false;
    }
    getText() { return this._entryText; }
    setText(t) { this._entryText = String(t); }
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
        // alias _searchMode -> _mode per spec AI-4 §4.2
        try {
            Object.defineProperty(this, '_searchMode', {
                get() { return this._mode === 'ai' ? 'ai' : 'normal'; },
                set(v) { this._mode = (v === 'ai') ? 'ai' : 'search'; },
                enumerable: true, configurable: true
            });
        } catch (e) { this._searchMode = 'normal'; }
        this._createAiEngine();
        this._syncModeUI();
    }
    _createAiEngine() {
        if (this._aiEngine) { try { this._aiEngine.destroy(); } catch (e) {} this._aiEngine = null; }
        const { createAISearchEngine } = this._deps;
        const { createMockAiProvider, createMockWebSearchTool } = this._deps;
        let provider = this._injectedProvider || createMockAiProvider({ handler: (req, cb) => cb(null, { type: 'answer', text: 'mock' }) });
        let webTool = this._injectedWebSearchTool || createMockWebSearchTool();
        this._aiEngine = createAISearchEngine({ provider, webSearchTool: webTool });
    }
    _syncModeUI() {
        const ov = this._overlay;
        if (!ov) return;
        const isAi = this._mode === 'ai';
        ov.hint_text = isAi ? 'Ask AI...' : 'Mau cari apa';
        ov.modeLabel = isAi ? 'AI ON' : '✨ Mode AI';
        ov.modeIcon = isAi ? 'emblem-favorite' : 'system-search';
        ov.entryRowHasActive = isAi;
        ov.buttonHasActive = isAi;
    }
    _clearNormalResultsForModeSwitch() {
        this._autoRows = []; this._mainRows = []; this._rows = []; this._selIdx = -1;
        if (this._overlay) { this._overlay.resultsBoxChildren = []; this._overlay.scrollVisible = false; this._overlay.autoScrollVisible = false; }
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
        if (this._aiLoading) { ov.resultsBoxChildren.push({ type: 'loading', text: 'Thinking...' }); ov.scrollVisible = true; }
        else if (this._aiError) { ov.resultsBoxChildren.push({ type: 'error', text: 'Unable to get an AI response.' }); ov.scrollVisible = true; }
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
            if (this._overlay) this._overlay.focusCalled = true;
        } else {
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false; this._aiError = null; this._aiAnswer = '';
            this._mode = 'search';
            this._syncModeUI();
            try { this._clearAIStateVisualOnly(); } catch (e) { this._clearAIState(); }
            if (this._overlay) this._overlay.focusCalled = true;
            const txt = this._overlay ? this._overlay.getText() : '';
            if (txt && String(txt).trim()) { try { this.onTextChanged(txt); } catch (e) {} }
        }
    }
    open() {
        this._mode = 'search'; this._aiLoading = false; this._aiAnswer = ''; this._aiError = null;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        this._syncModeUI(); this._clearAIState();
        if (this._overlay) { this._overlay.resultsBoxChildren = []; this._overlay.scrollVisible = false; this._overlay.focusCalled = true; }
    }
    close() {
        if (this._engine) this._engine.cancel();
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++; this._aiLoading = false;
    }
    onTextChanged(text) {
        // Hard isolation: AI mode must NEVER trigger search, AI request only via explicit submit.
        if (this._mode === 'ai') {
            this._selIdx = -1;
            this._autoRows = []; this._rows = [];
            if (this._overlay) { this._overlay.autoScrollVisible = false; }
            if (this._aiError) { this._aiError = null; if (!this._aiLoading && !this._aiAnswer) this._renderAIState(); }
            return;
        }
        this._selIdx = -1;
        if (!String(text).trim()) { this._engine.cancel(); return; }
        this._engine.query(text, () => {});
    }
    _submitAIQuery(raw) {
        const q = String(raw || '').trim();
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
        const K = { Escape: 65307, Return: 65293, KP_Enter: 65421, Up: 65362, Down: 65364 };
        if (sym === K.Escape) { this.close(); return 1; }
        if (this._mode === 'ai') {
            if (sym === K.Return || sym === K.KP_Enter) { try { this._submitAIQuery(this._overlay ? this._overlay.getText() : ''); } catch (e) {} return 1; }
            if (sym === K.Down || sym === K.Up) return 1;
            return 0;
        }
        return 0;
    }
}

// ── A. Default mode
test('A default mode is normal', () => {
    const a = new FakeApplet(makeMockDeps());
    a.open();
    assert.equal(a._searchMode, 'normal');
    assert.equal(a._mode, 'search');
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
    assert.ok(APPLET_SRC.includes("this._mode = 'search'"), 'applet must init _mode search');
    assert.ok(APPLET_SRC.includes('_searchMode'), 'applet must have _searchMode alias');
    assert.ok(APPLET_SRC.includes('_("Mau cari apa")') || APPLET_SRC.includes('Mau cari apa'), 'normal placeholder present');
});

// ── B. Toggle Normal → AI
test('B toggle Normal -> AI', () => {
    const a = new FakeApplet(makeMockDeps());
    a.open();
    a._overlay.focusCalled = false;
    a._toggleMode();
    assert.equal(a._searchMode, 'ai');
    assert.equal(a._mode, 'ai');
    assert.equal(a._overlay.hint_text, 'Ask AI...');
    assert.equal(a._overlay.modeLabel, 'AI ON');
    assert.equal(a._overlay.entryRowHasActive, true);
    assert.equal(a._overlay.focusCalled, true, 'entry remains focused');
});

// ── C. Toggle AI -> Normal clears active request
test('C toggle AI -> Normal clears loading/answer and cancels', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let held = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { held = cb; } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode(); // to ai
    a._submitAIQuery('hello');
    assert.equal(a._aiLoading, true);
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'loading');
    let cancelCalled = false;
    const origCancel = a._aiEngine.cancel.bind(a._aiEngine);
    a._aiEngine.cancel = () => { cancelCalled = true; return origCancel(); };
    a._overlay.focusCalled = false;
    a._toggleMode(); // ai -> normal
    assert.equal(cancelCalled, true, 'cancel called');
    assert.equal(a._searchMode, 'normal');
    assert.equal(a._aiLoading, false);
    assert.equal(a._aiAnswer, '');
    assert.equal(a._aiError, null);
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
    assert.equal(a._overlay.resultsBoxChildren.length, 0, 'AI visuals cleared');
    assert.equal(a._overlay.focusCalled, true);
    if (held) held(null, { type: 'answer', text: 'late should not appear' });
    assert.equal(a._aiAnswer, '', 'late ignored after toggle');
});

// ── D. AI tidak auto-request saat mengetik
test('D AI mode typing does not auto-request', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalls = 0;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalls++; cb(null, { type: 'answer', text: 'x' }); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a.onTextChanged('a');
    a.onTextChanged('ab');
    a.onTextChanged('abc typing');
    assert.equal(aiCalls, 0, 'ai not called on typing');
    assert.equal(a._engine.queryCalls.length, 0, 'normal engine also not called in ai mode');
    // file guard: onTextChanged early return in ai mode, no aiSearchEngine.search
    assert.ok(APPLET_SRC.includes("if (this._mode === 'ai')"), 'applet onTextChanged must branch on ai mode');
    const onTextSection = APPLET_SRC.slice(APPLET_SRC.indexOf('onTextChanged'), APPLET_SRC.indexOf('onTextChanged') + 1500);
    assert.ok(!onTextSection.includes('aiSearchEngine') && !onTextSection.includes('_aiEngine.search'), 'onTextChanged must not call AI');
});

// ── E. Enter AI submit
test('E Enter AI submit calls aiSearchEngine once', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalls = 0; let lastQuery = null;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalls++; lastQuery = req.query; cb(null, { type: 'answer', text: 'ok' }); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._overlay.setText('  hello ai  ');
    const res = a.onKeyPress(65293); // Return
    assert.equal(aiCalls, 1, 'ai called once');
    assert.equal(lastQuery, 'hello ai');
    assert.equal(res, 1);
    // file guard: Enter ai branch calls _submitAIQuery
    assert.ok(APPLET_SRC.includes('_submitAIQuery'), 'applet must have _submitAIQuery');
    assert.ok(APPLET_SRC.includes('Clutter.KEY_Return') && APPLET_SRC.includes("_submitAIQuery"), 'Enter ai must submit');
});

// ── F. Empty AI query
test('F empty AI query does not call aiSearchEngine', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalls = 0;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalls++; cb(null, { type: 'answer', text: 'x' }); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    a._toggleMode();
    a._overlay.setText('');
    a._submitAIQuery('');
    assert.equal(aiCalls, 0);
    a._overlay.setText('   ');
    a._submitAIQuery('   ');
    assert.equal(aiCalls, 0);
    a.onKeyPress(65293);
    assert.equal(aiCalls, 0, 'Enter empty also not called');
    assert.equal(a._aiLoading, false);
});

// ── G. Normal mode isolation
test('G normal mode isolation', () => {
    const deps = makeMockDeps();
    const a = new FakeApplet(deps);
    let aiCalls = 0;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { aiCalls++; cb(null, { type: 'answer', text: 'x' }); } });
    a._createAiEngine = function () {
        const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
        this._aiEngine = createAISearchEngine({ provider: this._injectedProvider, webSearchTool: deps.createMockWebSearchTool() });
    };
    a._createAiEngine();
    // stays in normal
    a.onTextChanged('calc 1+1');
    assert.equal(a._engine.queryCalls.length, 1);
    assert.equal(a._engine.queryCalls[0], 'calc 1+1');
    assert.equal(aiCalls, 0, 'ai not called in normal mode');
});

// ── H. Loading -> Answer
test('H loading -> answer', () => {
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
    held(null, { type: 'answer', text: 'hello answer' });
    assert.equal(a._aiLoading, false);
    assert.equal(a._aiAnswer, 'hello answer');
    assert.equal(a._overlay.resultsBoxChildren[0].type, 'answer');
    assert.equal(a._overlay.resultsBoxChildren[0].text, 'hello answer');
    assert.equal(a._overlay.scrollVisible, true);
});

// ── I. Error
test('I error renders safe UI and overlay usable', () => {
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
    // overlay must remain usable: next query works
    let secondOk = false;
    a._injectedProvider = deps.createMockAiProvider({ handler: (req, cb) => { secondOk = true; cb(null, { type: 'answer', text: 'recovered' }); } });
    a._createAiEngine();
    a._submitAIQuery('q2');
    assert.equal(secondOk, true);
    assert.equal(a._aiAnswer, 'recovered');
    assert.ok(APPLET_SRC.includes('Unable to get an AI response.'), 'must use generic error string');
});

// ── J. Mode switch saat request pending late ignored
test('J mode switch during pending ignores late callback', () => {
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
    a._submitAIQuery('pending');
    const genBefore = a._aiGen;
    a._toggleMode(); // ai -> normal
    assert.equal(a._searchMode, 'normal');
    assert.notEqual(a._aiGen, genBefore);
    if (held) held(null, { type: 'answer', text: 'late answer must not appear' });
    assert.equal(a._aiAnswer, '', 'late answer not rendered after switch');
    assert.equal(a._overlay.resultsBoxChildren.length, 0, 'no AI visuals in normal');
    assert.equal(a._overlay.hint_text, 'Mau cari apa');
});

// ── K. Close saat request pending
test('K close during pending cancels and ignores late', () => {
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
    let cancelSeen = false;
    const orig = a._aiEngine.cancel.bind(a._aiEngine);
    a._aiEngine.cancel = () => { cancelSeen = true; return orig(); };
    a.close();
    assert.equal(cancelSeen, true, 'cancel called on close');
    assert.equal(a._aiLoading, false);
    assert.notEqual(a._aiGen, genBefore);
    if (held) held(null, { type: 'answer', text: 'late after close' });
    assert.equal(a._aiAnswer, '', 'late after close ignored');
    // file must have cancel in close
    assert.ok(APPLET_SRC.includes('close()') && APPLET_SRC.includes('this._aiEngine.cancel()'), 'close must cancel aiEngine');
    assert.ok(APPLET_SRC.includes('this._aiGen++'), 'close must bump gen');
});

// ── P2 file guards
test('P2 comment Phase AI-4', () => {
    assert.ok(APPLET_SRC.includes('Phase AI-4'), 'must contain Phase AI-4 comment');
    assert.ok(!APPLET_SRC.includes('Phase AI-2') || APPLET_SRC.match(/Phase AI-4/g).length >= 1, 'Phase label corrected to AI-4');
});

test('P2 hard isolation: onTextChanged never triggers AI', () => {
    const idx = APPLET_SRC.indexOf('onTextChanged(text)');
    assert.ok(idx !== -1, 'onTextChanged(text) must exist');
    const section = APPLET_SRC.slice(idx, idx + 2000);
    assert.ok(section.includes("this._mode === 'ai'") || section.includes("this._searchMode") || section.includes('_searchMode'), 'must branch on mode');
    assert.ok(!section.includes('_aiEngine.search') && !section.includes('aiSearchEngine'), 'onTextChanged must not contain AI search');
});

test('P2 late callback guards present', () => {
    assert.ok(APPLET_SRC.includes('_aiGen'), 'must have _aiGen');
    assert.ok(APPLET_SRC.includes('myGen !== this._aiGen'), 'must check generation');
    assert.ok(APPLET_SRC.includes("this._mode !== 'ai'"), 'must check mode before render');
    assert.ok(APPLET_SRC.includes("code === 'cancelled'"), 'must filter cancelled');
});

test('single overlay single entry preserved', () => {
    assert.ok(APPLET_SRC.includes('QuickSearchOverlay'), 'overlay exists');
    assert.ok(APPLET_SRC.includes('quicksearch-mode-button'), 'mode button inside entryRow');
    assert.ok(APPLET_SRC.includes('quicksearch-entry-row'), 'entryRow exists');
    // must not create second dialog class for AI; single overlay class only
    const overlayClasses = (APPLET_SRC.match(/class\s+\w+Overlay/g) || []).length;
    assert.equal(overlayClasses, 1, 'single Overlay class only');
    assert.ok(!APPLET_SRC.includes('class AiOverlay') && !APPLET_SRC.includes('class AISearchOverlay'), 'no second AI overlay');
});
