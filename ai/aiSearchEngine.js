// ai/aiSearchEngine.js — orchestrator. Owns generation/cancellation, normalizes errors.
// Isolated from searchEngine.js. Only tool: web_search.
// AI-3A: canonical contracts live in groundingTypes.js.
function _tryReq(p) { try { return require(p); } catch (e) { return null; } }
let promptBuilderMod = _tryReq('./ai/promptBuilder.js') || _tryReq('./promptBuilder.js') || _tryReq('ai/promptBuilder.js');
let sourceFormatterMod = _tryReq('./ai/sourceFormatter.js') || _tryReq('./sourceFormatter.js') || _tryReq('ai/sourceFormatter.js');
let Gt = _tryReq('./ai/groundingTypes.js') || _tryReq('./groundingTypes.js') || _tryReq('ai/groundingTypes.js');
if (!promptBuilderMod) try { global.log("[quicksearch@yoji] aiSearchEngine missing promptBuilder"); } catch (e) {}
if (!sourceFormatterMod) try { global.log("[quicksearch@yoji] aiSearchEngine missing sourceFormatter"); } catch (e) {}

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

function _isLiveQuery(q) {
    const s = String(q || '').toLowerCase();
    const liveKeywords = [
        'jadwal', 'berita', 'harga', 'terbaru', 'hari ini', 'minggu ini', 'besok', 'kemarin',
        'sekarang', 'live', 'skor', 'hasil', 'klasemen', 'cuaca', 'kurs', 'saham', 'bitcoin', 'crypto',
        'update', 'latest', 'today', 'tomorrow', 'schedule', 'price', 'news', 'score', 'weather'
    ];
    for (const kw of liveKeywords) if (s.includes(kw)) return true;
    return false;
}

function _shouldFallbackToSearch(q, answerText) {
    if (!q || !answerText) return false;
    const t = String(answerText || '').toLowerCase();
    if (t.includes('web_search') && t.length < 500) return false;
    return _isLiveQuery(q);
}

function _isCancelled(c) {
    try { return !!(c && typeof c.is_cancelled === 'function' && c.is_cancelled()); } catch (e) { return false; }
}

// P5 runtime trace: log the web_search result the engine received right before it decides whether
// sources are empty (this is where a bare no_results / Stage: unknown error originates).
function _logWebSearchSources(query, sources) {
    try {
        if (typeof global === 'undefined' || typeof global.log !== 'function') return;
        const arr = Array.isArray(sources) ? sources : [];
        const first = (arr[0] && arr[0].url) ? String(arr[0].url).slice(0, 200) : '-';
        global.log('[AI Search] query=' + String(query || '').slice(0, 120) + ' received_sources=' + arr.length + ' first_url=' + first);
    } catch (e) {}
}

// P4 dynamic runtime context: built per request (never persisted into conversation history),
// appended to the system prompt. `grounded` marks the evidence (web search) leg of the request.
function _buildRequestSystemPrompt(promptBuilder, grounded) {
    let base = '';
    try { base = promptBuilder.buildSystemPrompt(); } catch (e) { base = ''; }
    let runtime = '';
    try {
        runtime = (promptBuilder.buildRuntimeContext && typeof promptBuilder.buildRuntimeContext === 'function')
            ? promptBuilder.buildRuntimeContext({ mode: grounded ? 'web' : 'ai', webSearchUsed: !!grounded })
            : '';
    } catch (e) { runtime = ''; }
    let out = base;
    if (runtime) out = (out ? out + '\n\n' : '') + runtime;
    return out;
}

// P9 mode-specific generation strategy. Defaults:
//   ai  (conversational leg, no evidence)  -> leave temperature unset (provider default)
//   web (grounded evidence leg)            -> 0.3 (stable/factual synthesis)
// Overridable via engine deps.generationStrategy { ai?, web? }; clamped to [0,2]; a null value
// disables the override for that mode. Provider adapter is still responsible for compatibility
// (reasoning models that reject temperature), so this only forwards a suggestion.
const DEFAULT_GENERATION_STRATEGY = { ai: null, web: 0.3 };
function _modeTemperature(strategy, grounded) {
    try {
        const s = (strategy && typeof strategy === 'object') ? strategy : DEFAULT_GENERATION_STRATEGY;
        const t = grounded ? s.web : s.ai;
        if (typeof t !== 'number' || !isFinite(t)) return undefined;
        const c = Math.min(2, Math.max(0, t));
        return c;
    } catch (e) { return undefined; }
}

