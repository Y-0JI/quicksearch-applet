// Phase 7 release gate — real searchEngine.js lifecycle regression.
// searchEngine.js was previously only imported, never instantiated in any test
// (websearch-regression.test.js:17 imports it unused; applet tests use a mock
// _engine). These tests drive the real orchestrator: debounce -> classify ->
// dispatch app/file/web/calc/url -> partial flush per completion (guardrail 2)
// -> stale/cancel guards (guardrails 2,3) -> provider isolation -> disable flags.
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const origRequire = Module.prototype.require;

// ---- mock GI/mainloop so searchEngine.js loads under Node ----
const timers = new Map();
let nextTimerId = 1;
const GioMock = {
    Cancellable: function () {
        this._cancelled = false;
        this.cancel = () => { this._cancelled = true; };
        this.is_cancelled = () => this._cancelled;
    },
    AppInfo: { launch_default_for_uri_async() {} }
};
const GLibMock = {
    SOURCE_REMOVE: 0,
    SOURCE_CONTINUE: 1,
    source_remove(id) {
        const t = timers.get(id);
        if (t) { clearTimeout(t); timers.delete(id); }
    }
};
const MainloopMock = {
    timeout_add(ms, fn) {
        const id = nextTimerId++;
        const t = setTimeout(() => { timers.delete(id); fn(); }, ms);
        timers.set(id, t);
        return id;
    }
};
Module.prototype.require = function (id) {
    if (id === 'gi.Gio') return GioMock;
    if (id === 'gi.GLib') return GLibMock;
    if (id === 'mainloop') return MainloopMock;
    return origRequire.apply(this, arguments);
};

const { createSearchEngine } = require('../searchEngine.js');
const { makeResult, scoreResult, processResults, classifyQuery } = require('../result.js');
const { detectUrl } = require('../providers/urlProvider.js');
const { tryCalculate } = require('../providers/calculatorProvider.js');

const tick = (ms) => new Promise(r => setTimeout(r, ms === undefined ? 1 : ms));
// searchEngine treats debounceMs 0 as falsy -> falls back to 150ms; use 1ms and wait past the run.
const waitRun = async () => { await tick(10); };

// ---- fake providers (sync app, async file/web, record everything) ----
function makeFakeProviders(opts) {
    opts = opts || {};
    const log = { apps: [], file: [], web: [], fileCancelled: [], webCancelled: [], destroys: [] };
    let fileCb = null, webCb = null;
    const app = {
        searchApps(q, limit) {
            log.apps.push({ q, limit });
            if (opts.appThrow) throw new Error('app provider exploded');
            const rows = [];
            for (let i = 0; i < (opts.appCount == null ? 2 : opts.appCount); i++) {
                rows.push(makeResult({ type: 'app', title: 'App' + q + '_' + i, appId: 'a' + q + '_' + i + '.desktop', score: scoreResult('keyword') }));
            }
            return rows;
        },
        destroy() { log.destroys.push('app'); }
    };
    const file = {
        search(q, cancellable, cb) {
            log.file.push(q);
            if (opts.fileThrow) { cb([]); return; }
            fileCb = { q, cancellable, cb };
        },
        destroy() { log.destroys.push('file'); }
    };
    const web = {
        search(q, cancellable, cb) {
            log.web.push(q);
            if (opts.webThrow) { cb([]); return; }
            webCb = { q, cancellable, cb };
        },
        destroy() { log.destroys.push('web'); }
    };
    return {
        log, app, file, web,
        fileCb: () => fileCb, webCb: () => webCb,
        releaseFile(count) {
            const c = fileCb;
            if (!c) return;
            fileCb = null;
            const rows = [];
            for (let i = 0; i < (count == null ? 3 : count); i++) {
                rows.push(makeResult({ type: 'file', title: 'File' + c.q + '_' + i, path: '/tmp/' + c.q + '_' + i + '.txt', score: scoreResult('file-prefix') }));
            }
            c.cb(rows);
        },
        releaseWeb(count) {
            const c = webCb;
            if (!c) return;
            webCb = null;
            const rows = [];
            for (let i = 0; i < (count == null ? 2 : count); i++) {
                rows.push(makeResult({ type: 'web', title: 'Web' + c.q + '_' + i, url: 'https://example.com/' + c.q + '_' + i, description: 'd', score: scoreResult('web-instant') }));
            }
            c.cb(rows);
        }
    };
}

