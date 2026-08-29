const { test } = require('node:test');
const assert = require('node:assert');
const { splitTextAndUrls, extractUrls, toolLabel } = require('../utils.js');

// Helper to simulate new _agentStatus dedup logic (must stay in sync with applet.js)
function createMockAppletDedup() {
    const TOOL_LABELS = {
        search_web: 'Searching the web...',
        search_files: 'Searching files...',
        calculator: 'Calculating...',
    };
    function tl(id) { return TOOL_LABELS[id] || 'Working...'; }
    const _ = (s) => s;
    let _aiChat = [];
    let _agentPend = null;
    let _aiSeq = 0;
    function _renderAIChat(){}
    function _agentStatus(kind, toolId, customText) {
        const pend = _agentPend;
        if (!pend || !pend.pending || pend.token !== _aiSeq) return;
        let newText;
        if (customText) newText = customText;
        else if (kind === "working") newText = tl(toolId) || _("Working...");
        else newText = _("Thinking...");
        if (pend.text === newText) return;
        const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
        if (pend.text !== newText && isWork(pend.text)) {
            const idx = _aiChat.indexOf(pend);
            if (idx !== -1) {
                const prev = idx > 0 ? _aiChat[idx-1] : null;
                const isDupeHistory = prev && prev.text === pend.text && prev.activity;
                if (!isDupeHistory) {
                    _aiChat.splice(idx, 0, { who: "ai", text: pend.text, activity: true });
                }
            }
        }
        pend.text = newText;
        const pendIdx = _aiChat.indexOf(pend);
        if (pendIdx > 0 && isWork(newText)) {
            const prev = _aiChat[pendIdx - 1];
            if (prev && prev.text === newText && prev.activity) {
                _aiChat.splice(pendIdx - 1, 1);
            }
        }
        _renderAIChat();
    }
    function simulate(seq, finalAnswer) {
        // seq: array of {kind, toolId}
        _aiChat = [];
        _aiSeq++;
        const token = _aiSeq;
        _aiChat.push({ who: "you", text: "q" });
        const pend = { who: "ai", text: _("Thinking..."), pending: true, token };
        _aiChat.push(pend);
        _agentPend = pend;
        for (const step of seq) {
            _agentStatus(step.kind, step.toolId, step.customText);
        }
        // simulate final answer success with preservation
        const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
        const answer = finalAnswer || "final answer with https://example.com/a and https://example.com/b";
        if (pend.text && isWork(pend.text)) {
            const idx = _aiChat.indexOf(pend);
            const prev = idx > 0 ? _aiChat[idx-1] : null;
            const isDupe = prev && prev.text === pend.text && prev.activity;
            if (!isDupe) {
                pend.pending = false;
                _aiChat.push({ who: "ai", text: answer });
            } else {
                pend.text = answer;
                pend.pending = false;
            }
        } else {
            pend.text = answer;
            pend.pending = false;
        }
        _agentPend = null;
        return _aiChat;
    }
    function simulateMaxSteps(seq) {
        _aiChat = [];
        _aiSeq++;
        const token = _aiSeq;
        _aiChat.push({ who: "you", text: "q" });
        const pend = { who: "ai", text: _("Thinking..."), pending: true, token };
        _aiChat.push(pend);
        _agentPend = pend;
        for (const step of seq) {
            _agentStatus(step.kind, step.toolId);
        }
        // max-steps error
        const errText = "Agent mencapai batas langkah.";
        const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
        if (pend.text && isWork(pend.text)) {
            pend.pending = false;
            _aiChat.push({ who: "ai", text: errText, isError: true });
        } else {
            pend.text = errText;
            pend.pending = false;
            pend.isError = true;
        }
        _agentPend = null;
        return _aiChat;
    }
    return { simulate, simulateMaxSteps, getChat: () => _aiChat, _agentStatus: () => _aiChat };
}

// ---- 1. duplicate consecutive activity not spam ----

