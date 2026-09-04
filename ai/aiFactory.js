// ai/aiFactory.js — AI layer factory. Keeps applet.js free of concrete provider details.
// Boundary: applet -> factory -> AISearchEngine -> AIProvider/NineRouterProvider
// applet only knows: create engine, search, cancel, destroy. No baseUrl/apiKey/model -> provider wiring here.
let aiSearchEngineMod = null;
let aiProviderMod = null;
let nineRouterProviderMod = null;
let _lastRequireDiagnostics = {};
function _sanitizeRequireMsg(s) {
    try {
        let t = String(s || '');
        t = t.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
        t = t.replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]');
        return t.slice(0, 400);
    } catch (e) { return String(s || '').slice(0, 400); }
}
function _tryRequire(paths) {
    const errors = [];
    for (const p of paths) {
        try {
            const m = require(p);
            if (m) return m;
        } catch (e) {
            errors.push({ path: p, name: (e && e.name) || 'Error', message: _sanitizeRequireMsg(e && e.message || String(e)) });
        }
    }
    return null;
}
function _tryRequireWithDiagnostics(key, paths) {
    const errors = [];
    for (const p of paths) {
        try {
            const m = require(p);
            if (m) {
                _lastRequireDiagnostics[key] = errors;
                return { module: m, errors };
            }
        } catch (e) {
            errors.push({ path: p, name: (e && e.name) || 'Error', message: _sanitizeRequireMsg(e && e.message || String(e)) });
        }
    }
    _lastRequireDiagnostics[key] = errors;
    return { module: null, errors };
}
let _r = _tryRequireWithDiagnostics('aiSearchEngine', ['./ai/aiSearchEngine.js', './aiSearchEngine.js', 'ai/aiSearchEngine.js']);
aiSearchEngineMod = _r.module;
if (!aiSearchEngineMod) {
    try {
        const diag = _r.errors.map(e => e.path + ": " + e.name + ": " + e.message).join(" | ");
        global.log("[quicksearch@yoji] aiFactory load aiSearchEngine failed all paths attempted=" + _r.errors.map(e=>e.path).join(",") + " errors=" + diag);
    } catch (e2) {}
}
_r = _tryRequireWithDiagnostics('aiProvider', ['./ai/aiProvider.js', './aiProvider.js', 'ai/aiProvider.js']);
aiProviderMod = _r.module;
if (!aiProviderMod) {
    try {
        const diag = _r.errors.map(e => e.path + ": " + e.name + ": " + e.message).join(" | ");
        global.log("[quicksearch@yoji] aiFactory load aiProvider failed all paths attempted=" + _r.errors.map(e=>e.path).join(",") + " errors=" + diag);
    } catch (e2) {}
}
_r = _tryRequireWithDiagnostics('nineRouter', ['./ai/nineRouterProvider.js', './nineRouterProvider.js', 'ai/nineRouterProvider.js']);
nineRouterProviderMod = _r.module;
if (!nineRouterProviderMod) {
    try {
        const diag = _r.errors.map(e => e.path + ": " + e.name + ": " + e.message).join(" | ");
        global.log("[quicksearch@yoji] aiFactory load nineRouter failed all paths attempted=" + _r.errors.map(e=>e.path).join(",") + " errors=" + diag);
    } catch (e2) {}
}
let webSearchToolMod = null;
_r = _tryRequireWithDiagnostics('webSearchTool', ['./ai/webSearchTool.js', './webSearchTool.js', 'ai/webSearchTool.js']);
webSearchToolMod = _r.module;
if (!webSearchToolMod) {
    try {
        const diag = _r.errors.map(e => e.path + ": " + e.name + ": " + e.message).join(" | ");
        global.log("[quicksearch@yoji] aiFactory load webSearchTool failed all paths attempted=" + _r.errors.map(e=>e.path).join(",") + " errors=" + diag);
    } catch (e2) {}
}
let sourceContentExpanderMod = null;
_r = _tryRequireWithDiagnostics('sourceContentExpander', ['./ai/sourceContentExpander.js', './sourceContentExpander.js', 'ai/sourceContentExpander.js']);
sourceContentExpanderMod = _r.module;
if (!sourceContentExpanderMod) {
    try {
        const diag = _r.errors.map(e => e.path + ": " + e.name + ": " + e.message).join(" | ");
        global.log("[quicksearch@yoji] aiFactory load sourceContentExpander failed all paths attempted=" + _r.errors.map(e=>e.path).join(",") + " errors=" + diag);
    } catch (e2) {}
}

