// ai/aiSearchEngine.js — orchestrator. Owns generation/cancellation, normalizes errors.
// Isolated from searchEngine.js. Only tool: web_search.
// AI-3A: canonical contracts live in groundingTypes.js.
const promptBuilderMod = require('./promptBuilder.js');
const sourceFormatterMod = require('./sourceFormatter.js');
let Gt = null;
try { Gt = require('./groundingTypes.js'); } catch (e) {}

const ERROR_MESSAGES = {
    provider_error: 'AI provider unavailable',
    web_search_unavailable: 'Web search unavailable',
    grounding_error: 'Web search unavailable',
    no_results: 'No search results found',
    unsupported_tool: 'Unsupported AI tool request',
    invalid_query: 'Invalid search query',
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
    if (err.code === 'invalid_query') return { code: 'invalid_query', message: err.message || ERROR_MESSAGES.invalid_query };
    if (err.code === 'unsupported_tool') return { code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool };
    if (err.code === 'invalid_response') return { code: 'invalid_response', message: ERROR_MESSAGES.invalid_response };
    if (err.code === 'no_results') return { code: 'no_results', message: err.message || ERROR_MESSAGES.no_results };
    if (err.code === 'timeout') return { code: 'timeout', message: ERROR_MESSAGES.timeout };
    if (err.code === 'auth_error') return { code: 'auth_error', message: ERROR_MESSAGES.auth_error };
    if (err.code === 'rate_limited') return { code: 'rate_limited', message: ERROR_MESSAGES.rate_limited };
    if (err.code === 'network_error') return { code: 'network_error', message: ERROR_MESSAGES.network_error };
    if (err.code === 'cancelled') return { code: 'cancelled', message: null };
    return { code: 'provider_error', message: ERROR_MESSAGES.provider_error };
}