test('A: search_web -> search_web -> final answer => single Searching the web status', () => {
    const m = createMockAppletDedup();
    const chat = m.simulate([
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_web" }
    ]);
    // Expect: you, Searching the web... (once), final answer
    // Not three identical statuses
    const texts = chat.map(c => c.text);
    const searchWebCount = texts.filter(t => t === "Searching the web...").length;
    assert.equal(searchWebCount, 1, 'should dedup consecutive identical to single, got ' + JSON.stringify(texts));
    // Ensure final answer present last
    assert.ok(chat[chat.length-1].text.includes("final answer"));
});

test('C: search_web x3 -> max-steps => single activity + error, not 3 spam', () => {
    const m = createMockAppletDedup();
    const chat = m.simulateMaxSteps([
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_web" }
    ]);
    const texts = chat.map(c => c.text);
    const swCount = texts.filter(t => t === "Searching the web...").length;
    assert.equal(swCount, 1, 'triple same tool should dedup to 1, got ' + JSON.stringify(texts));
    assert.equal(chat[chat.length-1].text, "Agent mencapai batas langkah.");
    assert.equal(chat[chat.length-1].isError, true);
});

test('dedup: same tool consecutive without Thinking also dedups (single step multi-call)', () => {
    const m = createMockAppletDedup();
    const chat = m.simulate([
        { kind: "working", toolId: "search_web" },
        { kind: "working", toolId: "search_web" } // immediate repeat, no thinking
    ]);
    const swCount = chat.map(c=>c.text).filter(t=>t==="Searching the web...").length;
    assert.equal(swCount, 1, JSON.stringify(chat));
});

// ---- 2. different activities still visible ----

test('B: search_web -> search_files -> final answer => both activities visible', () => {
    const m = createMockAppletDedup();
    const chat = m.simulate([
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_files" }
    ]);
    const texts = chat.map(c => c.text);
    assert.ok(texts.includes("Searching the web..."), JSON.stringify(texts));
    assert.ok(texts.includes("Searching files..."), JSON.stringify(texts));
    // Both distinct should appear
    const swIdx = texts.indexOf("Searching the web...");
    const sfIdx = texts.indexOf("Searching files...");
    assert.ok(swIdx !== -1 && sfIdx !== -1);
    assert.notEqual(swIdx, sfIdx);
});

test('alternating web/files/web keeps all three (non-consecutive repeat)', () => {
    const m = createMockAppletDedup();
    const chat = m.simulate([
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_files" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_web" }
    ]);
    const texts = chat.map(c => c.text);
    // Should have SW, SF, SW (second SW not consecutive duplicate because SF in between)
    const swCount = texts.filter(t=>t==="Searching the web...").length;
    const sfCount = texts.filter(t=>t==="Searching files...").length;
    assert.equal(swCount, 2, 'non-consecutive SW should appear twice ' + JSON.stringify(texts));
    assert.equal(sfCount, 1);
});

// ---- 3. max-steps preserves prior activity ----

test('max-steps with search_web -> search_files preserves both + error', () => {
    const m = createMockAppletDedup();
    const chat = m.simulateMaxSteps([
        { kind: "working", toolId: "search_web" },
        { kind: "thinking" },
        { kind: "working", toolId: "search_files" }
    ]);
    const texts = chat.map(c => c.text);
    assert.ok(texts.includes("Searching the web..."));
    assert.ok(texts.includes("Searching files..."));
    assert.equal(chat[chat.length-1].text, "Agent mencapai batas langkah.");
    // Order: you, SW, SF, error
    assert.equal(chat[0].who, "you");
    assert.equal(chat[1].text, "Searching the web...");
    assert.equal(chat[2].text, "Searching files...");
});