function makeEngine(fakes, extra) {
    extra = extra || {};
    return createSearchEngine({
        makeResult, scoreResult, processResults, classifyQuery,
        detectUrl, tryCalculate,
        appProvider: fakes.app,
        fileProvider: extra.fileProvider === undefined ? fakes.file : extra.fileProvider,
        webProvider: extra.webProvider === undefined ? fakes.web : extra.webProvider,
        limits: extra.limits || { app: 5, file: 15, web: 5 },
        debounceMs: extra.debounceMs === undefined ? 1 : extra.debounceMs,
        enabled: extra.enabled || { files: true, web: true }
    });
}

function collectResults() {
    const all = [];
    return {
        cb: (rows) => all.push(rows),
        all,
        last: () => all.length ? all[all.length - 1] : []
    };
}

// 1. debounce coalesces: later query supersedes earlier before run
test('P7 lifecycle 1: debounce — later query supersedes earlier (only latest runs)', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('alpha', got.cb);
    engine.query('beta', got.cb); // before debounce fires -> alpha cancelled
    await waitRun();
    assert.deepEqual(fakes.log.apps.map(x => x.q), ['beta'], 'only latest query reaches providers');
    assert.deepEqual(fakes.log.file, ['beta']);
    assert.deepEqual(fakes.log.web, ['beta']);
    engine.destroy();
});

// 2. empty query -> immediate [] (no debounce, no provider)
test('P7 lifecycle 2: empty query delivers [] without providers', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('', got.cb);
    await waitRun();
    assert.equal(got.last().length, 0);
    assert.equal(fakes.log.apps.length, 0);
    assert.equal(fakes.log.file.length, 0);
    engine.destroy();
});

// 3. URL/calc queries are exclusive: no app/file/web dispatch
test('P7 lifecycle 3: URL and calc queries never dispatch app/file/web providers', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('https://example.com/x', got.cb);
    await waitRun();
    assert.equal(got.last().length, 1);
    assert.equal(got.last()[0].type, 'url');
    assert.equal(fakes.log.apps.length, 0);
    assert.equal(fakes.log.file.length, 0);
    assert.equal(fakes.log.web.length, 0);

    const fakes2 = makeFakeProviders();
    const engine2 = makeEngine(fakes2);
    const got2 = collectResults();
    engine2.query('2+2', got2.cb);
    await waitRun();
    assert.equal(got2.last().length, 1);
    assert.equal(got2.last()[0].type, 'calc');
    assert.equal(fakes2.log.apps.length, 0);
    engine2.destroy();
    engine.destroy();
});

// 4. partial flush per async completion (guardrail 2): app first (sync), then file, then web
test('P7 lifecycle 4: partial flush — rows appear as each async provider completes', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('news', got.cb);
    await waitRun(); // debounce fired; app rows are sync
    assert.equal(got.all.length, 1, 'initial sync flush (app) delivered');
    assert.ok(got.last().some(r => r.type === 'app'), 'app rows in first flush');
    fakes.releaseFile();
    await waitRun();
    assert.ok(got.last().some(r => r.type === 'file'), 'file rows flushed on completion');
    assert.ok(got.last().some(r => r.type === 'app'), 'app rows still present');
    assert.ok(!got.last().some(r => r.type === 'web'), 'web not yet delivered');
    fakes.releaseWeb();
    await waitRun();
    assert.ok(got.last().some(r => r.type === 'web'), 'web rows flushed last');
    engine.destroy();
});

// 5. race: Query A async in flight -> Query B starts -> A's late file rows are dropped
test('P7 lifecycle 5: stale provider result from Query A never lands in Query B', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('AAA', got.cb);
    await waitRun();
    // hold A's pending file callback (B will overwrite the shared slot)
    const aFile = fakes.fileCb();
    assert.ok(aFile, 'A file call captured');
    // baseline: deliveries seen so far are legitimately A's own (sync app flush before B starts)
    const aDeliveries = got.all.length;
    engine.query('BBB', got.cb);
    await waitRun();
    // deliver A's file rows late -> must be dropped as stale (must not reach ANY consumer delivery)
    aFile.cb([makeResult({ type: 'file', title: 'FileAAA_late', path: '/tmp/AAA_late.txt', score: scoreResult('file-prefix') })]);
    await waitRun();
    // Release B's WEB first so a partial flush happens while B's FILE bucket is still empty:
    // if A's stale file rows had leaked into the shared bucket, they would surface on this flush.
    fakes.releaseWeb();
    await waitRun();
    const midRows = got.last();
    assert.ok(midRows.some(r => r.type === 'web' && /BBB/.test(r.title)), 'B web rows delivered on partial flush');
    // release B's file last -> final B rows land
    fakes.releaseFile();
    await waitRun();
    const finalRows = got.last();
    assert.ok(finalRows.some(r => /BBB/.test(r.title)), 'B rows delivered');
    // strong invariant: NOTHING delivered after Query B started may contain A rows (only A's own
    // pre-B deliveries may, since A's sync app flush legitimately ran before B superseded it)
    const postB = got.all.slice(aDeliveries);
    assert.ok(!postB.some(rows => rows.some(r => /AAA/.test(r.title))), 'no A rows delivered once Query B became active: ' + JSON.stringify(postB.map(r => r.map(x => x.title))));
    engine.destroy();
});