function _normalizeWebError(err) {
    if (!err) return { code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable };
    if (err.code === 'cancelled') return { code: 'cancelled', message: null };
    if (err.code === 'no_results') return { code: 'no_results', message: err.message || ERROR_MESSAGES.no_results };
    // Preserve legacy code for existing regression (ai-search-engine.test expects web_search_unavailable)
    if (err.code === 'web_search_unavailable') return { code: 'web_search_unavailable', message: err.message || ERROR_MESSAGES.web_search_unavailable };
    if (err.code === 'request_failed') return { code: 'web_search_unavailable', message: err.message || ERROR_MESSAGES.web_search_unavailable };
    if (Gt && typeof Gt.fromCallbackError === 'function') {
        try {
            const te = Gt.fromCallbackError(err);
            if (te && te.code) {
                if (te.code === 'cancelled') return { code: 'cancelled', message: null };
                if (te.code === 'request_failed') return { code: 'web_search_unavailable', message: te.message || ERROR_MESSAGES.web_search_unavailable };
                const msg = te.message || ERROR_MESSAGES[te.code] || ERROR_MESSAGES.web_search_unavailable;
                return { code: te.code, message: msg };
            }
        } catch (_) {}
    }
    if (err.code && ERROR_MESSAGES[err.code] !== undefined) {
        return { code: err.code, message: err.message || ERROR_MESSAGES[err.code] };
    }
    const known = ['invalid_query', 'backend_unavailable', 'invalid_response'];
    if (err.code && known.includes(err.code)) return { code: err.code, message: err.message || ERROR_MESSAGES[err.code] || err.code };
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
        let payload;
        if (Gt && typeof Gt.createGroundedAnswer === 'function') {
            payload = Gt.createGroundedAnswer(text, sources || []);
        } else {
            const normalizedSources = sourceFormatter.formatSources(sources || []);
            const grounded = normalizedSources.length > 0;
            payload = { type: 'answer', text, grounded, sources: normalizedSources };
        }
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
        gen++;
        const myGen = gen;
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
                    // Canonical tool-call boundary. Single source of truth via Gt.normalizeToolCall().
                    let normalized = null;
                    if (Gt && typeof Gt.normalizeToolCall === 'function') {
                        normalized = Gt.normalizeToolCall(res);
                        if (normalized.type === 'unsupported_tool') {
                            return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                        }
                        if (normalized.type === 'tool_error') {
                            const te = normalized;
                            const msg = te.message || ERROR_MESSAGES.invalid_response;
                            const code = te.code || 'invalid_query';
                            return _deliverError(myGen, myCancellable, callbacks, code, msg);
                        }
                        // valid web_search tool_call at this point; extract canonical query
                    } else {
                        // Fallback when Gt unavailable (tests / legacy) — preserve old manual path
                        if (res.tool !== 'web_search') {
                            return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                        }
                        const tq = res.arguments && res.arguments.query;
                        if (typeof tq !== 'string' || !tq.trim()) {
                            return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                        }
                    }

                    const toolQuery = normalized ? normalized.arguments.query : (res.arguments && res.arguments.query).trim();

                    // AI-3A canonical orchestration: object request -> tool_result
                    try {
                        const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number'
                            ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS }
                            : { query: toolQuery, maxResults: 5 };
                        webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            if (wErr) {
                                const n2 = _normalizeWebError(wErr);
                                if (n2.code === 'cancelled') return;
                                return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message);
                            }
                            if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                                return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                            }
                            const sources = wResults.sources;
                            // AI-3B Requirement D — empty canonical sources: fail closed, no Provider #2.
                            if (sources.length === 0) {
                                return _deliverError(myGen, myCancellable, callbacks, 'no_results', ERROR_MESSAGES.no_results);
                            }
                            let _groundingContextObj = null;
                            if (Gt && typeof Gt.createGroundingContext === 'function') {
                                try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                            }
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            try {
                                provider.request({ query: q, systemPrompt, groundingContext, groundingContextObj: _groundingContextObj, searchResults: sources, tools: [] }, myCancellable, (err2, res2) => {
                                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                    if (err2) {
                                        const n3 = _normalizeProviderError(err2);
                                        if (n3.code === 'cancelled') return;
                                        return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message);
                                    }
                                    // AI-3B Requirement C — loop guard: Provider #2 must not trigger second grounding round.
                                    if (res2 && res2.type === 'tool_call') {
                                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
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

    // Streaming search: delivers progressive text via streaming callbacks.
    // callbacks: { onStart, onDelta, onComplete, onError }
    // Supports grounding: first call may return tool_call → web search → second streaming call.
    function searchStream(query, cancellable, callbacks) {
        if (callbacks === undefined && cancellable != null) {
            if (typeof cancellable === 'function' || (typeof cancellable === 'object' && (cancellable.onStart || cancellable.onDelta || cancellable.onComplete || cancellable.onError))) {
                callbacks = cancellable;
                cancellable = null;
            }
        }
        if (destroyed) return;
        if (!provider || typeof provider.streamRequest !== 'function') {
            // Fallback: non-streaming provider → use search() with single completion
            return search(query, cancellable, {
                onAnswer: callbacks && callbacks.onComplete ? callbacks.onComplete : (callbacks && callbacks.onDone),
                onError: callbacks && callbacks.onError,
                onDone: callbacks && callbacks.onDone
            });
        }
        gen++;
        const myGen = gen;
        if (currentCancellable) {
            try { if (typeof currentCancellable.cancel === 'function') currentCancellable.cancel(); } catch (e) {}
        }
        currentCancellable = _makeCancellable(cancellable);
        const myCancellable = currentCancellable;

        const q = String(query || '').trim();
        if (!q) {
            if (callbacks && typeof callbacks.onError === 'function') {
                callbacks.onError({ code: 'invalid_response', message: ERROR_MESSAGES.invalid_response });
            }
            return;
        }

        let systemPrompt = '';
        try { systemPrompt = promptBuilder.buildSystemPrompt(); } catch (e) { systemPrompt = ''; }

        let accumulatedText = '';

        function _stale() { return myGen !== gen; }

        // Streaming event handler for provider streamRequest
        function handleStreamEvent(evt) {
            if (_stale() || _isCancelled(myCancellable) || destroyed) return;
            if (!evt || typeof evt !== 'object') return;

            if (evt.type === 'start') {
                if (callbacks && typeof callbacks.onStart === 'function') callbacks.onStart();
                return;
            }

            if (evt.type === 'delta') {
                const chunk = typeof evt.text === 'string' ? evt.text : '';
                accumulatedText += chunk;
                if (callbacks && typeof callbacks.onDelta === 'function') callbacks.onDelta(chunk, accumulatedText);
                return;
            }

            if (evt.type === 'complete') {
                // Text may arrive via deltas or in the complete result
                const finalText = (evt.result && typeof evt.result.text === 'string') ? evt.result.text : accumulatedText;
                const sources = (evt.result && Array.isArray(evt.result.sources)) ? evt.result.sources : [];
                if (callbacks && typeof callbacks.onComplete === 'function') {
                    // Build AI-5 canonical result
                    let payload;
                    if (Gt && typeof Gt.createGroundedAnswer === 'function') {
                        payload = Gt.createGroundedAnswer(finalText, sources);
                    } else {
                        const normalizedSources = sourceFormatter.formatSources(sources);
                        payload = { type: 'answer', text: finalText, grounded: normalizedSources.length > 0, sources: normalizedSources };
                    }
                    callbacks.onComplete(payload);
                }
                return;
            }

            if (evt.type === 'error') {
                const code = (evt.error && evt.error.code) || 'provider_error';
                const message = (evt.error && evt.error.message) || ERROR_MESSAGES[code] || ERROR_MESSAGES.provider_error;
                if (code === 'cancelled') return;
                if (callbacks && typeof callbacks.onError === 'function') {
                    callbacks.onError({ code, message });
                }
                return;
            }
        }

        // First provider call — check for grounding tool_call
        try {
            const firstPayload = enableGrounding
                ? { query: q, systemPrompt, tools: ['web_search'] }
                : { query: q, systemPrompt };

            // Use non-streaming request first to check for tool_call
            provider.request(firstPayload, myCancellable, (err, res) => {
                if (_stale() || _isCancelled(myCancellable) || destroyed) return;
                if (err) {
                    const n = _normalizeProviderError(err);
                    if (n.code === 'cancelled') return;
                    if (callbacks && typeof callbacks.onError === 'function') {
                        callbacks.onError({ code: n.code, message: n.message });
                    }
                    return;
                }
                if (!res || typeof res !== 'object') {
                    if (callbacks && typeof callbacks.onError === 'function') {
                        callbacks.onError({ code: 'invalid_response', message: ERROR_MESSAGES.invalid_response });
                    }
                    return;
                }

                // Direct answer — stream it
                if (res.type === 'answer') {
                    if (callbacks && typeof callbacks.onStart === 'function') callbacks.onStart();
                    if (callbacks && typeof callbacks.onDelta === 'function') callbacks.onDelta(res.text, res.text);
                    accumulatedText = res.text;
                    if (callbacks && typeof callbacks.onComplete === 'function') {
                        let payload;
                        if (Gt && typeof Gt.createGroundedAnswer === 'function') {
                            payload = Gt.createGroundedAnswer(res.text, []);
                        } else {
                            payload = { type: 'answer', text: res.text, grounded: false, sources: [] };
                        }
                        callbacks.onComplete(payload);
                    }
                    return;
                }

                // Tool call — do grounding, then stream the second call
                if (res.type === 'tool_call') {
                    if (!enableGrounding) {
                        if (callbacks && typeof callbacks.onError === 'function') {
                            callbacks.onError({ code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool });
                        }
                        return;
                    }
                    let normalized = null;
                    if (Gt && typeof Gt.normalizeToolCall === 'function') {
                        normalized = Gt.normalizeToolCall(res);
                        if (normalized.type === 'unsupported_tool') {
                            if (callbacks && typeof callbacks.onError === 'function') {
                                callbacks.onError({ code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool });
                            }
                            return;
                        }
                        if (normalized.type === 'tool_error') {
                            const te = normalized;
                            if (callbacks && typeof callbacks.onError === 'function') {
                                callbacks.onError({ code: te.code || 'invalid_query', message: te.message || ERROR_MESSAGES.invalid_response });
                            }
                            return;
                        }
                    } else {
                        if (res.tool !== 'web_search') {
                            if (callbacks && typeof callbacks.onError === 'function') {
                                callbacks.onError({ code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool });
                            }
                            return;
                        }
                    }
                    const toolQuery = normalized ? normalized.arguments.query : (res.arguments && res.arguments.query && res.arguments.query.trim());
                    try {
                        const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number'
                            ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS }
                            : { query: toolQuery, maxResults: 5 };
                        webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                            if (_stale() || _isCancelled(myCancellable) || destroyed) return;
                            if (wErr) {
                                const n2 = _normalizeWebError(wErr);
                                if (n2.code === 'cancelled') return;
                                if (callbacks && typeof callbacks.onError === 'function') {
                                    callbacks.onError({ code: n2.code, message: n2.message });
                                }
                                return;
                            }
                            if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                                if (callbacks && typeof callbacks.onError === 'function') {
                                    callbacks.onError({ code: 'invalid_response', message: ERROR_MESSAGES.invalid_response });
                                }
                                return;
                            }
                            const sources = wResults.sources;
                            if (sources.length === 0) {
                                if (callbacks && typeof callbacks.onError === 'function') {
                                    callbacks.onError({ code: 'no_results', message: ERROR_MESSAGES.no_results });
                                }
                                return;
                            }
                            let _groundingContextObj = null;
                            if (Gt && typeof Gt.createGroundingContext === 'function') {
                                try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                            }
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            // Second call — streaming this time
                            try {
                                provider.streamRequest(
                                    { query: q, systemPrompt, groundingContext, groundingContextObj: _groundingContextObj, searchResults: sources, tools: [] },
                                    myCancellable,
                                    handleStreamEvent
                                );
                            } catch (e) {
                                if (callbacks && typeof callbacks.onError === 'function') {
                                    callbacks.onError({ code: 'provider_error', message: ERROR_MESSAGES.provider_error });
                                }
                            }
                        });
                    } catch (e) {
                        if (callbacks && typeof callbacks.onError === 'function') {
                            callbacks.onError({ code: 'grounding_error', message: ERROR_MESSAGES.grounding_error });
                        }
                    }
                    return;
                }

                // Unknown response type
                if (callbacks && typeof callbacks.onError === 'function') {
                    callbacks.onError({ code: 'invalid_response', message: ERROR_MESSAGES.invalid_response });
                }
            });
        } catch (e) {
            const n = _normalizeProviderError(e);
            if (callbacks && typeof callbacks.onError === 'function') {
                callbacks.onError({ code: n.code, message: n.message });
            }
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

    return { search, searchStream, cancel, destroy, _gen: () => gen };
}

module.exports = { createAISearchEngine };