function _makeCancellable(external) {
    if (external && typeof external.is_cancelled === 'function') return external;
    let cancelled = false;
    return {
        is_cancelled() { return cancelled; },
        cancel() { cancelled = true; }
    };
}

function _sanitizeEngineMessage(msg) {
    try {
        let s = String(msg || '');
        s = s.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
        s = s.replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]');
        return s;
    } catch (e) { return String(msg || ''); }
}

function _normalizeProviderError(err) {
    const stage = (err && (err.stage || err._stage)) || null;
    const status = (err && (err.status != null ? err.status : err.httpStatus)) || null;
    const name = (err && err.name) || null;
    function withMeta(obj) {
        if (stage) { obj.stage = stage; obj._stage = stage; }
        if (status != null) { obj.status = status; obj.httpStatus = status; }
        if (name) obj.name = name;
        if (obj.message) {
            try { obj.message = _sanitizeEngineMessage(obj.message); } catch (e2) {}
        }
        return obj;
    }
    if (!err) return withMeta({ code: 'provider_error', message: ERROR_MESSAGES.provider_error });
    if (err.code === 'invalid_query') return withMeta({ code: 'invalid_query', message: err.message ? _sanitizeEngineMessage(err.message) : ERROR_MESSAGES.invalid_query });
    if (err.code === 'unsupported_tool') return withMeta({ code: 'unsupported_tool', message: ERROR_MESSAGES.unsupported_tool });
    if (err.code === 'invalid_response') return withMeta({ code: 'invalid_response', message: ERROR_MESSAGES.invalid_response });
    if (err.code === 'no_results') return withMeta({ code: 'no_results', message: err.message ? _sanitizeEngineMessage(err.message) : ERROR_MESSAGES.no_results });
    if (err.code === 'timeout') return withMeta({ code: 'timeout', message: ERROR_MESSAGES.timeout });
    if (err.code === 'auth_error') return withMeta({ code: 'auth_error', message: ERROR_MESSAGES.auth_error });
    if (err.code === 'rate_limited') return withMeta({ code: 'rate_limited', message: ERROR_MESSAGES.rate_limited });
    if (err.code === 'network_error') return withMeta({ code: 'network_error', message: ERROR_MESSAGES.network_error });
    if (err.code === 'cancelled') return withMeta({ code: 'cancelled', message: null });
    // preserve original message for provider_error and unknown errors (sanitized)
    if (err.code === 'provider_error') {
        const m = err.message ? _sanitizeEngineMessage(err.message) : ERROR_MESSAGES.provider_error;
        return withMeta({ code: 'provider_error', message: m });
    }
    if (err.message) {
        // unknown error with message — keep sanitized original message, map code to provider_error
        return withMeta({ code: err.code || 'provider_error', message: _sanitizeEngineMessage(err.message) });
    }
    return withMeta({ code: 'provider_error', message: ERROR_MESSAGES.provider_error });
}

