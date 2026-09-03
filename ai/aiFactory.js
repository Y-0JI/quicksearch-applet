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
    // P2-1: AI-2 does not wire WebSearchTool. Pass only if explicitly injected (tests).
    // AISearchEngine stubs it internally when undefined, keeping basic answer path working.
    let webSearchTool = opts.webSearchTool; // undefined -> stub, object -> use

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
                    if (opts.httpFetch) pOpts.httpFetch = opts.httpFetch;
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
    const engineOpts = { provider, promptBuilder: opts.promptBuilder, sourceFormatter: opts.sourceFormatter, enableGrounding };
    // Only forward webSearchTool if caller explicitly provided it (test injection).
    // Otherwise let AISearchEngine stub it — AI-2 has no real grounding.
    if (webSearchTool !== undefined) engineOpts.webSearchTool = webSearchTool;
    return aiSearchEngineMod.createAISearchEngine(engineOpts);
}

function _getRequireDiagnostics() { return JSON.parse(JSON.stringify(_lastRequireDiagnostics || {})); }
function _resetRequireDiagnostics() { _lastRequireDiagnostics = {}; }
module.exports = { createAiEngine, createAiEngineForConfig: createAiEngine, _tryRequireWithDiagnostics, _sanitizeRequireMsg, _getRequireDiagnostics, _resetRequireDiagnostics, _lastRequireDiagnostics: _lastRequireDiagnostics };
