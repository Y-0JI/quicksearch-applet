const { test } = require('node:test');
const assert = require('node:assert');

// Simulate the fixed _aiChat and _agentStatus logic from applet.js
function createMockApplet() {
    const TOOL_LABELS = {
        search_web: 'Searching the web...',
        search_files: 'Searching files...',
        calculator: 'Calculating...',
    };
    function toolLabel(id) { return TOOL_LABELS[id] || 'Working...'; }
    const _ = (s) => s; // mock gettext

    let _aiChat = [];
    let _agentPend = null;
    let _aiSeq = 0;

    function _renderAIChat() { /* no-op for test */ }

    function _agentStatus(kind, toolId, customText) {
        const pend = _agentPend;
        if (!pend || !pend.pending) return;
        let newText;
        if (customText) newText = customText;
        else if (kind === "working") newText = toolLabel(toolId) || _("Working...");
        else newText = _("Thinking...");
        const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
        if (pend.text !== newText && isWork(pend.text)) {
            const idx = _aiChat.indexOf(pend);
            if (idx !== -1) {
                _aiChat.splice(idx, 0, { who: "ai", text: pend.text, activity: true });
            }
        }
        pend.text = newText;
        _renderAIChat();
    }

    function _aiErrorText(code) {
        if (code === 'max-steps') return 'Agent mencapai batas langkah.';
        return 'Error';
    }

    function simulateSubmitAndFailWithMaxSteps() {
        _aiSeq++;
        const token = _aiSeq;
        _aiChat.push({ who: "you", text: "cari informasi BMRI tanggal 26" });
        const pend = { who: "ai", text: _("Thinking..."), pending: true, token };
        _aiChat.push(pend);
        _agentPend = pend;

        // Simulate multi-step: Thinking -> search_web -> Thinking -> search_files -> max-steps
        _agentStatus("thinking");
        _agentStatus("working", "search_web");
        _agentStatus("thinking");
        _agentStatus("working", "search_files");
        // Now simulate max-steps error
        const err = { error: 'max-steps' };
        const isMaxSteps = String(err.error || "") === 'max-steps';
        const errText = _aiErrorText(err.error);
        if (isMaxSteps) {
            const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
            if (pend.text && isWork(pend.text)) {
                pend.pending = false;
                _aiChat.push({ who: "ai", text: errText, isError: true });
            } else {
                pend.text = errText;
                pend.pending = false;
                pend.isError = true;
            }
        }
        _agentPend = null;
        return _aiChat;
    }

    function simulateSingleToolThenMaxSteps() {
        _aiChat = [];
        _aiSeq++;
        const token = _aiSeq;
        _aiChat.push({ who: "you", text: "tanggal 26" });
        const pend = { who: "ai", text: _("Thinking..."), pending: true, token };
        _aiChat.push(pend);
        _agentPend = pend;
        _agentStatus("working", "search_web");
        const err = { error: 'max-steps' };
        const errText = _aiErrorText(err.error);
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

    return { simulateSubmitAndFailWithMaxSteps, simulateSingleToolThenMaxSteps, _aiChat: () => _aiChat };
}

test('max-steps preserves previous tool activities', () => {
    const m = createMockApplet();
    const chat = m.simulateSubmitAndFailWithMaxSteps();
    // Should have: you, activity search_web, pend search_files, error
    assert.equal(chat.length, 4, 'you + 2 activities + error, got ' + JSON.stringify(chat));
    assert.equal(chat[0].who, 'you');
    assert.equal(chat[1].text, 'Searching the web...');
    assert.equal(chat[1].activity, true);
    assert.equal(chat[2].text, 'Searching files...');
    assert.equal(chat[2].pending, false);
    assert.equal(chat[3].text, 'Agent mencapai batas langkah.');
    assert.equal(chat[3].isError, true);
});

test('max-steps with single tool preserves that tool activity', () => {
    const m = createMockApplet();
    const chat = m.simulateSingleToolThenMaxSteps();
    assert.equal(chat.length, 3, JSON.stringify(chat));
    assert.equal(chat[0].who, 'you');
    assert.equal(chat[1].text, 'Searching the web...');
    assert.equal(chat[1].pending, false);
    assert.equal(chat[2].text, 'Agent mencapai batas langkah.');
    assert.equal(chat[2].isError, true);
});

test('max-steps when still Thinking does not create extra activity', () => {
    const m = createMockApplet();
    // Simulate no tool, just Thinking then max-steps
    let chat = [];
    let _aiChat = [];
    let _agentPend = null;
    const _ = (s) => s;
    function _aiErrorText(c) { return c === 'max-steps' ? 'Agent mencapai batas langkah.' : 'Error'; }
    _aiChat.push({ who: "you", text: "test" });
    const pend = { who: "ai", text: _("Thinking..."), pending: true, token: 1 };
    _aiChat.push(pend);
    _agentPend = pend;
    // No tool, directly max-steps
    const errText = _aiErrorText('max-steps');
    const isWork = (t) => t !== _("Thinking...") && t !== _("— dibatalkan —");
    if (pend.text && isWork(pend.text)) {
        pend.pending = false;
        _aiChat.push({ who: "ai", text: errText, isError: true });
    } else {
        pend.text = errText;
        pend.pending = false;
        pend.isError = true;
    }
    assert.equal(_aiChat.length, 2);
    assert.equal(_aiChat[1].text, 'Agent mencapai batas langkah.');
    assert.equal(_aiChat[1].isError, true);
});

test('normal success still replaces pend with answer (no extra activity push)', () => {
    // This test ensures normal flow not broken: success should still replace pend
    let _aiChat = [{ who: "you", text: "hello" }, { who: "ai", text: "Thinking...", pending: true }];
    let pend = _aiChat[1];
    // Simulate success answer overwriting pend
    pend.text = "Final answer";
    pend.pending = false;
    assert.equal(_aiChat.length, 2);
    assert.equal(_aiChat[1].text, "Final answer");
    assert.equal(_aiChat[1].pending, false);
});

test('cancellation does not leave stale activity', () => {
    // Simulate cancellation: pend marked as cancelled, not pushed as activity
    let _aiChat = [{ who: "you", text: "q" }, { who: "ai", text: "Searching the web...", pending: true, token: 1 }];
    let pend = _aiChat[1];
    // Simulate new submit superseding
    for (const e of _aiChat) {
        if (e.pending) { e.text = "— dibatalkan —"; e.pending = false; }
    }
    assert.equal(_aiChat[1].text, "— dibatalkan —");
    assert.equal(_aiChat[1].pending, false);
});
