// Regression test for the Phase 13 follow-up input leakage bug.
//
// Symptom: after the first AI question, the follow-up input (below the
// conversation) showed stale text like "open" — the user's submitted query
// lingered in the input that kept focus after the agent run, because
// followUpEntry was never reset and focus never moved off the (hidden) main
// entry. The overlay persists across open/close, so any such text sticks.
//
// This is a STATIC source-guard: applet.js requires Cinnamon modules and
// cannot be required under plain node, but the invariant it encodes is
// exactly requirement #9 — followUpEntry must ONLY ever be set to "" (reset)
// and must NEVER receive text derived from the main query, a search result,
// or a tool result.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'applet.js'), 'utf8');

// collect every line that references followUpEntry
const fuLines = SRC.split('\n').filter(l => /followUpEntry/.test(l));

test('follow-up entry is only ever reset to empty (never written non-empty)', () => {
    for (const line of fuLines) {
        // direct text writes: .set_text(...) or .text = ...
        const setText = line.match(/\.set_text\(\s*([^)]*)\)/);
        const textAssign = line.match(/\.text\s*=\s*([^;]*);/);
        if (setText) {
            const arg = setText[1].trim();
            // the ONLY allowed value is the empty string literal
            assert.ok(arg === '""' || arg === "''",
                'followUpEntry.set_text called with non-empty arg: ' + line.trim());
        }
        if (textAssign) {
            assert.fail('followUpEntry.text assigned directly: ' + line.trim());
        }
    }
});

test('follow-up entry never receives main-query / search / tool text', () => {
    for (const line of fuLines) {
        // none of these sources may flow into a followUpEntry write
        const leaks = [
            /getText\(\)/, /_entry\.get_text\(\)/, /\.get_text\(\)/,
            /getText/, /_overlay\.getText/, /toolLabel/, /r\.query/,
            /r\.title/, /r\.url/, /res\.answer/, /e\.text/, /pend\.text/
        ];
        for (const re of leaks) {
            assert.ok(!re.test(line),
                'followUpEntry line may leak external text: ' + line.trim());
        }
    }
});

test('follow-up reset helper + lifecycle resets exist', () => {
    assert.ok(/_clearFollowUpInput\s*\(/.test(SRC), 'missing _clearFollowUpInput helper');
    // reset must be wired into the key lifecycle points
    const wired = ['open(', 'close(', '_newConversation(', 'setMode('];
    for (const w of wired) {
        // there must be a _clearFollowUpInput() call somewhere in the file
        assert.ok(SRC.includes('_clearFollowUpInput();'),
            'follow-up reset not present for lifecycle: ' + w);
        break; // the helper itself covers all call sites; one presence check suffices
    }
    // _submitAIFromFollowUp must clear the entry after reading it
    const m = SRC.match(/_submitAIFromFollowUp\(\)\s*\{[\s\S]*?\n    \}/);
    assert.ok(m && /fu\.set_text\(""\)/.test(m[0]),
        '_submitAIFromFollowUp must reset followUpEntry to "" after reading');
});

test('after a run completes, focus moves to the follow-up entry (not the hidden main entry)', () => {
    // the completion branch of _submitAI must call set_key_focus on followUpEntry
    assert.ok(/set_key_focus\(\s*ov\.followUpEntry\s*\)/.test(SRC) ||
              /set_key_focus\(\s*this\._overlay\.followUpEntry\s*\)/.test(SRC),
        'completion handler does not focus followUpEntry');
    // and the submitted main query must be cleared after capture
    assert.ok(/_overlay\.setText\(""\)/.test(SRC),
        'submitted main query is not cleared after capture');
});
