// ai/aiSearchEngine.js — orchestrator. Owns generation/cancellation, normalizes errors.
// Isolated from searchEngine.js. Only tool: web_search.
const promptBuilderMod = require('./promptBuilder.js');
const sourceFormatterMod = require('./sourceFormatter.js');

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
    // webSearchTool sets code web_search_unavailable
    return { code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable };
}

function createAISearchEngine(deps) {
    deps = deps || {};
    const provider = deps.provider;
    const webSearchTool = deps.webSearchTool;
    const promptBuilder = deps.promptBuilder || promptBuilderMod;
    const sourceFormatter = deps.sourceFormatter || sourceFormatterMod;

    if (!provider || typeof provider.request !== 'function') throw new Error('AISearchEngine: provider.request required');
    if (!webSearchTool || typeof webSearchTool.search !== 'function') throw new Error('AISearchEngine: webSearchTool.search required');

    let gen = 0;
    let currentCancellable = null;
    let destroyed = false;

    function _stale(myGen) { return myGen !== gen; }

    function _deliverAnswer(myGen, cancellable, callbacks, text, sources) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        const normalizedSources = sourceFormatter.formatSources(sources || []);
        if (typeof callbacks === 'function') return callbacks(null, { text, sources: normalizedSources });
        if (callbacks && typeof callbacks.onAnswer === 'function') return callbacks.onAnswer({ text, sources: normalizedSources });
        if (callbacks && typeof callbacks.onDone === 'function') return callbacks.onDone(null, { text, sources: normalizedSources });
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
        try {
            provider.request({ query: q, systemPrompt, tools: ['web_search'] }, myCancellable, (err, res) => {
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
                    if (res.tool !== 'web_search') {
                        return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                    }
                    const toolQuery = res.arguments && res.arguments.query;
                    if (typeof toolQuery !== 'string' || !toolQuery.trim()) {
                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                    }
                    // web search
                    try {
                        webSearchTool.search(toolQuery, myCancellable, (wErr, wResults) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            if (wErr) {
                                const n2 = _normalizeWebError(wErr);
                                return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message);
                            }
                            const sources = Array.isArray(wResults) ? wResults : [];
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            // second provider call with grounding
                            try {
                                provider.request({ query: q, systemPrompt, groundingContext, searchResults: sources, tools: [] }, myCancellable, (err2, res2) => {
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
        destroyed = true;
        cancel();
    }

    return { search, cancel, destroy, _gen: () => gen };
}

module.exports = { createAISearchEngine };
