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

test('AI idle sizes the chat pane (empty state + composer), not an empty shell', () => {
    // 2026-09-14 redesign: ai-input is no longer a collapsed shell — the AI pane shows
    // the empty state (greeting + suggestions) + the always-live composer, so the AI
    // idle branch delegates to _syncAiPaneGeometry like the chat path. The pill anchor
    // itself stays pinned (margin_top re-assert) and the dialog auto-sizes (-1).
    const geoIdx = APPLET_SRC.indexOf('_syncContentGeometry() {');
    assert.ok(geoIdx !== -1, 'syncContentGeometry exists');
    const geo = APPLET_SRC.slice(geoIdx, geoIdx + 6000);
    const aiIdx = geo.indexOf("if (this._mode === 'ai')");
    assert.ok(aiIdx !== -1, 'AI branch exists');
    const retIdx = geo.indexOf('return;', aiIdx);
    assert.ok(retIdx !== -1 && retIdx > aiIdx, 'AI no-conversation early return exists');
    const aiBranch = geo.slice(aiIdx, retIdx);
    assert.ok(aiBranch.includes('_syncAiPaneGeometry()'), 'AI idle sizes the pane (empty state + composer)');
    assert.ok(aiBranch.includes('set_margin_top(needTop)'), 'pill anchor re-assert kept (no pill jump)');
    assert.ok(aiBranch.includes('ov._aiScroll.set_size(w, 0)'), 'conversation scroll stays zeroed in ai-input');
    assert.ok(!aiBranch.includes('ov._aiPane.set_size(w, 0)'), 'pane is NOT collapsed to an empty shell anymore');
});
