// SearchEngine: debounce -> classify -> dispatch providers (per-provider
// isolation) -> flush partial results on every completion while generation
// is current. No pending counters; buckets + generation only (guardrails 2,3).
const Gio = require('gi.Gio');
const GLib = require('gi.GLib');
const Mainloop = require('mainloop');

const StClipboardHack = null; // clipboard handled in UI layer

function createSearchEngine(helpers) {
    const {
        makeResult, scoreResult, processResults, classifyQuery,
        tryCalculate, detectUrl,
        appProvider, fileProvider, webProvider
    } = helpers;

    const limits = helpers.limits || { app: 5, file: 15, web: 5 };
    const debounceMs = helpers.debounceMs || 150;
    const enabled = helpers.enabled || { files: true, web: true };

    let gen = 0;                 // monotonic query generation
    let lastError = null;        // diagnostics: last swallowed provider error
    let timerId = 0;             // debounce timeout source
    let cancellable = null;      // guardrail 3: one per effective query
    let buckets = null;          // per-gen result buckets
    let onResultsCb = null;

    function query(text, cb) {
        onResultsCb = cb;
        _clearTimer();
        // guardrail 3: new keystroke supersedes any running query immediately
        _cancelCurrent();

        const q = String(text || '');
        if (!q.trim()) {
            gen++;
            buckets = _emptyBuckets();
            if (onResultsCb) onResultsCb([]);
            return;
        }

        timerId = Mainloop.timeout_add(debounceMs, () => {
            timerId = 0;
            _run(q);
            return GLib.SOURCE_REMOVE;
        });
    }

    function cancel() {
        _clearTimer();
        gen++;               // invalidate in-flight callbacks
        _cancelCurrent();
    }

    function destroy() {
        cancel();
        try { appProvider.destroy(); } catch (e) {}
        try { fileProvider.destroy(); } catch (e) {}
        try { webProvider.destroy(); } catch (e) {}
    }


    // ---- internals ----

    function _clearTimer() {
        if (timerId) {
            GLib.source_remove(timerId);
            timerId = 0;
        }
    }

    function _cancelCurrent() {
        if (cancellable) {
            try { cancellable.cancel(); } catch (e) {}
            cancellable = null;
        }
    }

    function _emptyBuckets() {
        return { calc: [], url: [], app: [], file: [], web: [] };
    }

    function _run(q) {
        gen++;
        const myGen = gen;
        cancellable = new Gio.Cancellable(); // fresh for this query (guardrail 3)
        buckets = _emptyBuckets();

        const stale = () => myGen !== gen;
        const flush = () => {
            if (stale() || !onResultsCb) return;
            const lists = [buckets.calc, buckets.url, buckets.app, buckets.file, buckets.web];
            onResultsCb(processResults(lists, limits));
        };

        let cls;
        try {
            cls = classifyQuery(q);
        } catch (e) {
            lastError = 'classify:' + e.message;
            flush();
            return;
        }

        // instant providers (sync, never throw past this block)
        if (cls.url) {
            try {
                const url = detectUrl(q);
                if (!url) { lastError = 'url:detect falsy'; }
                else buckets.url.push(makeResult({
                    type: 'url',
                    title: url,
                    description: 'Open URL',
                    icon: 'web-browser',
                    score: scoreResult('url'),
                    action: () => _openUrl(url)
                }));
            } catch (e) { lastError = 'url:' + e.message; }
        } else if (cls.calc) {
            try {
                const calc = tryCalculate(q);
                if (calc) buckets.calc.push(makeResult({
                    type: 'calc',
                    title: calc.value,
                    description: calc.expression + ' =',
                    icon: 'accessories-calculator',
                    score: scoreResult('calc'),
                    action: () => _copyToClipboard(calc.value)
                }));
            } catch (e) {}
        }

        if (!cls.apps && !cls.files && !cls.web) {
            flush();
            return;
        }

        // applications (sync index)
        if (cls.apps) {
            try {
                buckets.app = appProvider.searchApps(q, limits.app);
            } catch (e) { buckets.app = []; } // provider isolation (spec 24-I)
        }

        // async providers share THIS query's cancellable (guardrail 3)
        if (enabled.files && cls.files && fileProvider) {
            try {
                fileProvider.search(q, cancellable, results => {
                    if (stale()) return;
                    buckets.file = results || [];
                    flush(); // guardrail 2: render as soon as each provider finishes
                });
            } catch (e) { buckets.file = []; }
        }

        if (enabled.web && cls.web && webProvider) {
            try {
                webProvider.search(q, cancellable, results => {
                    if (stale()) return;
                    buckets.web = results || [];
                    flush();
                });
            } catch (e) { buckets.web = []; }
        }

        flush(); // sync results visible immediately (spec §31 first-result ASAP)
    }

    function _openUrl(url) {
        const Gio2 = require('gi.Gio');
        try { Gio2.AppInfo.launch_default_for_uri_async(url, null, null, null); } catch (e) {}
    }

    function _copyToClipboard(text) {
        try {
            const St = require('gi.St');
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        } catch (e) {}
    }

    return { query, cancel, destroy };
}

module.exports = { createSearchEngine };