function _trim(s) { return String(s || '').trim(); }

function _makeAuthErrorProvider() {
    function _attach(e) { e.stage = 'provider_create'; e._stage = 'provider_create'; return e; }
    if (aiProviderMod && typeof aiProviderMod.createMockAiProvider === 'function') {
        return aiProviderMod.createMockAiProvider({
            handler: (req, cb) => {
                const e = new Error('AI provider auth error');
                e.code = 'auth_error';
                _attach(e);
                cb(e);
            }
        });
    }
    return {
        request: (payload, cancellable, cb) => {
            if (typeof cancellable === 'function' && cb === undefined) { cb = cancellable; }
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            _attach(e);
            if (cb) cb(e);
        },
        streamRequest(payload, cancellable, onEvent) {
            if (typeof cancellable === 'function' && onEvent === undefined) { onEvent = cancellable; }
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            _attach(e);
            if (onEvent) onEvent({ type: 'error', error: { code: 'auth_error', message: e.message, stage: 'provider_create' } });
        },
        destroy() {}
    };
}

function _makeProviderErrorProvider() {
    function _attach(e) { e.stage = 'provider_create'; e._stage = 'provider_create'; return e; }
    if (aiProviderMod && typeof aiProviderMod.createMockAiProvider === 'function') {
        return aiProviderMod.createMockAiProvider({
            handler: (req, cb) => {
                const e = new Error('AI provider error');
                e.code = 'provider_error';
                _attach(e);
                cb(e);
            }
        });
    }
    return {
        request: (payload, cancellable, cb) => {
            if (typeof cancellable === 'function' && cb === undefined) { cb = cancellable; }
            const e = new Error('AI provider error');
            e.code = 'provider_error';
            _attach(e);
            if (cb) cb(e);
        },
        streamRequest(payload, cancellable, onEvent) {
            if (typeof cancellable === 'function' && onEvent === undefined) { onEvent = cancellable; }
            const e = new Error('AI provider error');
            e.code = 'provider_error';
            _attach(e);
            if (onEvent) onEvent({ type: 'error', error: { code: 'provider_error', message: e.message, stage: 'provider_create' } });
        },
        destroy() {}
    };
}

