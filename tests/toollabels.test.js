const { test } = require('node:test');
const assert = require('node:assert');
const { toolLabel, TOOL_LABELS } = require('../utils.js');

test('toolLabel: complete human mapping (Phase 13 spec, verbatim)', () => {
    const expected = {
        search_files: 'Searching files...',
        search_web: 'Searching the web...',
        calculator: 'Calculating...',
        open_url: 'Opening link...',
        launch_app: 'Opening application...',
        open_file: 'Opening file...',
        get_screen: 'Looking at your screen...',
        focus_app: 'Focusing application...',
        click: 'Clicking...',
        type_text: 'Typing...',
        press_key: 'Pressing key...',
        scroll: 'Scrolling...'
    };
    for (const [id, label] of Object.entries(expected)) {
        assert.equal(toolLabel(id), label, id);
        assert.equal(TOOL_LABELS[id], label);
    }
    // every registered tool id has a label
    assert.deepEqual(Object.keys(TOOL_LABELS).sort(), Object.keys(expected).sort());
});

test('toolLabel: unknown/missing id -> null (never raw ids to users)', () => {
    assert.equal(toolLabel('mystery_tool'), null);
    assert.equal(toolLabel(''), null);
    assert.equal(toolLabel(undefined), null);
});
