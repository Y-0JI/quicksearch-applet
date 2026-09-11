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

test('AI idle sizes dialogLayout exactly like search idle (no pill jump)', () => {
    const geoIdx = APPLET_SRC.indexOf('_syncContentGeometry() {');
    assert.ok(geoIdx !== -1, 'syncContentGeometry exists');
    const geo = APPLET_SRC.slice(geoIdx, geoIdx + 6000);
    const aiIdx = geo.indexOf("if (this._mode === 'ai')");
    assert.ok(aiIdx !== -1, 'AI branch exists');
    const retIdx = geo.indexOf('return;', aiIdx);
    assert.ok(retIdx !== -1 && retIdx > aiIdx, 'AI no-conversation early return exists');
    const aiBranch = geo.slice(aiIdx, retIdx);
    assert.ok(aiBranch.includes('dialogLayout.set_height'), 'AI idle sets dialog height like search idle');
    assert.ok(aiBranch.includes('dialogLayout.set_size'), 'AI idle sets dialog size like search idle');
    assert.ok(aiBranch.includes('queue_relayout'), 'AI idle queues relayout like search idle');
});
