// Web search (spec §10 / 24-H): browser-search fallback ALWAYS instant,
// DuckDuckGo instant answers best-effort upgrade. Failure here never breaks
// local search. Cancellable owned by engine (guardrail 3).
const Gio = require('gi.Gio');
const GLib = require('gi.GLib');
const Soup = require('gi.Soup');

const REQUEST_TIMEOUT_MS = 4000;

function createWebProvider(helpers) {
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    // settings-driven: fallback URL per engine choice; DDG instant answers only for ddgo
    const fallbackUrlFor = helpers.fallbackUrlFor || (q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q));
    const searchEngineLabel = helpers.searchEngineLabel || 'DuckDuckGo';
    const useInstantAnswers = helpers.useInstantAnswers !== false;
    let session = null;

    function search(query, cancellable, onDone) {
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

        let settled = false;
        // NOTE: onDone may fire twice by design: instant fallback, then
        // upgraded list when DDG answers. Engine replaces the web bucket.
        const deliver = (list) => {
            if (cancellable.is_cancelled()) return;
            onDone(list);
        };

        deliver([fallback]); // guaranteed, instant (spec 24-H)

        if (!q || !useInstantAnswers) return;

        try {
            if (!session) session = new Soup.Session();

            const apiUrl = 'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' +
                encodeURIComponent(q);
            const msg = Soup.Message.new('GET', apiUrl);
            if (!msg) return;

            session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                if (cancellable.is_cancelled()) return;
                try {
                    const bytes = s.send_and_read_finish(res);
                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    if (cancellable.is_cancelled()) return;

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
                    if (extra.length) deliver([fallback].concat(extra)); // upgrade
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
        Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
    } catch (e) { /* never crash (spec 24-K) */ }
}

module.exports = { createWebProvider };
