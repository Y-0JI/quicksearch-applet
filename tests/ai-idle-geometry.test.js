// AI idle geometry — pill must not jump when switching Search idle <-> AI idle.
// _syncContentGeometry() search-idle path sizes dialogLayout to h+70 (=70 when
// empty). The AI no-conversation branch must do the same; otherwise the dialog
// remeasures at a different height for one frame and the pill blinks upward.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');

test('AI idle collapses to the bare pill; the chat pane owns the conversation state', () => {
    // 2026-09-14 input hand-off: ai-input = bare pill alone (dialog collapses to pill
    // height like search idle); the pane + composer only exist once a conversation is
    // under way, where the branch delegates to _syncAiPaneGeometry. The pill anchor
    // itself stays pinned (margin_top re-assert).
    const geoIdx = APPLET_SRC.indexOf('_syncContentGeometry() {');
    assert.ok(geoIdx !== -1, 'syncContentGeometry exists');
    const geo = APPLET_SRC.slice(geoIdx, geoIdx + 6000);
    const aiIdx = geo.indexOf("if (this._mode === 'ai')");
    assert.ok(aiIdx !== -1, 'AI branch exists');
    const retIdx = geo.indexOf('return;', aiIdx);
    assert.ok(retIdx !== -1 && retIdx > aiIdx, 'AI no-conversation early return exists');
    const aiBranch = geo.slice(aiIdx, retIdx);
    assert.ok(!aiBranch.includes('_syncAiPaneGeometry()'), 'AI idle never runs the pane math (pane hidden)');
    assert.ok(aiBranch.includes('set_margin_top(needTop)'), 'pill anchor re-assert kept (no pill jump)');
    assert.ok(aiBranch.includes('ov._aiScroll.set_size(w, 0)'), 'conversation scroll stays zeroed in ai-input');
    assert.ok(aiBranch.includes('dlgH0'), 'idle dialog collapses to pill height (no composer box)');
    assert.ok(!aiBranch.includes('ov._aiPane.set_size(w, 0)'), 'pane is never explicitly zero-sized');
});
