// UI/UX REDESIGN — ADVANCED_SEARCH_AI_UIUX_REDESIGN regression gate.
// Phases UI-1 (layout foundation), UI-2 (search experience), UI-3 (AI experience),
// UI-4 (adaptive + polish). applet.js cannot be required in node (GJS imports), so
// UI structure is pinned via source assertions + replicated pure logic, matching the
// p1p2-gate convention. Ranking/Best Match/keyboard/AI pipeline logic is NOT touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'stylesheet.css'), 'utf8');

// ---- UI-1: Layout foundation ----

test('UI-1: search pill has leading search icon + compact close button (✕)', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-search-icon'), 'search icon class in pill');
    assert.ok(APPLET_SRC.includes('this._closeButton = new St.Button'), 'close button built');
    assert.ok(APPLET_SRC.includes('quicksearch-close-button'), 'close button class');
    assert.ok(APPLET_SRC.includes('entryRow.add(this._closeButton)'), 'close button lives inside the pill');
    const closeIdx = APPLET_SRC.indexOf('this._closeButton.connect');
    const closeSection = APPLET_SRC.slice(closeIdx, closeIdx + 200);
    assert.ok(closeSection.includes('this._applet.close()'), 'close button closes the applet');
});

test('UI-1: adaptive layout constants are the single source of truth', () => {
    assert.ok(APPLET_SRC.includes('const LAYOUT = {'), 'LAYOUT constants exist');
    for (const k of ['topPad', 'pillH', 'filterH', 'hintsH', 'maxResultsH', 'roomCapMin']) {
        assert.ok(APPLET_SRC.includes(k + ':'), `LAYOUT has ${k}`);
    }
    assert.ok(APPLET_SRC.includes('LAYOUT.maxResultsH'), 'panel cap routed through LAYOUT');
    assert.ok(APPLET_SRC.includes('LAYOUT.roomCapMin'), 'room cap routed through LAYOUT');
    assert.ok(CSS_SRC.includes('padding: 120px 0 0 0;'), 'dialog top padding matches LAYOUT.topPad');
    assert.ok(CSS_SRC.includes('min-height: 0;'), 'content no longer forces a tall fixed dialog');
});

// ---- UI-2: Search experience ----

test('UI-2: horizontal category filter chips exist with the full category set', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-filter-row'), 'filter row class');
    assert.ok(APPLET_SRC.includes('quicksearch-filter-chip'), 'chip class');
    assert.ok(APPLET_SRC.includes('this._filterButtons'), 'chip registry');
    for (const cat of ['all', 'app', 'file', 'folder', 'settings', 'web']) {
        assert.ok(APPLET_SRC.includes('"' + cat + '"') || APPLET_SRC.includes("'" + cat + "'"), `category ${cat} present`);
    }
    assert.ok(APPLET_SRC.includes('_setCategory'), 'category setter exists');
    assert.ok(APPLET_SRC.includes('_syncFilterUI'), 'chip active-state sync exists');
    assert.ok(APPLET_SRC.includes('quicksearch-filter-chip-active'), 'active chip highlight');
});

test('UI-2: category filter is presentation-only — never re-ranks', () => {
    // _filterResults filters the ALREADY-ranked set by type; ranking logic untouched.
    const { makeResult, scoreResult } = require('../result.js');
    const mk = (type, score, n) => {
        const base = type === 'app'
            ? makeResult({ type, title: 't' + n, appId: 'id' + n, score })
            : makeResult({ type, title: 't' + n, path: '/p/' + n, score });
        base.score = score;
        return base;
    };
    const file = mk('file', 180, 1);
    const folder = mk('file', 160, 2); folder.icon = 'folder-symbolic';
    const app = mk('app', 150, 3);
    const web = mk('web', 90, 4);
    const settingsApp = mk('app', 140, 5); settingsApp.title = 'System Settings';
    const all = [file, folder, app, web, settingsApp];
    const sorted = all.slice().sort((a, b) => b.score - a.score);

    // replicate _filterResults (applet method; GJS-only file cannot be required)
    function filterResults(results, cat) {
        if (cat === 'all') return results;
        return results.filter(r => {
            if (!r) return false;
            if (cat === 'app') return r.type === 'app';
            if (cat === 'web') return r.type === 'web';
            if (cat === 'file') return r.type === 'file' && String(r.icon || '') !== 'folder-symbolic';
            if (cat === 'folder') return r.type === 'file' && String(r.icon || '') === 'folder-symbolic';
            if (cat === 'settings') {
                if (r.type !== 'app') return false;
                const hay = String(r.title || '').toLowerCase() + ' ' + String(r.description || '').toLowerCase();
                return hay.indexOf('settings') !== -1 || hay.indexOf('pengaturan') !== -1 || hay.indexOf('preferensi') !== -1;
            }
            return true;
        });
    }

    assert.deepEqual(filterResults(sorted, 'all').map(r => r.id), sorted.map(r => r.id), 'all keeps global order');
    assert.deepEqual(filterResults(sorted, 'file').map(r => r.id), [file.id], 'file excludes folders');
    assert.deepEqual(filterResults(sorted, 'folder').map(r => r.id), [folder.id], 'folder = folder-symbolic only');
    assert.deepEqual(filterResults(sorted, 'app').map(r => r.id), [app.id, settingsApp.id], 'apps kept');
    assert.deepEqual(filterResults(sorted, 'settings').map(r => r.id), [settingsApp.id], 'settings app only');
    assert.deepEqual(filterResults(sorted, 'web').map(r => r.id), [web.id], 'web kept');
});

