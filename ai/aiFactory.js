// ai/aiFactory.js — AI layer factory. Keeps applet.js free of concrete provider details.
// Boundary: applet -> factory -> AISearchEngine -> AIProvider/NineRouterProvider
// applet only knows: create engine, search, cancel, destroy. No baseUrl/apiKey/model -> provider wiring here.
let aiSearchEngineMod = null;
let aiProviderMod = null;
let nineRouterProviderMod = null;
try { aiSearchEngineMod = require('./aiSearchEngine.js'); } catch (e) {}
try { aiProviderMod = require('./aiProvider.js'); } catch (e) {}
try { nineRouterProviderMod = require('./nineRouterProvider.js'); } catch (e) {}

function _trim(s) { return String(s || '').trim(); }

function _makeAuthErrorProvider() {
    if (aiProviderMod && typeof aiProviderMod.createMockAiProvider === 'function') {
        return aiProviderMod.createMockAiProvider({
            handler: (req, cb) => {
                const e = new Error('AI provider auth error');
                e.code = 'auth_error';
                cb(e);
            }
        });
    }
    return {
        request: (payload, cancellable, cb) => {
            if (typeof cancellable === 'function' && cb === undefined) { cb = cancellable; }
            const e = new Error('AI provider auth error');
            e.code = 'auth_error';
            if (cb) cb(e);
        },
        destroy() {}
    };
}

function _makeProviderErrorProvider() {
    if (aiProviderMod && typeof aiProviderMod.createMockAiProvider === 'function') {
        return aiProviderMod.createMockAiProvider({
            handler: (req, cb) => {
                const e = new Error('AI provider error');
                e.code = 'provider_error';
                cb(e);
            }
        });
    }
    return {
        request: (payload, cancellable, cb) => {
            if (typeof cancellable === 'function' && cb === undefined) { cb = cancellable; }
            const e = new Error('AI provider error');
            e.code = 'provider_error';
            if (cb) cb(e);
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

module.exports = { createAiEngine, createAiEngineForConfig: createAiEngine };
