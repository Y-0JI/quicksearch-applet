// ai/aiSearchEngine.js — orchestrator. Owns generation/cancellation, normalizes errors.
// Isolated from searchEngine.js. Only tool: web_search.
// AI-3A: canonical contracts live in groundingTypes.js. Engine's dormant grounding path
// is legacy string-based for AI-0/AI-2 compat; AI-3B MUST migrate to canonical
//   webSearchTool.search({ query, maxResults }, cancellable, cb) -> tool_result
// and canonical grounding_context / grounded answer boundaries. See TODOs below.
const promptBuilderMod = require('./promptBuilder.js');
const sourceFormatterMod = require('./sourceFormatter.js');
let Gt = null;
try { Gt = require('./groundingTypes.js'); } catch (e) {}

const ERROR_MESSAGES = {
    provider_error: 'AI provider unavailable',
    web_search_unavailable: 'Web search unavailable',
    grounding_error: 'Web search unavailable',
    unsupported_tool: 'Unsupported AI tool request',
    invalid_response: 'Invalid AI response',
    timeout: 'AI request timeout',
    auth_error: 'AI authentication failed',
    rate_limited: 'AI rate limited',
    network_error: 'AI network error',
    cancelled: null
};

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

function _makeCancellable(external) {
    if (external && typeof external.is_cancelled === 'function') return external;
    let cancelled = false;
    return {
        is_cancelled() { return cancelled; },
        cancel() { cancelled = true; }
    };
}

function _normalizeProviderError(err) {
    if (!err) return { code: 'provider_error', message: ERROR_MESSAGES.provider_error };
    if (err.code === 'unsupported_tool') return { code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool };
    if (err.code === 'invalid_response') return { code: 'invalid_response', message: ERROR_MESSAGES.invalid_response };
    if (err.code === 'timeout') return { code: 'timeout', message: ERROR_MESSAGES.timeout };
    if (err.code === 'auth_error') return { code: 'auth_error', message: ERROR_MESSAGES.auth_error };
    if (err.code === 'rate_limited') return { code: 'rate_limited', message: ERROR_MESSAGES.rate_limited };
    if (err.code === 'network_error') return { code: 'network_error', message: ERROR_MESSAGES.network_error };
    if (err.code === 'cancelled') return { code: 'cancelled', message: null };
    return { code: 'provider_error', message: ERROR_MESSAGES.provider_error };
}

function _normalizeWebError(err) {
    if (!err) return { code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable };
    // AI-3A keeps legacy web_search_unavailable for backward compat with existing tests/engine callers.
    // AI-3B TODO: when engine migrates to canonical WebSearchTool (tool_error codes), propagate
    // Gt.ERROR_CODES (invalid_query/backend_unavailable/request_failed/cancelled/invalid_response)
    // via fromCallbackError/normalize and map to user messages, instead of always web_search_unavailable.
    return { code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable };
}