test('UI-2: Best Match leads the panel and is NOT duplicated in sections', () => {
    // replicate renderResults assembly: Best Match first, sections skip its id.
    const { makeResult, scoreResult } = require('../result.js');
    const file = makeResult({ type: 'file', title: 'exact.txt', path: '/a/exact.txt', score: scoreResult('file-exact') });
    const app = makeResult({ type: 'app', title: 'Something', appId: 'something.desktop', score: scoreResult('keyword') });
    const web = makeResult({ type: 'web', title: 'w', url: 'https://e.com', score: scoreResult('web-instant') });
    const sorted = [file, app, web];

    const SECTION_ORDER = [['calc', null], ['url', null], ['app', 'APPLICATIONS'], ['file', 'FILES'], ['web', 'WEB']];
    const mainRows = [];
    const best = sorted[0];
    mainRows.push({ header: 'Best Match', bestHeader: true });
    mainRows.push({ result: best, bestMatch: true });
    for (const [type, header] of SECTION_ORDER) {
        const group = sorted.filter(r => r.type === type && r.id !== best.id);
        if (!group.length) continue;
        if (header) mainRows.push({ header });
        for (const r of group) mainRows.push({ result: r });
    }

    const bestRows = mainRows.filter(r => r.bestMatch);
    assert.equal(bestRows.length, 1, 'exactly one Best Match row');
    assert.equal(bestRows[0].result.id, file.id, 'Best Match is the top-ranked result');
    const ids = mainRows.filter(r => r.result).map(r => r.result.id);
    assert.equal(ids.filter(id => id === file.id).length, 1, 'best match appears exactly once (no duplication)');
    assert.equal(mainRows[0].bestHeader, true, 'Best Match header first');
    assert.ok(APPLET_SRC.includes('_("Best Match")'), 'Best Match header translated');
    assert.ok(APPLET_SRC.includes('quicksearch-best-match'), 'best match surface class');
    assert.ok(APPLET_SRC.includes('quicksearch-best-match-hint'), 'Enter hint class');
    assert.ok(APPLET_SRC.includes('_("Enter")'), 'Enter hint translated');
});

test('UI-2: empty state exists and stays out of the idle panel', () => {
    assert.ok(APPLET_SRC.includes('_("Tidak ada hasil untuk pencarian ini.")'), 'empty state message');
    assert.ok(APPLET_SRC.includes('quicksearch-empty'), 'empty state class');
    assert.ok(CSS_SRC.includes('.quicksearch-empty'), 'empty state styled');
    // empty marker is only pushed when a query is present
    const renderIdx = APPLET_SRC.indexOf('renderResults(results) {');
    const renderSection = APPLET_SRC.slice(renderIdx, renderIdx + 4200);
    assert.ok(renderSection.includes('mainRows.push({ empty: true })'), 'empty marker only in the no-results branch');
    assert.ok(CSS_SRC.includes('.quicksearch-row:hover'), 'row hover state styled');
});

// ---- UI-3: AI experience ----

test('UI-3: AI Mode stays strictly separated from search UI', () => {
    // filter chips are hidden in AI mode from BOTH the mode sync and the AI renderer
    assert.ok(APPLET_SRC.includes("if (ov._filterRow) ov._filterRow.visible = false"), 'mode sync hides chips in AI');
    const renderIdx = APPLET_SRC.indexOf('_renderAIState() {');
    const aiSection = APPLET_SRC.slice(renderIdx, renderIdx + 1200);
    assert.ok(aiSection.includes('ov._filterRow'), 'AI renderer touches the filter row');
    assert.ok(aiSection.includes('visible = false'), 'AI renderer hides it');
    // no local apps/files results are ever rendered in AI mode — the AI renderer
    // only ever adds conversation messages, headings, sources, errors
    assert.ok(!aiSection.includes('_buildLocals'), 'AI renderer never builds local launcher rows');
});