test('max-steps when still Thinking does not create extra activity', () => {
    const m = createMockAppletDedup();
    const chat = m.simulateMaxSteps([
        { kind: "thinking" }
    ]);
    // Only you + error (Thinking not preserved)
    assert.equal(chat.length, 2, JSON.stringify(chat));
    assert.equal(chat[1].text, "Agent mencapai batas langkah.");
});

// ---- 4. URL parsing still correct ----

test('URL parsing: 5+ URLs extracted in order', () => {
    const text = "lihat https://a.com/1 dan https://b.com/2 https://c.com/3 https://d.com/4 https://e.com/5 end";
    const urls = extractUrls(text);
    assert.deepEqual(urls, ["https://a.com/1","https://b.com/2","https://c.com/3","https://d.com/4","https://e.com/5"]);
});

test('URL parsing: long URL handled', () => {
    const long = "https://example.com/" + "a".repeat(200) + "?q=" + "b".repeat(100);
    const urls = extractUrls("prefix " + long + " suffix");
    assert.equal(urls[0], long);
    assert.equal(urls[0].length, long.length);
});

test('URL parsing: bare domain without https normalized to https', () => {
    const urls = extractUrls("cek databoks.katadata.co.id/article/123 dan example.com/page");
    assert.ok(urls.includes("https://databoks.katadata.co.id/article/123"));
    assert.ok(urls.includes("https://example.com/page"));
});

test('URL parsing: URL mid-sentence and different lines', () => {
    const segs = splitTextAndUrls("awal https://a.com/x tengah\nbaris baru https://b.com/y akhir");
    const urlVals = segs.filter(s=>s.type==="url").map(s=>s.value);
    assert.deepEqual(urlVals, ["https://a.com/x","https://b.com/y"]);
    assert.ok(segs.some(s=>s.type==="text" && s.value.includes("tengah")));
});

// ---- 5. multiple URL render: segments keep order, no loss ----

test('multiple URLs (5) split preserves order and does not merge', () => {
    const text = "a https://1.com b https://2.com c https://3.com d https://4.com e https://5.com f";
    const segs = splitTextAndUrls(text);
    const urls = segs.filter(s=>s.type==="url").map(s=>s.value);
    assert.equal(urls.length, 5);
    assert.deepEqual(urls, ["https://1.com","https://2.com","https://3.com","https://4.com","https://5.com"]);
});

test('text + URL + text wrapping: text segments include surrounding text correctly', () => {
    const text = "Paragraf panjang sebelum URL https://example.com/very/long/path?query=123 dan setelah URL.";
    const segs = splitTextAndUrls(text);
    assert.equal(segs.length, 3);
    assert.equal(segs[0].type, "text");
    assert.equal(segs[1].type, "url");
    assert.equal(segs[2].type, "text");
    assert.ok(segs[0].value.includes("Paragraf panjang"));
    assert.ok(segs[2].value.includes("dan setelah"));
});

test('bullet list with URLs handled', () => {
    const text = "- poin satu https://a.com/1\n- poin dua https://b.com/2\n- poin tiga";
    const segs = splitTextAndUrls(text);
    const urls = segs.filter(s=>s.type==="url").map(s=>s.value);
    assert.equal(urls.length, 2);
});

test('URL length safe and duplicate handling in extractUrls vs split', () => {
    const text = "https://a.com https://a.com https://b.com";
    assert.deepEqual(extractUrls(text), ["https://a.com","https://b.com"]); // deduped
    const segs = splitTextAndUrls(text);
    assert.equal(segs.filter(s=>s.type==="url").length, 3); // split keeps duplicates at position
});

// ---- 6. security: unsafe schemes never become clickable ----

test('unsafe schemes never extracted or split as URL', () => {
    const bad = "javascript:alert(1) file:///etc/passwd data:text/html,hi";
    assert.deepEqual(extractUrls(bad), []);
    const segs = splitTextAndUrls(bad);
    assert.equal(segs.filter(s=>s.type==="url").length, 0);
    assert.equal(segs[0].type, "text");
});