function createAiEngine(opts) {
    opts = opts || {};
    let provider = opts.provider || null;
    let webSearchTool = opts.webSearchTool;
    let webSearchToolInitError = null;

    if (!provider) {
        const baseUrl = _trim(opts.baseUrl);
        const apiKey = _trim(opts.apiKey);
        const model = _trim(opts.model);
        const timeoutMs = opts.timeoutMs;
        if (!baseUrl || !apiKey || !model) {
            provider = _makeAuthErrorProvider();
        } else {
            try {
                if (nineRouterProviderMod && typeof nineRouterProviderMod.createNineRouterProvider === 'function') {
                    const pOpts = { baseUrl, apiKey, model };
                    if (typeof timeoutMs === 'number') pOpts.timeoutMs = timeoutMs;
                    if (opts.maxOutputTokens != null || opts.maxTokens != null) pOpts.maxOutputTokens = opts.maxOutputTokens != null ? opts.maxOutputTokens : opts.maxTokens;
                    if (opts.httpFetch) { pOpts.httpFetch = opts.httpFetch; pOpts.httpStreamFetch = opts.httpFetch; }
                    if (opts.httpStreamFetch) pOpts.httpStreamFetch = opts.httpStreamFetch;
                    provider = nineRouterProviderMod.createNineRouterProvider(pOpts);
                } else {
                    provider = _makeProviderErrorProvider();
                }
            } catch (e) {
                provider = _makeProviderErrorProvider();
            }
        }
    }

    if (!aiSearchEngineMod || typeof aiSearchEngineMod.createAISearchEngine !== 'function') {
        throw new Error('aiFactory: AISearchEngine unavailable');
    }
    const enableGrounding = !!opts.enableGrounding;
    if (webSearchTool === undefined && enableGrounding) {
        if (webSearchToolMod) {
            try {
                const cfg = {
                    engine: opts.searchEngine || opts.webSearchEngine || 'ddgo',
                    searxngUrl: opts.searxngUrl || opts.searxng_url || 'http://127.0.0.1:8080',
                    googleApiKey: opts.googleApiKey || opts.webSearchApiKey || opts.web_search_api_key || '',
                    webSearchApiKey: opts.webSearchApiKey || opts.web_search_api_key || '',
                    httpGet: opts.httpGet,
                    httpPost: opts.httpPost
                };
                if (typeof webSearchToolMod.createProductionWebSearchTool === 'function') {
                    webSearchTool = webSearchToolMod.createProductionWebSearchTool(cfg);
                    try { global.log("[quicksearch@yoji] webSearchTool wired engine=" + cfg.engine + " searxngUrl=" + cfg.searxngUrl.slice(0, 40)); } catch (e) {}
                } else if (typeof webSearchToolMod.createWebSearchTool === 'function') {
                    webSearchTool = webSearchToolMod.createWebSearchTool(cfg);
                } else if (typeof webSearchToolMod.createMockWebSearchTool === 'function') {
                    webSearchTool = webSearchToolMod.createMockWebSearchTool();
                } else {
                    webSearchToolInitError = 'WebSearchTool module has no factory';
                }
            } catch (e) {
                webSearchToolInitError = _sanitizeRequireMsg(e && e.message || String(e));
                try { global.log("[quicksearch@yoji] webSearchTool init failed: " + webSearchToolInitError); } catch (e2) {}
            }
        } else {
            webSearchToolInitError = 'WebSearchTool module unavailable';
            try { global.log("[quicksearch@yoji] webSearchTool module unavailable for grounding"); } catch (e2) {}
        }
        if (!webSearchTool && enableGrounding) {
            const msg = webSearchToolInitError || 'WebSearchTool unavailable';
            webSearchTool = {
                search: (req, canc, cb) => {
                    if (typeof canc === 'function' && !cb) { cb = canc; canc = null; }
                    const e = new Error(msg);
                    e.code = 'web_search_unavailable';
                    e.stage = 'web_search_init';
                    e._stage = 'web_search_init';
                    if (cb) cb(e);
                },
                __initError: msg,
                __stage: 'web_search_init'
            };
        }
    }
    // Source content expansion (full page evidence): wired only when explicitly requested
    // (opts.sourceExpansion === true) or an expander is injected — never by default, so
    // existing factory consumers and unit tests keep the classic snippet grounding path.
    let sourceContentExpander = opts.sourceContentExpander || null;
    if (!sourceContentExpander && opts.sourceExpansion === true && sourceContentExpanderMod && typeof sourceContentExpanderMod.createSourceContentExpander === 'function') {
        try {
            const eOpts = {};
            if (typeof opts.httpGet === 'function') eOpts.httpGet = opts.httpGet;
            if (typeof opts.expansionTimeoutMs === 'number') eOpts.timeoutMs = opts.expansionTimeoutMs;
            sourceContentExpander = sourceContentExpanderMod.createSourceContentExpander(eOpts);
            try { global.log("[quicksearch@yoji] sourceContentExpander wired (full page content evidence)"); } catch (e2) {}
        } catch (e) {
            sourceContentExpander = null;
            try { global.log("[quicksearch@yoji] sourceContentExpander init failed: " + _sanitizeRequireMsg(e && e.message || String(e))); } catch (e2) {}
        }
    }
    const engineOpts = { provider, promptBuilder: opts.promptBuilder, sourceFormatter: opts.sourceFormatter, enableGrounding };
    if (opts.generationStrategy && typeof opts.generationStrategy === 'object') engineOpts.generationStrategy = opts.generationStrategy;
    if (sourceContentExpander) engineOpts.sourceContentExpander = sourceContentExpander;
    if (webSearchTool !== undefined) engineOpts.webSearchTool = webSearchTool;
    if (opts.debug || opts.debugMode) engineOpts.debug = true; // AI Debug Mode (source expansion diagnostics)
    const engine = aiSearchEngineMod.createAISearchEngine(engineOpts);
    if (webSearchToolInitError && enableGrounding) {
        try { engine.__webSearchInitError = webSearchToolInitError; } catch (e) {}
    }
    return engine;
}

function _getRequireDiagnostics() { return JSON.parse(JSON.stringify(_lastRequireDiagnostics || {})); }
function _resetRequireDiagnostics() { _lastRequireDiagnostics = {}; }
module.exports = { createAiEngine, createAiEngineForConfig: createAiEngine, _tryRequireWithDiagnostics, _sanitizeRequireMsg, _getRequireDiagnostics, _resetRequireDiagnostics, _lastRequireDiagnostics: _lastRequireDiagnostics };
