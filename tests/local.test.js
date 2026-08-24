const { test } = require('node:test');
const assert = require('node:assert');
const { buildLocalRows } = require('../utils.js');
const { processResults, makeResult, SCORES } = require('../result.js');

const RECENT = ['Gesture', 'gemini ai', 'gempa hari ini', 'gemini', 'document'];
const APPS = ['Gemini AI', 'Gedit', 'Files', 'Document Viewer'];

test('empty query yields nothing (strict empty state)', () => {
    const r = buildLocalRows('', RECENT, APPS);
    assert.deepEqual(r, { history: [], suggestion: [] });
    assert.deepEqual(buildLocalRows('   ', RECENT, APPS).history, []);
});

test('history prefix-match case-insensitive', () => {
    const r = buildLocalRows('ge', RECENT, APPS);
    assert.ok(r.history.includes('Gesture'));
    assert.ok(r.history.includes('gemini ai'));
    assert.equal(r.history.length, 3); // capped
});

test('exact active query excluded from history', () => {
    const r = buildLocalRows('gemini', RECENT, APPS);
    assert.ok(!r.history.includes('gemini')); // exact match hidden
    assert.ok(!r.suggestion.map(s => s.toLowerCase()).includes('gemini'));
});

test('suggestions from app names, not duplicating history', () => {
    const r = buildLocalRows('ge', RECENT, APPS);
    const low = r.suggestion.map(s => s.toLowerCase());
    assert.ok(low.includes('gedit'));
    for (const h of r.history) assert.ok(!low.includes(h.toLowerCase()));
});

test('caps respected (3 + 3)', () => {
    const manyRecent = ['aa1','aa2','aa3','aa4','aa5'];
    const manyApps = ['ab1','ab2','ab3','ab4'];
    const r = buildLocalRows('a', manyRecent, manyApps);
    assert.equal(r.history.length, 3);
    assert.equal(r.suggestion.length, 3);
});

test('local rows rank above calculator in merged results', () => {
    const hist = makeResult({ type: 'history', title: 'gesture', description: '', icon: '', score: SCORES.history });
    const calc = makeResult({ type: 'calc', title: '8', description: '', icon: '', score: SCORES.calc });
    const sug = makeResult({ type: 'suggestion', title: 'gedit', description: '', icon: '', score: SCORES.suggestion });
    const out = processResults([[hist], [calc], [sug]], {});
    assert.deepEqual(out.map(r => r.type), ['history', 'suggestion', 'calc']);
});