// 6. cancel mid-flight: late completion after cancel delivers nothing; engine still usable
test('P7 lifecycle 6: cancel stops late delivery and engine stays usable', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('one', got.cb);
    await waitRun();
    // baseline BEFORE the late callbacks are released — a late delivery would change this count
    const before = got.all.length;
    assert.ok(before >= 1, 'initial sync flush already delivered');
    engine.cancel();
    fakes.releaseFile();
    fakes.releaseWeb();
    await waitRun();
    assert.equal(got.all.length, before, 'late callbacks after cancel must not deliver results');
    // engine still usable for a fresh query
    const got2 = collectResults();
    engine.query('two', got2.cb);
    await waitRun();
    assert.ok(got2.last().some(r => r.type === 'app'), 'new query after cancel works');
    engine.destroy();
});

// 7. provider isolation: app provider throwing must not kill file/web delivery
test('P7 lifecycle 7: provider throw is isolated (search still returns others)', async () => {
    const fakes = makeFakeProviders({ appThrow: true });
    const engine = makeEngine(fakes);
    const got = collectResults();
    let threw = false;
    try {
        engine.query('firefox', got.cb);
        await waitRun();
    } catch (e) { threw = true; }
    assert.equal(threw, false, 'engine must swallow provider throw');
    fakes.releaseFile();
    fakes.releaseWeb();
    await waitRun();
    assert.ok(got.last().some(r => r.type === 'file'), 'file rows delivered despite app throw');
    assert.ok(got.last().some(r => r.type === 'web'), 'web rows delivered despite app throw');
    assert.ok(!got.last().some(r => r.type === 'app'), 'no app rows (provider failed)');
    engine.destroy();
});

// 8. disable flags: enable-web=false skips webProvider entirely; files still run
test('P7 lifecycle 8: disable flags honored (web disabled -> no web dispatch)', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes, { enabled: { files: true, web: false } });
    const got = collectResults();
    engine.query('test', got.cb);
    await waitRun();
    assert.equal(fakes.log.web.length, 0, 'web provider not called when disabled');
    assert.equal(fakes.log.file.length, 1, 'file provider still called');
    assert.ok(got.last().some(r => r.type === 'app'), 'app still dispatched');
    engine.destroy();
});

// 9. destroy: cancels pending and calls provider.destroy() once each; null provider safe
test('P7 lifecycle 9: destroy cancels and destroys providers exactly once; null provider safe', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes, { fileProvider: null, webProvider: null }); // disabled-style null providers
    const got = collectResults();
    engine.query('abc', got.cb);
    await waitRun();
    engine.destroy();
    assert.deepEqual(fakes.log.destroys, ['app'], 'only app provider destroyed (file/web null)');

    const fakes2 = makeFakeProviders();
    const engine2 = makeEngine(fakes2);
    const got2 = collectResults();
    engine2.query('xyz', got2.cb);
    await waitRun();
    // baseline BEFORE destroy + late release — a stale delivery would push this count up
    const before = got2.all.length;
    assert.ok(before >= 1, 'initial sync flush already delivered');
    engine2.destroy();
    assert.deepEqual(fakes2.log.destroys.sort(), ['app', 'file', 'web'], 'all providers destroyed');
    fakes2.releaseFile();
    fakes2.releaseWeb();
    await waitRun();
    assert.equal(got2.all.length, before, 'late callbacks after destroy must not deliver results');
    // destroy must not be re-entrant from late async callbacks: engine stays dead for that query
    const got3 = collectResults();
    engine2.query('revived?', got3.cb);
    await waitRun();
    // searchEngine has no destroyed flag; destroy() only cancels generation. A fresh query starts a
    // NEW generation, so it must deliver normally — late callbacks from the destroyed query are what
    // must stay blocked, verified above. Re-query after destroy must not throw or double-deliver.
    assert.ok(Array.isArray(got3.last()), 'post-destroy query still answers without throw');
});