function createAISearchEngine(deps) {
    deps = deps || {};
    const provider = deps.provider;
    let webSearchTool = deps.webSearchTool;
    const enableGrounding = !!deps.enableGrounding;
    const promptBuilder = deps.promptBuilder || promptBuilderMod;
    const sourceFormatter = deps.sourceFormatter || sourceFormatterMod;

    if (!provider || typeof provider.request !== 'function') throw new Error('AISearchEngine: provider.request required');
    if (!webSearchTool || typeof webSearchTool.search !== 'function') {
        // AI-2: no grounding yet — stub keeps basic answer path working
        webSearchTool = {
            search: (q, c, cb) => {
                const e = new Error('Web search unavailable');
                e.code = 'web_search_unavailable';
                if (typeof c === 'function' && cb === undefined) return c(e);
                if (typeof cb === 'function') return cb(e);
                if (typeof c === 'function') return c(e);
            }
        };
    }

    let gen = 0;
    let currentCancellable = null;
    let destroyed = false;
    let providerDestroyed = false;

    function _stale(myGen) { return myGen !== gen; }

    function _deliverAnswer(myGen, cancellable, callbacks, text, sources) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        const normalizedSources = sourceFormatter.formatSources(sources || []);
        // Canonical grounded answer shape for AI-3A: { type:'answer', text, grounded, sources }
        // Keep {text, sources} for backward compat with AI-2 callers; add type+grounded for AI-3+.
        const grounded = normalizedSources.length > 0;
        const payload = { type: 'answer', text, grounded, sources: normalizedSources };
        if (typeof callbacks === 'function') return callbacks(null, payload);
        if (callbacks && typeof callbacks.onAnswer === 'function') return callbacks.onAnswer(payload);
        if (callbacks && typeof callbacks.onDone === 'function') return callbacks.onDone(null, payload);
    }

    function _deliverError(myGen, cancellable, callbacks, code, message) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        if (code === 'cancelled') return;
        if (typeof callbacks === 'function') {
            const e = new Error(message || code);
            e.code = code;
            return callbacks(e);
        }
        if (callbacks && typeof callbacks.onError === 'function') return callbacks.onError({ code, message: message || code });
        if (callbacks && typeof callbacks.onDone === 'function') {
            const e = new Error(message || code);
            e.code = code;
            return callbacks.onDone(e);
        }
    }

    function search(query, cancellable, callbacks) {
        if (callbacks === undefined && cancellable != null) {
            if (typeof cancellable === 'function' || (typeof cancellable === 'object' && (cancellable.onAnswer || cancellable.onError || cancellable.onDone))) {
                callbacks = cancellable;
                cancellable = null;
            }
        }
        if (destroyed) return;
        // invalidate previous request
        gen++;
        const myGen = gen;
        // cancel previous cancellable
        if (currentCancellable) {
            try { if (typeof currentCancellable.cancel === 'function') currentCancellable.cancel(); } catch (e) {}
        }
        currentCancellable = _makeCancellable(cancellable);
        const myCancellable = currentCancellable;

        const q = String(query || '').trim();
        if (!q) {
            _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
            return;
        }

        let systemPrompt = '';
        try { systemPrompt = promptBuilder.buildSystemPrompt(); } catch (e) { systemPrompt = ''; }

        // first provider call — pass cancellable if provider supports it (§12)
        // AI-2: basic answer mode does not advertise web_search tool; grounding enabled only when explicitly requested (AI-3)
        try {
            const firstPayload = enableGrounding ? { query: q, systemPrompt, tools: ['web_search'] } : { query: q, systemPrompt };
            provider.request(firstPayload, myCancellable, (err, res) => {
                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                if (err) {
                    const n = _normalizeProviderError(err);
                    if (n.code === 'cancelled') return;
                    return _deliverError(myGen, myCancellable, callbacks, n.code, n.message);
                }
                if (!res || typeof res !== 'object') {
                    return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                }
                if (res.type === 'answer') {
                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                }
                if (res.type === 'tool_call') {
                    if (!enableGrounding) {
                        return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                    }
                    if (res.tool !== 'web_search') {
                        return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                    }
                    const toolQuery = res.arguments && res.arguments.query;
                    if (typeof toolQuery !== 'string' || !toolQuery.trim()) {
                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                    }
                    // web search
                    // AI-3A: legacy string overload for backward compat with AI-0/AI-2 tests.
                    // AI-3B MUST migrate to canonical:
                    //   webSearchTool.search({ query: toolQuery, maxResults: DEFAULT_MAX_RESULTS }, myCancellable, cb)
                    //   and expect cb(null, tool_result) where tool_result = { type:'tool_result', tool:'web_search', query, sources }
                    // Raw Array assumption (Array.isArray(wResults)) is deprecated and will be removed in AI-3B.
                    try {
                        webSearchTool.search(toolQuery, myCancellable, (wErr, wResults) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            if (wErr) {
                                const n2 = _normalizeWebError(wErr);
                                return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message);
                            }
                            // Forward-compat: accept both canonical tool_result and legacy raw Array.
                            // Canonical: { type:'tool_result', tool:'web_search', query, sources }
                            // Legacy: Array<{title,url,snippet}>
                            let sources;
                            let _groundingContextObj = null;
                            if (wResults && typeof wResults === 'object' && !Array.isArray(wResults) && wResults.type === 'tool_result' && Array.isArray(wResults.sources)) {
                                sources = wResults.sources;
                                if (Gt && typeof Gt.createGroundingContext === 'function') {
                                    try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                                }
                            } else {
                                sources = Array.isArray(wResults) ? wResults : [];
                                if (Gt && typeof Gt.createGroundingContext === 'function') {
                                    try { _groundingContextObj = Gt.createGroundingContext(toolQuery, sources); } catch (e) {}
                                }
                            }
                            // Canonical grounding_context object (_groundingContextObj) is the semantic boundary.
                            // Current provider payload translates it to string via promptBuilder for backward compat.
                            // AI-3B: provider adapter should consume grounding_context object before string translation;
                            // do not bypass canonical object with raw backend results.
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            // second provider call with grounding
                            try {
                                provider.request({ query: q, systemPrompt, groundingContext, groundingContextObj: _groundingContextObj, searchResults: sources, tools: [] }, myCancellable, (err2, res2) => {
                                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                    if (err2) {
                                        const n3 = _normalizeProviderError(err2);
                                        if (n3.code === 'cancelled') return;
                                        return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message);
                                    }
                                    if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string') {
                                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                    }
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, sources);
                                });
                            } catch (e) {
                                return _deliverError(myGen, myCancellable, callbacks, 'provider_error', ERROR_MESSAGES.provider_error);
                            }
                        });
                    } catch (e) {
                        return _deliverError(myGen, myCancellable, callbacks, 'grounding_error', ERROR_MESSAGES.grounding_error);
                    }
                    return;
                }
                return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
            });
        } catch (e) {
            const n = _normalizeProviderError(e);
            return _deliverError(myGen, myCancellable, callbacks, n.code, n.message);
        }
    }

    function cancel() {
        gen++;
        if (currentCancellable) {
            try { if (typeof currentCancellable.cancel === 'function') currentCancellable.cancel(); } catch (e) {}
            currentCancellable = null;
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        cancel();
        if (!providerDestroyed && provider && typeof provider.destroy === 'function') {
            providerDestroyed = true;
            try { provider.destroy(); } catch (e) {}
        }
    }

    return { search, cancel, destroy, _gen: () => gen };
}

module.exports = { createAISearchEngine };