function _normalizeWebError(err) {
    function _stageOf(e) { try { return e && (e.stage || e._stage) || null; } catch (_) { return null; } }
    function _withStage(obj, e) { const s = _stageOf(e); if (s) { obj.stage = s; obj._stage = s; } if (e && e.status != null) obj.status = e.status; if (e && e.httpStatus != null) obj.httpStatus = e.httpStatus; return obj; }
    if (!err) return { code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable };
    if (err.code === 'cancelled') return _withStage({ code: 'cancelled', message: null }, err);
    if (err.code === 'no_results') return _withStage({ code: 'no_results', message: err.message || ERROR_MESSAGES.no_results }, err);
    if (err.code === 'web_search_unavailable') return _withStage({ code: 'web_search_unavailable', message: err.message || ERROR_MESSAGES.web_search_unavailable }, err);
    if (err.code === 'request_failed') return _withStage({ code: 'web_search_unavailable', message: err.message || ERROR_MESSAGES.web_search_unavailable }, err);
    if (Gt && typeof Gt.fromCallbackError === 'function') {
        try {
            const te = Gt.fromCallbackError(err);
            if (te && te.code) {
                if (te.code === 'cancelled') return _withStage({ code: 'cancelled', message: null }, err);
                if (te.code === 'request_failed') return _withStage({ code: 'web_search_unavailable', message: te.message || ERROR_MESSAGES.web_search_unavailable }, err);
                const msg = te.message || ERROR_MESSAGES[te.code] || ERROR_MESSAGES.web_search_unavailable;
                return _withStage({ code: te.code, message: msg }, err);
            }
        } catch (_) {}
    }
    if (err.code && ERROR_MESSAGES[err.code] !== undefined) {
        return _withStage({ code: err.code, message: err.message || ERROR_MESSAGES[err.code] }, err);
    }
    const known = ['invalid_query', 'backend_unavailable', 'invalid_response'];
    if (err.code && known.includes(err.code)) return _withStage({ code: err.code, message: err.message || ERROR_MESSAGES[err.code] || err.code }, err);
    return _withStage({ code: 'web_search_unavailable', message: ERROR_MESSAGES.web_search_unavailable }, err);
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
                e.stage = 'web_search_init';
                e._stage = 'web_search_init';
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
    const generationStrategy = deps.generationStrategy || null;

    function _stale(myGen) { return myGen !== gen; }

    // P4/P9: build a grounded-leg provider payload: runtime context marks web mode +
    // evidence used, and the web (factual) generation temperature is forwarded as a hint.
    function _groundedPayload(q, groundingContext, groundingContextObj, sources) {
        const p = {
            query: q,
            systemPrompt: _buildRequestSystemPrompt(promptBuilder, true),
            groundingContext,
            groundingContextObj,
            searchResults: sources,
            tools: []
        };
        const t = _modeTemperature(generationStrategy, true);
        if (t !== undefined) p.temperature = t;
        return p;
    }

    function _deliverAnswer(myGen, cancellable, callbacks, text, sources, meta) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        let payload;
        if (Gt && typeof Gt.createGroundedAnswer === 'function') {
            payload = Gt.createGroundedAnswer(text, sources || [], meta || null);
        } else {
            const normalizedSources = sourceFormatter.formatSources(sources || []);
            const grounded = normalizedSources.length > 0;
            payload = { type: 'answer', text, grounded, sources: normalizedSources };
            if (meta && meta.finishReason) payload.finishReason = meta.finishReason;
            payload.truncated = !!(meta && meta.truncated);
        }
        if (typeof callbacks === 'function') return callbacks(null, payload);
        if (callbacks && typeof callbacks.onAnswer === 'function') return callbacks.onAnswer(payload);
        if (callbacks && typeof callbacks.onDone === 'function') return callbacks.onDone(null, payload);
    }

    function _deliverError(myGen, cancellable, callbacks, code, message, extra) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        if (code === 'cancelled') return;
        extra = extra || {};
        if (typeof callbacks === 'function') {
            const e = new Error(message || code);
            e.code = code;
            if (extra.stage) { e.stage = extra.stage; e._stage = extra.stage; }
            if (extra.status != null) { e.status = extra.status; e.httpStatus = extra.status; }
            if (extra.name) e.name = extra.name;
            return callbacks(e);
        }
        if (callbacks && typeof callbacks.onError === 'function') {
            const payload = { code, message: message || code };
            if (extra.stage) { payload.stage = extra.stage; payload._stage = extra.stage; }
            if (extra.status != null) { payload.status = extra.status; payload.httpStatus = extra.status; }
            if (extra.name) payload.name = extra.name;
            return callbacks.onError(payload);
        }
        if (callbacks && typeof callbacks.onDone === 'function') {
            const e = new Error(message || code);
            e.code = code;
            if (extra.stage) { e.stage = extra.stage; e._stage = extra.stage; }
            if (extra.status != null) { e.status = extra.status; e.httpStatus = extra.status; }
            if (extra.name) e.name = extra.name;
            return callbacks.onDone(e);
        }
    }

    function search(query, cancellable, callbacks, opts) {
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

        let systemPrompt = _buildRequestSystemPrompt(promptBuilder, false);

        // Phase 8 §3: bounded conversation history (validated) attached to every provider payload.
        let historyMessages = [];
        try { historyMessages = promptBuilder.buildHistoryMessages(opts && opts.history); } catch (e) { historyMessages = []; }
        function _withHistory(p) {
            if (historyMessages.length > 0) {
                try { p.history = historyMessages; } catch (e) {}
            }
            return p;
        }

        try {
            const firstPayload = enableGrounding ? { query: q, systemPrompt, tools: ['web_search'] } : { query: q, systemPrompt };
            provider.request(_withHistory(firstPayload), myCancellable, (err, res) => {
                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                if (err) {
                    const n = _normalizeProviderError(err);
                    if (n.code === 'cancelled') return;
                    return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                }
                if (!res || typeof res !== 'object') {
                    return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                }
                if (res.type === 'answer') {
                    if (!res.text || !String(res.text).trim()) {
                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                    }
                    try { if (typeof global !== 'undefined' && global.log) global.log("[QuickSearch AI] Received tool call: none, received content: " + String(res.text||'').slice(0,120)); } catch(e){}
                    if (enableGrounding && _isLiveQuery(q)) {
                        try { if (typeof global !== 'undefined' && global.log) global.log("[quicksearch] search_intent live query fallback q=" + q.slice(0,80)); } catch(e){}
                        try {
                            const toolQuery = q;
                            const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number' ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS } : { query: toolQuery, maxResults: 5 };
                            webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                if (wErr) {
                                    const n2 = _normalizeWebError(wErr);
                                    if (n2.code === 'cancelled') return;
                                    return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message, { stage: n2.stage || wErr.stage || wErr._stage || 'web_search_request', status: n2.status || wErr.status });
                                }
                                if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                                }
                                const sources = wResults.sources;
                                _logWebSearchSources((wResults && wResults.query) || q, sources);
                                if (sources.length === 0) {
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                                }
                                let _groundingContextObj = null;
                                if (Gt && typeof Gt.createGroundingContext === 'function') {
                                    try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                                }
                                let groundingContext = '';
                                try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            try {
                                provider.request(_withHistory(_groundedPayload(q, groundingContext, _groundingContextObj, sources)), myCancellable, (err2, res2) => {
                                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                    if (err2) {
                                        const n3 = _normalizeProviderError(err2);
                                        if (n3.code === 'cancelled') return;
                                        return _deliverAnswer(myGen, myCancellable, callbacks, res.text, [], res2 && res2.truncated ? { finishReason: res2.finishReason, truncated: true } : null);
                                    }
                                    if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string' || !String(res2.text).trim()) {
                                        return _deliverAnswer(myGen, myCancellable, callbacks, res.text, [], res2 && res2.truncated ? { finishReason: res2.finishReason, truncated: true } : null);
                                    }
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, sources, res2.truncated || res2.finishReason ? { finishReason: res2.finishReason || null, truncated: !!res2.truncated } : null);
                                });
                                } catch (e) {
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                                }
                            });
                        } catch (e) {
                            return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                        }
                        return;
                    }
                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, []);
                }
                    if (res.type === 'tool_call') {
                    try { if (typeof global !== 'undefined' && global.log) global.log("[QuickSearch AI] Received tool call: " + String(res.tool||'web_search') + " query=" + String(res.arguments&&res.arguments.query||'').slice(0,80)); } catch(e){}
                    if (!enableGrounding) {
                        return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                    }
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
                    } else {
                        if (res.tool !== 'web_search') {
                            return _deliverError(myGen, myCancellable, callbacks, 'unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                        }
                        const tq = res.arguments && res.arguments.query;
                        if (typeof tq !== 'string' || !tq.trim()) {
                            return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                        }
                    }

                    const toolQuery = normalized ? normalized.arguments.query : (res.arguments && res.arguments.query).trim();

                    try {
                        const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number'
                            ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS }
                            : { query: toolQuery, maxResults: 5 };
                        webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            if (wErr) {
                                const n2 = _normalizeWebError(wErr);
                                if (n2.code === 'cancelled') return;
                                return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message, { stage: n2.stage || wErr.stage || wErr._stage || 'web_search_request', status: n2.status || wErr.status });
                            }
                            if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                                return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                            }
                            const sources = wResults.sources;
                            _logWebSearchSources((wResults && wResults.query) || q, sources);
                            if (sources.length === 0) {
                                // P6.4: tool_result valid but empty -> explicit normalize stage, never Stage: unknown
                                return _deliverError(myGen, myCancellable, callbacks, 'no_results', ERROR_MESSAGES.no_results, { stage: 'web_search_normalize' });
                            }
                            let _groundingContextObj = null;
                            if (Gt && typeof Gt.createGroundingContext === 'function') {
                                try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                            }
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                            try {
                                provider.request(_withHistory(_groundedPayload(q, groundingContext, _groundingContextObj, sources)), myCancellable, (err2, res2) => {
                                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                    if (err2) {
                                        const n3 = _normalizeProviderError(err2);
                                        if (n3.code === 'cancelled') return;
                                        return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message, { stage: n3.stage, status: n3.status, name: n3.name });
                                    }
                                    if (res2 && res2.type === 'tool_call') {
                                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                    }
                                    if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string' || !String(res2.text).trim()) {
                                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                    }
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, sources);
                                });
                            } catch (e) {
                                const n = _normalizeProviderError(e);
                                return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
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
            return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
        }
    }

    // Streaming search: real progressive transport, no blocking non-streaming probe for direct answer.
    // Handles tool_call via streaming events (OpenAI streaming tool_calls).
    function searchStream(query, cancellable, callbacks, opts) {
        if (callbacks === undefined && cancellable != null) {
            if (typeof cancellable === 'function' || (typeof cancellable === 'object' && (cancellable.onStart || cancellable.onDelta || cancellable.onComplete || cancellable.onError))) {
                callbacks = cancellable;
                cancellable = null;
            }
        }
        if (destroyed) return;
        if (!provider || typeof provider.streamRequest !== 'function') {
            return search(query, cancellable, {
                onAnswer: callbacks && callbacks.onComplete ? callbacks.onComplete : (callbacks && callbacks.onDone),
                onError: callbacks && callbacks.onError,
                onDone: callbacks && callbacks.onDone
            }, opts);
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

        let systemPrompt = _buildRequestSystemPrompt(promptBuilder, false);

        // Phase 8 §3: bounded conversation history (validated) attached to every provider payload.
        let historyMessages = [];
        try { historyMessages = promptBuilder.buildHistoryMessages(opts && opts.history); } catch (e) { historyMessages = []; }
        function _withHistory(p) {
            if (historyMessages.length > 0) {
                try { p.history = historyMessages; } catch (e) {}
            }
            return p;
        }

        let accumulatedText = '';
        let groundedSources = null;
        let toolCallPending = false;
        let settled = false;

        function _staleS() { return myGen !== gen; }

        function emitComplete(finalText, sources, metaExtra) {
            if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
            settled = true;
            const effectiveText = typeof finalText === 'string' ? finalText : accumulatedText;
            // Source retention: prefer provider sources if they yield >=1 valid after AI-5 canonicalization,
            // else fallback to grounded canonical sources. Never overwrite valid grounded with invalid/empty.
            let effectiveSources = [];
            let providerCanon = [];
            let groundedCanon = [];
            if (Array.isArray(sources) && sources.length > 0) {
                if (Gt && typeof Gt.canonicalizeSources === 'function') {
                    try { providerCanon = Gt.canonicalizeSources(sources); } catch (e) { providerCanon = []; }
                } else {
                    providerCanon = sourceFormatter.formatSources(sources);
                }
            }
            if (Array.isArray(groundedSources) && groundedSources.length > 0) {
                if (Gt && typeof Gt.canonicalizeSources === 'function') {
                    try { groundedCanon = Gt.canonicalizeSources(groundedSources); } catch (e) { groundedCanon = []; }
                } else {
                    groundedCanon = sourceFormatter.formatSources(groundedSources);
                }
            }
            if (providerCanon.length > 0) {
                effectiveSources = providerCanon;
            } else if (groundedCanon.length > 0) {
                effectiveSources = groundedCanon;
            } else {
                effectiveSources = [];
            }
            if (callbacks && typeof callbacks.onComplete === 'function') {
                let payload;
                if (Gt && typeof Gt.createGroundedAnswer === 'function') {
                    payload = Gt.createGroundedAnswer(effectiveText, effectiveSources, metaExtra || null);
                } else {
                    const normalizedSources = sourceFormatter.formatSources(effectiveSources);
                    payload = { type: 'answer', text: effectiveText, grounded: normalizedSources.length > 0, sources: normalizedSources };
                    if (metaExtra && metaExtra.finishReason) payload.finishReason = metaExtra.finishReason;
                    payload.truncated = !!(metaExtra && metaExtra.truncated);
                }
                callbacks.onComplete(payload);
            }
        }

        function emitError(code, message, extra) {
            if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
            settled = true;
            if (code === 'cancelled') return;
            extra = extra || {};
            if (callbacks && typeof callbacks.onError === 'function') {
                const payload = { code, message };
                if (extra.stage) { payload.stage = extra.stage; payload._stage = extra.stage; }
                if (extra.status != null) { payload.status = extra.status; payload.httpStatus = extra.status; }
                if (extra.name) payload.name = extra.name;
                callbacks.onError(payload);
            }
        }

        // Second leg handler (after grounding)
        function handleSecondStreamEvent(evt) {
            if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
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
            if (evt.type === 'tool_call') {
                // Loop guard: second leg must not trigger another grounding round
                emitError('invalid_response', ERROR_MESSAGES.invalid_response);
                return;
            }
            if (evt.type === 'complete') {
                const finalText = (evt.result && typeof evt.result.text === 'string') ? evt.result.text : accumulatedText;
                const sources = (evt.result && Array.isArray(evt.result.sources)) ? evt.result.sources : [];
                const fr = evt.result && typeof evt.result.finishReason === 'string' ? evt.result.finishReason : null;
                const trunc = !!(evt.result && evt.result.truncated) || fr === 'length';
                emitComplete(finalText, sources, fr || trunc ? { finishReason: fr, truncated: trunc } : null);
                return;
            }
            if (evt.type === 'error') {
                const code = (evt.error && evt.error.code) || 'provider_error';
                const message = (evt.error && evt.error.message) || ERROR_MESSAGES[code] || ERROR_MESSAGES.provider_error;
                emitError(code, message, { stage: evt.error && (evt.error.stage || evt.error._stage), status: evt.error && (evt.error.status != null ? evt.error.status : evt.error.httpStatus), name: evt.error && evt.error.name });
                return;
            }
        }

        function handleFirstStreamEvent(evt) {
            if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
            if (!evt || typeof evt !== 'object') return;

            if (evt.type === 'start') {
                if (callbacks && typeof callbacks.onStart === 'function') callbacks.onStart();
                return;
            }

            if (evt.type === 'delta') {
                if (toolCallPending) return;
                const chunk = typeof evt.text === 'string' ? evt.text : '';
                accumulatedText += chunk;
                if (callbacks && typeof callbacks.onDelta === 'function') callbacks.onDelta(chunk, accumulatedText);
                return;
            }

            if (evt.type === 'tool_call') {
                if (toolCallPending) return;
                toolCallPending = true;
                try { if (typeof global !== 'undefined' && global.log) global.log("[QuickSearch AI] Received tool call: " + String(evt.tool||'web_search') + " query=" + String(evt.arguments&&evt.arguments.query||'').slice(0,80)); } catch(e){}
                if (!enableGrounding) {
                    emitError('unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                    return;
                }
                // Normalize tool_call via canonical boundary
                let normalized = null;
                // Build a synthetic res object compatible with Gt.normalizeToolCall
                const synthetic = { type: 'tool_call', tool: evt.tool || 'web_search', arguments: evt.arguments || {} };
                if (Gt && typeof Gt.normalizeToolCall === 'function') {
                    normalized = Gt.normalizeToolCall(synthetic);
                    if (normalized.type === 'unsupported_tool') {
                        emitError('unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                        return;
                    }
                    if (normalized.type === 'tool_error') {
                        emitError(normalized.code || 'invalid_query', normalized.message || ERROR_MESSAGES.invalid_response);
                        return;
                    }
                } else {
                    if (synthetic.tool !== 'web_search') {
                        emitError('unsupported_tool', ERROR_MESSAGES.unsupported_tool);
                        return;
                    }
                    const tq = synthetic.arguments && synthetic.arguments.query;
                    if (typeof tq !== 'string' || !tq.trim()) {
                        emitError('invalid_response', ERROR_MESSAGES.invalid_response);
                        return;
                    }
                    normalized = { type: 'tool_call', tool: 'web_search', arguments: { query: tq.trim() } };
                }
                const toolQuery = normalized.arguments.query;
                try {
                    const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number'
                        ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS }
                        : { query: toolQuery, maxResults: 5 };
                    webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                        if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                        if (wErr) {
                            const n2 = _normalizeWebError(wErr);
                            if (n2.code === 'cancelled') return;
                            emitError(n2.code, n2.message, { stage: n2.stage || wErr.stage || wErr._stage || 'web_search_request', status: n2.status || wErr.status });
                            return;
                        }
                        if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                            emitError('invalid_response', ERROR_MESSAGES.invalid_response);
                            return;
                        }
                        const sources = wResults.sources;
                        _logWebSearchSources((wResults && wResults.query) || toolQuery, sources);
                        if (sources.length === 0) {
                            emitError('no_results', ERROR_MESSAGES.no_results, { stage: 'web_search_normalize' });
                            return;
                        }
                        groundedSources = sources;
                        let _groundingContextObj = null;
                        if (Gt && typeof Gt.createGroundingContext === 'function') {
                            try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, sources); } catch (e) {}
                        }
                        let groundingContext = '';
                        try { groundingContext = promptBuilder.buildGroundingContext(sources); } catch (e) { groundingContext = ''; }
                        // Reset accumulation for grounded answer streaming
                        accumulatedText = '';
                        try {
                            provider.streamRequest(
                                _withHistory(_groundedPayload(q, groundingContext, _groundingContextObj, sources)),
                                myCancellable,
                                handleSecondStreamEvent
                            );
                        } catch (e) {
                            const n = _normalizeProviderError(e);
                            emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                        }
                    });
                } catch (e) {
                    emitError('grounding_error', ERROR_MESSAGES.grounding_error);
                }
                return;
            }

            if (evt.type === 'complete') {
                if (toolCallPending) return;
                const finalText = (evt.result && typeof evt.result.text === 'string') ? evt.result.text : accumulatedText;
                const sources = (evt.result && Array.isArray(evt.result.sources)) ? evt.result.sources : [];
                const fr0 = evt.result && typeof evt.result.finishReason === 'string' ? evt.result.finishReason : null;
                const trunc0 = !!(evt.result && evt.result.truncated) || fr0 === 'length';
                const meta0 = fr0 || trunc0 ? { finishReason: fr0, truncated: trunc0 } : null;
                try { if (typeof global !== 'undefined' && global.log) global.log("[QuickSearch AI] Received tool call: none, received content: " + String(finalText||'').slice(0,120)); } catch(e){}
                if (enableGrounding && _isLiveQuery(q)) {
                    try { if (typeof global !== 'undefined' && global.log) global.log("[quicksearch] search_intent live fallback q=" + q.slice(0,80)); } catch(e){}
                    toolCallPending = true;
                    try {
                        const toolQuery = q;
                        const wsRequest = Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number' ? { query: toolQuery, maxResults: Gt.DEFAULT_MAX_RESULTS } : { query: toolQuery, maxResults: 5 };
                        webSearchTool.search(wsRequest, myCancellable, (wErr, wResults) => {
                            if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                            if (wErr) {
                                emitComplete(finalText, sources, meta0);
                                return;
                            }
                            if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources) || wResults.sources.length === 0) {
                                emitComplete(finalText, sources, meta0);
                                return;
                            }
                            groundedSources = wResults.sources;
                            let _groundingContextObj = null;
                            if (Gt && typeof Gt.createGroundingContext === 'function') {
                                try { _groundingContextObj = Gt.createGroundingContext(wResults.query || toolQuery, wResults.sources); } catch (e) {}
                            }
                            let groundingContext = '';
                            try { groundingContext = promptBuilder.buildGroundingContext(wResults.sources); } catch (e) { groundingContext = ''; }
                            accumulatedText = '';
                            try {
                                provider.streamRequest(
                                    _withHistory(_groundedPayload(q, groundingContext, _groundingContextObj, wResults.sources)),
                                    myCancellable,
                                    handleSecondStreamEvent
                                );
                            } catch (e) {
                                emitComplete(finalText, sources, meta0);
                            }
                        });
                    } catch (e) {
                        emitComplete(finalText, sources, meta0);
                    }
                    return;
                }
                emitComplete(finalText, sources, meta0);
                return;
            }

            if (evt.type === 'error') {
                if (toolCallPending) return;
                const code = (evt.error && evt.error.code) || 'provider_error';
                const message = (evt.error && evt.error.message) || ERROR_MESSAGES[code] || ERROR_MESSAGES.provider_error;
                emitError(code, message, { stage: evt.error && (evt.error.stage || evt.error._stage), status: evt.error && (evt.error.status != null ? evt.error.status : evt.error.httpStatus), name: evt.error && evt.error.name });
                return;
            }
        }

        try {
            const firstPayload = enableGrounding
                ? { query: q, systemPrompt, tools: ['web_search'] }
                : { query: q, systemPrompt };
            provider.streamRequest(_withHistory(firstPayload), myCancellable, handleFirstStreamEvent);
        } catch (e) {
            const n = _normalizeProviderError(e);
            emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
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
