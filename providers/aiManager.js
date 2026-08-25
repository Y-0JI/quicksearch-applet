// AIManager: the single AI entry point between the UI and the provider layer.
// Resolves the selected provider id against the registry, merges user config
// over registry defaults, and delegates to the generic engine. The UI only
// knows this module — never concrete providers.
//
// Pure CJS module: runs under Cinnamon GJS AND node --test.

// NOTE: no relative require here — Cinnamon's module loader resolves
// './' against the applet root, so the engine is injected by the host
// (applet.js / tests) instead.
function createAIManager(opts) {
    opts = opts || {};
    const getProviderId = opts.getProviderId || function () { return ''; };
    const getConfig = opts.getConfig || function () { return {}; };
    const registry = opts.registry || {};
    const createProviderEngine = opts.createProviderEngine ||
        function () {
            // graceful fallback when the engine was not injected
            return { ask: function (q, ctx, cb) { cb({ error: 'no-engine' }); }, cancel: function () {} };
        };
    // optional transport passthrough so tests can mock at the HTTP level
    const http = opts.http || null;
    let gen = 0;
    let active = null;

    // ask(question, ctx, cb): cb(err, result), normalized like the engine
    function ask(question, ctx, cb) {
        ctx = ctx || {};
        const myGen = ++gen;
        const done = (err, data) => {
            if (myGen !== gen) return; // superseded by cancel()/newer ask
            cb(err, data);
        };

        const id = String(getProviderId() || '').trim();
        const entry = registry[id];
        if (!entry) { done({ error: 'unknown-provider' }); return; }

        const cfg = getConfig() || {};
        const endpoint = String(cfg.endpoint || entry.defaultEndpoint || '');
        if (!endpoint) { done({ error: 'no-endpoint' }); return; }

        if (entry.needsKey && !String(cfg.apiKey || '')) {
            done({ error: 'no-api-key' });
            return;
        }

        active = createProviderEngine({
            endpoint: endpoint,
            apiKey: String(cfg.apiKey || ''),
            model: (cfg.model != null) ? String(cfg.model) : entry.defaultModel,
            maxTokens: (cfg.maxTokens != null) ? Number(cfg.maxTokens) : undefined,
            timeoutMs: Number(cfg.timeoutMs) || undefined,
            http: http || undefined
        });

        active.ask(String(question == null ? '' : question),
                   { cancellable: ctx.cancellable || null,
                     messages: ctx.messages || null },
                   (err, data) => {
                       active = null;
                       done(err, data);
                   });
    }

    // invalidates pending callbacks and aborts the active provider
    function cancel() {
        gen++;
        if (active && active.cancel) {
            try { active.cancel(); } catch (e) {}
        }
        active = null;
    }

    return { ask: ask, cancel: cancel };
}

module.exports = { createAIManager };
