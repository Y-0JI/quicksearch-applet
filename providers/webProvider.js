// Web search (spec §10 / 24-H): browser-search fallback ALWAYS instant,
// DuckDuckGo instant answers best-effort upgrade. Failure here never breaks
// local search. Cancellable owned by engine (guardrail 3).
//
// Phase 13 latency audit: made loader-safe (Soup/Gio/GLib are OPTIONAL so this
// module can be required under node --test), HTTP transport injectable, and a
// lightweight onStage timing hook so benchmarks measure each stage WITHOUT
// ever logging API keys or private data. Behavior for SEARCH mode is unchanged.
let Gio = null, GLib = null, Soup = null;
try { Gio = require('gi.Gio'); } catch (e) {}
try { GLib = require('gi.GLib'); } catch (e) {}
try { Soup = require('gi.Soup'); } catch (e) {}

const REQUEST_TIMEOUT_MS = 4000;

// Default transport: one GET via Soup, returns (err, dataString). The SAME
// contract an injected mock must satisfy, so benchmarks can swap it freely.
function defaultHttpGet(url, cancellable, onResult) {
    try {
        if (!Soup) return onResult(new Error('no-soup'));
        if (!session) session = new Soup.Session();
        const msg = Soup.Message.new('GET', url);
        if (!msg) return onResult(new Error('bad-url'));
        session.send_and_read_async(msg, (GLib ? GLib.PRIORITY_DEFAULT : 0), cancellable, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                onResult(null, new TextDecoder().decode(bytes.get_data()));
            } catch (e) { onResult(e); }
        });
    } catch (e) { onResult(e); }
}

function createWebProvider(helpers) {
    helpers = helpers || {};
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    // settings-driven: fallback URL per engine choice; DDG instant answers only for ddgo
    const fallbackUrlFor = helpers.fallbackUrlFor || (q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q));
    const searchEngineLabel = helpers.searchEngineLabel || 'DuckDuckGo';
    const useInstantAnswers = helpers.useInstantAnswers !== false;
    // injected transport + timing hook (both optional; no-op in production)
    const httpGet = typeof helpers.httpGet === 'function' ? helpers.httpGet : defaultHttpGet;
    const onStage = typeof helpers.onStage === 'function' ? helpers.onStage : null;
    const stage = (name) => { if (onStage) { try { onStage(name, Date.now()); } catch (e) {} } };
    let session = null;

    function search(query, cancellable, onDone, opts) {
        const q = String(query || '').trim();
        const searchUrl = fallbackUrlFor(q);

        const fallback = makeResult({
            type: 'web',
            title: 'Search the web for "' + q + '"',
            description: searchEngineLabel,
            icon: 'web-browser',
            score: scoreResult('web-fallback'),
            url: searchUrl,
            action: () => _openBrowser(searchUrl)
        });

        // NOTE: onDone may fire twice by design: instant fallback, then
        // upgraded list when DDG answers. Engine replaces the web bucket.
        const deliver = (list) => {
            if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
            onDone(list);
        };

        stage('search-start');
        deliver([fallback]); // guaranteed, instant (spec 24-H)

        // The agent path always wants REAL results, regardless of the applet's
        // chosen search engine (which only gates the SEARCH-mode fallback
        // upgrade). Force the DDG instant-answer fetch for agent callers.
        const doInstant = useInstantAnswers || !!(opts && opts.agent);
        if (!q || !doInstant) return;

        try {
            if (!session && Soup) session = new Soup.Session();
            const apiUrl = 'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' +
                encodeURIComponent(q);
            stage('http-start');
            httpGet(apiUrl, cancellable, (err, dataStr) => {
                if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;
                stage('http-done');
                if (err) return; // network/parse failure: fallback already delivered
                try {
                    const data = JSON.parse(dataStr);
                    if (cancellable && cancellable.is_cancelled && cancellable.is_cancelled()) return;

                    const extra = [];
                    if (data.AbstractText && data.AbstractURL) {
                        extra.push(makeResult({
                            type: 'web',
                            title: String(data.AbstractText).slice(0, 120),
                            description: data.Heading || searchEngineLabel,
                            icon: 'web-browser',
                            score: scoreResult('web-instant'),
                            url: data.AbstractURL,
                            action: () => _openBrowser(data.AbstractURL)
                        }));
                    }
                    const topics = (data.RelatedTopics || []).filter(t => t.FirstURL && t.Text);
                    for (let i = 0; i < Math.min(topics.length, 4); i++) {
                        const t = topics[i];
                        extra.push(makeResult({
                            type: 'web',
                            title: String(t.Text).slice(0, 100),
                            description: t.FirstURL.replace(/^https?:\/\//, '').split('/')[0],
                            icon: 'web-browser',
                            score: scoreResult('web-instant'),
                            url: t.FirstURL,
                            action: () => _openBrowser(t.FirstURL)
                        }));
                    }
                    stage('parse-done');
                    if (extra.length) { deliver([fallback].concat(extra)); stage('deliver'); }
                } catch (e) { /* network/parse failure: fallback already delivered */ }
            });
        } catch (e) { /* Soup unavailable etc.: fallback stands alone */ }
    }

    function destroy() {
        session = null;
    }

    return { search, destroy };
}

function _openBrowser(url) {
    try {
        if (Gio) Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
    } catch (e) { /* never crash (spec 24-K) */ }
}

module.exports = { createWebProvider, REQUEST_TIMEOUT_MS, defaultHttpGet };