test('UI-3: AI Answer heading + markdown presentation', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-ai-answer-heading'), 'answer heading class');
    assert.ok(APPLET_SRC.includes('_("\\u2728 AI Answer")') || APPLET_SRC.includes('_("✨ AI Answer")'), 'heading translated');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-answer-heading'), 'heading styled');
    const mdText = CSS_SRC.slice(CSS_SRC.indexOf('.quicksearch-ai-md-text {'), CSS_SRC.indexOf('.quicksearch-ai-md-text {') + 200);
    assert.ok(mdText.includes('padding'), 'paragraph spacing added for readability');
});

test('UI-3: code blocks get a distinct surface with a FUNCTIONAL copy action', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-ai-md-codebox'), 'code block surface');
    assert.ok(APPLET_SRC.includes('quicksearch-ai-md-code-copy'), 'code copy button class');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-md-codebox'), 'code surface styled');
    assert.ok(CSS_SRC.includes('font-family: monospace'), 'monospace preserved');
    const codeIdx = APPLET_SRC.indexOf('block.kind === \'code\'');
    const codeSection = APPLET_SRC.slice(codeIdx, codeIdx + 2500);
    assert.ok(codeSection.includes('_copyUserMessageToClipboard(codeText)'), 'copy is functional');
    // the clipboard helper itself is the runtime-safe St.Clipboard path (also pinned
    // by ai-phase9) — code copy must reuse it, never navigator.clipboard
    assert.ok(APPLET_SRC.includes('St.Clipboard.get_default()'), 'copy uses the runtime-safe clipboard path');
});

test('UI-3: sources render inline (pills + View more) while keeping the popover', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-ai-source-pill'), 'source pill class');
    assert.ok(APPLET_SRC.includes('_("View more")'), 'View more translated');
    assert.ok(APPLET_SRC.includes('_toggleSourcesPopover'), 'full popover still reachable');
    assert.ok(APPLET_SRC.includes('quicksearch-ai-sources-button-viewmore'), 'view more class');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-source-pill'), 'pills styled');
    // runtime-safe click path: no global URL API, structural gate + Gio launch intact
    const start = APPLET_SRC.indexOf('_renderSourcesForMessage(ov, sources) {');
    assert.ok(start !== -1, 'compat definition marker preserved');
    const section = APPLET_SRC.slice(start, start + 2600);
    assert.ok(!section.includes('new URL('), 'no global URL dependency');
    assert.ok(section.includes('if (!/^https?:'), 'structural http(s) gate present');
    assert.ok(section.includes('launch_default_for_uri_async(trimmed'), 'Gio launch path intact');
});

test('UI-3: follow-up composer keeps the compact AI-tool feel', () => {
    assert.ok(APPLET_SRC.includes('quicksearch-ai-composer-plus'), 'composer + prefix');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer-plus'), 'composer + styled');
    assert.ok(APPLET_SRC.includes('_("Ask a follow-up...")'), 'follow-up hint preserved');
    assert.ok(APPLET_SRC.includes('_composerSend'), 'Send action preserved');
});

// ---- UI-4: Adaptive + polish ----

test('UI-4: context-aware keyboard hints (subtle, mode-aware)', () => {
    assert.ok(APPLET_SRC.includes('_updateHints'), 'hints updater exists');
    assert.ok(APPLET_SRC.includes('quicksearch-hints'), 'hints class');
    assert.ok(CSS_SRC.includes('.quicksearch-hints'), 'hints styled');
    assert.ok(APPLET_SRC.includes('_("\\u2191 \\u2193 Navigate \\u00b7 Enter Open \\u00b7 Esc Close")') ||
              APPLET_SRC.includes('_("↑ ↓ Navigate · Enter Open · Esc Close")'), 'search hints translated');
    assert.ok(APPLET_SRC.includes('_("Enter Send \\u00b7 Esc Close")') || APPLET_SRC.includes('_("Enter Send · Esc Close")'), 'AI hints translated');
    // geometry reserves room for the hints bar so content never renders under it
    const geoIdx = APPLET_SRC.indexOf('_syncRegionGeometry() {');
    const geoSection = APPLET_SRC.slice(geoIdx, geoIdx + 2400);
    assert.ok(geoSection.includes('ov._hintsLabel && ov._hintsLabel.visible'), 'hints height reserved in geometry');
    assert.ok(geoSection.includes('ov._filterRow && ov._filterRow.visible'), 'filter row height reserved in geometry');
});

test('UI-4: adaptive sizing — panel grows to content, capped, scrollable', () => {
    assert.ok(APPLET_SRC.includes('ov._scroll.set_position(0, hdrH)'), 'scroll offset below chat header preserved');
    assert.ok(APPLET_SRC.includes('resultsRegion.set_size(w, h)'), 'region sized to content preserved');
    assert.ok(APPLET_SRC.includes('St.PolicyType.AUTOMATIC'), 'scroll policy automatic (cap + scroll)');
    assert.ok(APPLET_SRC.includes('Math.min(natH, LAYOUT.maxResultsH, roomCap)'), 'grow-to-cap behavior');
});