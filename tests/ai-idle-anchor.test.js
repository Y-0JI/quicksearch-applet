// AI idle pill anchor — AI searchbox saat idle (no conversation) harus sejajar
// dengan Search idle. Mekanisme: cabang AI idle di _syncContentGeometry
// menegaskan ulang margin_top pill yang sama persis dengan search path, di
// setiap geometry sync — reset margin async tidak bisa tinggalkan offset.
// Search path (_syncShell idle-search, formula needTop search, _goToSearchMode,
// CSS search) TIDAK BOLEH berubah — test di bawah mengunci itu.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');

test('AI idle branch re-asserts the pill anchor inside _syncContentGeometry', () => {
    const geoIdx = APPLET_SRC.indexOf('_syncContentGeometry() {');
    assert.ok(geoIdx !== -1, 'syncContentGeometry exists');
    const end = APPLET_SRC.indexOf('_syncAiPaneGeometry() {', geoIdx);
    const geo = APPLET_SRC.slice(geoIdx, end !== -1 ? end : geoIdx + 6000);
    const aiIdx = geo.indexOf("if (!this._hasConversation()) {");
    assert.ok(aiIdx !== -1, 'AI idle branch exists');
    // exactly two margin_top assertions: shared search formula + AI idle re-assert
    const hits = geo.match(/set_margin_top\(needTop\)/g) || [];
    assert.equal(hits.length, 2, 'search anchor + AI idle re-assert, nothing else');
    const aiBranch = geo.slice(aiIdx, aiIdx + 1200);
    assert.ok(aiBranch.includes('set_margin_top(needTop)'), 'AI idle re-asserts the same anchor');
});

test('both switches refocus via guarded helper (no unconditional key-focus reset)', () => {
    assert.ok(APPLET_SRC.includes('_refocusTopEntry() {'), 'guard helper exists');
    const goIdx = APPLET_SRC.indexOf('_goToAiMode() {');
    const sIdx = APPLET_SRC.indexOf('_goToSearchMode() {');
    const sEnd = APPLET_SRC.indexOf('_clearNormalResultsForModeSwitch() {', sIdx);
    const ai = APPLET_SRC.slice(goIdx, sIdx);
    const search = APPLET_SRC.slice(sIdx, sEnd);
    assert.ok(ai.includes('_refocusTopEntry()'), 'AI switch uses guarded refocus');
    assert.ok(search.includes('_refocusTopEntry()'), 'Search switch uses guarded refocus');
    assert.ok(!ai.includes('set_key_focus(this._overlay._entry)'), 'no raw refocus on AI path');
    assert.ok(!search.includes('set_key_focus(this._overlay._entry)'), 'no raw refocus on search path');
});