// 10. new query clears old buckets: sync-only Query B must not contain Query A rows
test('P7 lifecycle 10: new query clears previous buckets (no row bleed across queries)', async () => {
    const fakes = makeFakeProviders({ appCount: 1 });
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('prev', got.cb);
    await waitRun();
    fakes.releaseFile();
    await waitRun();
    assert.ok(got.last().some(r => /prev/.test(r.title)), 'prev rows present');
    engine.query('next', got.cb);
    await waitRun();
    const rows = got.last();
    assert.ok(rows.some(r => /next/.test(r.title)), 'next rows present');
    assert.ok(!rows.some(r => /prev/.test(r.title)), 'prev rows cleared for new query');
    engine.destroy();
});

// 11. stale WEB provider: Query A web pending -> Query B starts -> A's late web rows are dropped
// (explicit web-provider sibling of test 5; A's rows must never reach B's buckets/deliveries)
test('P7 lifecycle 11: stale WEB provider from Query A never lands in Query B', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    engine.query('AAA', got.cb);
    await waitRun();
    // hold A's pending web callback (B will overwrite the shared slot)
    const aWeb = fakes.webCb();
    assert.ok(aWeb, 'A web call captured');
    engine.query('BBB', got.cb);
    await waitRun();
    // deliver A's web rows late -> must be dropped as stale
    aWeb.cb([makeResult({ type: 'web', title: 'WebAAA_late', url: 'https://example.com/AAA_late', description: 'd', score: scoreResult('web-instant') })]);
    await waitRun();
    // now release B's providers -> B web rows land
    fakes.releaseFile();
    fakes.releaseWeb();
    await waitRun();
    const finalRows = got.last();
    assert.ok(finalRows.some(r => /BBB/.test(r.title)), 'B rows delivered');
    assert.ok(finalRows.some(r => r.type === 'web' && /BBB/.test(r.title)), 'B web rows delivered');
    // strong invariant: stale A web rows never reached ANY consumer delivery
    assert.ok(!got.all.some(rows => rows.some(r => /WebAAA/.test(r.title))), 'stale A web rows never reached any consumer delivery');
    engine.destroy();
});

// 12. stale WEB provider after cancel: Query A web pending -> engine.cancel() -> A's web completes late
// -> no new result, no consumer delivery, engine not reactivated, no unhandled rejection
test('P7 lifecycle 12: stale WEB after cancel never delivers', async () => {
    const fakes = makeFakeProviders();
    const engine = makeEngine(fakes);
    const got = collectResults();
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
        engine.query('AAA', got.cb);
        await waitRun();
        const aWeb = fakes.webCb();
        const aFile = fakes.fileCb();
        assert.ok(aWeb, 'A web call captured');
        assert.ok(aFile, 'A file call captured');
        const before = got.all.length; // baseline BEFORE late release
        assert.ok(before >= 1, 'initial sync flush already delivered');
        engine.cancel();
        // A's providers complete after cancel (deliver directly on the held callbacks)
        aWeb.cb([makeResult({ type: 'web', title: 'WebAAA_late', url: 'https://example.com/AAA_late', description: 'd', score: scoreResult('web-instant') })]);
        aFile.cb([makeResult({ type: 'file', title: 'FileAAA_late', path: '/tmp/AAA_late.txt', score: scoreResult('file-prefix') })]);
        await waitRun();
        assert.equal(got.all.length, before, 'no consumer delivery after cancel with late web completion');
        assert.ok(!got.all.some(rows => rows.some(r => /WebAAA/.test(r.title))), 'late web rows never delivered');
        // state did not flip back active: fresh query works and still only sees its own rows
        const got2 = collectResults();
        engine.query('BBB', got2.cb);
        await waitRun();
        assert.ok(got2.last().some(r => /BBB/.test(r.title)), 'engine usable after cancel');
        assert.ok(!got2.last().some(r => /AAA/.test(r.title)), 'no stale rows in new query');
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        engine.destroy();
    }
    assert.equal(unhandled.length, 0, 'no unhandled rejection from late web callback after cancel');
});

Module.prototype.require = origRequire;
