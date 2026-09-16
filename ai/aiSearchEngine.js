// ai/aiSearchEngine.js — orchestrator. Owns generation/cancellation, normalizes errors.
// Isolated from searchEngine.js. Only tool: web_search.
// AI-3A: canonical contracts live in groundingTypes.js.
function _tryReq(p) { try { return require(p); } catch (e) { return null; } }
let promptBuilderMod = _tryReq('./ai/promptBuilder.js') || _tryReq('./promptBuilder.js') || _tryReq('ai/promptBuilder.js');
let sourceFormatterMod = _tryReq('./ai/sourceFormatter.js') || _tryReq('./sourceFormatter.js') || _tryReq('ai/sourceFormatter.js');
let citationCleanerMod = _tryReq('./ai/citationCleaner.js') || _tryReq('./citationCleaner.js') || _tryReq('ai/citationCleaner.js');
let Gt = _tryReq('./ai/groundingTypes.js') || _tryReq('./groundingTypes.js') || _tryReq('ai/groundingTypes.js');
let responseIntentMod = _tryReq('./ai/responseIntent.js') || _tryReq('./responseIntent.js') || _tryReq('ai/responseIntent.js');
let liveDataMod = _tryReq('./ai/liveDataFallback.js') || _tryReq('./liveDataFallback.js') || _tryReq('ai/liveDataFallback.js');
if (!promptBuilderMod) try { global.log("[quicksearch@yoji] aiSearchEngine missing promptBuilder"); } catch (e) {}
if (!sourceFormatterMod) try { global.log("[quicksearch@yoji] aiSearchEngine missing sourceFormatter"); } catch (e) {}

const ERROR_MESSAGES = {
    provider_error: 'AI provider unavailable',
    upstream_unavailable: 'Web search is temporarily unavailable because the search backend has no healthy upstream sources.',
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

// P2 (AI Pipeline V3): ai/responseIntent.js is the SINGLE source of truth for live/current
// intent. The engine keeps NO duplicate keyword/regex list — the only signal is the intent
// classifier's flags.live (same signal used to pick the current-response guidance).
function _detectIntent(q) {
    if (responseIntentMod && typeof responseIntentMod.detectResponseIntent === 'function') {
        try { return responseIntentMod.detectResponseIntent(String(q || '')); } catch (e) { return null; }
    }
    return null;
}
function _isLiveIntent(q) {
    const intent = _detectIntent(q);
    return !!(intent && intent.flags && intent.flags.live === true);
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
// P1 citation cleanup: strip bracketed citation markers ("[1]", "[1][2]") from the visible
// text of GROUNDED answers only. Source metadata is separate and untouched. Ungrounded
// answers (no numbered evidence) are never altered.
function _cleanAnswerText(text) {
    if (!citationCleanerMod || typeof citationCleanerMod.cleanAnswerCitations !== 'function') return text;
    try { return citationCleanerMod.cleanAnswerCitations(text); } catch (e) { return text; }
}

// P1/P2/P3: build the request system prompt = CORE + the guidance matching the detected
// intent of `query` (+ completeness when requested) + concise grounded-evidence rules on the
// evidence leg. Only the relevant intent guidance is appended — no full rulebook per request.
function _buildRequestSystemPrompt(promptBuilder, grounded, query) {
    let intent = _detectIntent(query);
    let base = '';
    try {
        base = promptBuilder.buildSystemPrompt({ intent: intent || undefined, grounded: !!grounded });
    } catch (e) { base = ''; }
    if (!base) {
        try { base = promptBuilder.buildSystemPrompt(); } catch (e2) { base = ''; }
    }
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
    if (err.code === 'timeout') {
        // A stalled stream carries a more specific message than the generic timeout line —
        // keep it so the user can tell "provider stopped mid-answer" from "request never
        // got a response". Fall back to the canned message only when the provider sent none.
        const m = err.message ? _sanitizeEngineMessage(err.message) : '';
        const stalled = /stalled|no data for/i.test(m) ? m : ERROR_MESSAGES.timeout;
        return withMeta({ code: 'timeout', message: stalled });
    }
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
    if (err.code === 'upstream_unavailable') return _withStage({ code: 'upstream_unavailable', message: err.message || ERROR_MESSAGES.upstream_unavailable }, err);
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
    const sourceContentExpander = deps.sourceContentExpander || null;
    const debugMode = !!deps.debug;

    // P14/P2-1: expansion diagnostics (no secrets) — summary + per-source details. Only logged
    // when AI Debug Mode is on; never shown to normal users.
    function _logExpansionStats(stats) {
        try {
            if (!debugMode || typeof global === 'undefined' || typeof global.log !== 'function' || !stats) return;
            global.log('[AI Search] source expansion: results=' + stats.total + ' selected=' + stats.selected +
                ' page_content=' + stats.pageContent + ' snippet_fallback=' + stats.snippetFallback +
                ' fetch_failed=' + stats.fetchFailed + ' full_intent=' + (!!stats.fullContentIntent) +
                ' chars=' + stats.totalChars + '/' + stats.budgetChars + ' budget=' + stats.budgetPercent + '%');
        } catch (e) {}
    }
    function _logSourceDiagnostics(evidence) {
        try {
            if (!debugMode || typeof global === 'undefined' || typeof global.log !== 'function' || !Array.isArray(evidence)) return;
            for (const ev of evidence) {
                if (!ev || typeof ev !== 'object') continue;
                global.log('[AI Search] Source Expansion: url=' + String(ev.url || '').slice(0, 200) +
                    ' fetch=' + String(ev.fetchStatus || '?') +
                    ' http=' + (ev.httpStatus != null ? String(ev.httpStatus) : '-') +
                    ' raw_html=' + (ev.rawHtmlChars != null ? String(ev.rawHtmlChars) : '-') +
                    ' extracted=' + (ev.extractedChars != null ? String(ev.extractedChars) : '-') +
                    ' final=' + String(ev.charCount != null ? ev.charCount : (ev.content ? ev.content.length : 0)) +
                    ' type=' + String(ev.evidenceType || '?'));
            }
        } catch (e) {}
    }

    // Grounded second leg: when a sourceContentExpander is wired, fetch full page content for the
    // selected sources and build the expanded grounding context; ANY failure falls back to the
    // classic snippet context so a fetch problem never blocks the answer. cb is invoked only while
    // the request is still current (stale/cancel/destroy guards) — otherwise the result is dropped.
    function _prepareGroundingContext(myGen, cancellable, q, sources, expandQuery, cb) {
        const ctxQuery = expandQuery || q; // query the evidence belongs to (tool query when re-queried)
        function _fallback() {
            if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
            let obj = null;
            if (Gt && typeof Gt.createGroundingContext === 'function') {
                try { obj = Gt.createGroundingContext(ctxQuery, sources); } catch (e) { obj = null; }
            }
            let ctx = '';
            try { ctx = promptBuilder.buildGroundingContext(sources); } catch (e) { ctx = ''; }
            cb({ groundingContext: ctx, groundingContextObj: obj });
        }
        if (!sourceContentExpander || typeof sourceContentExpander.expand !== 'function' || !Array.isArray(sources) || sources.length === 0) {
            _fallback();
            return;
        }
        try {
            sourceContentExpander.expand({ query: expandQuery || q, sources: sources, cancellable: cancellable }, (err, res) => {
                if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
                if (err || !res || !Array.isArray(res.evidence) || res.evidence.length === 0) return _fallback();
                try { _logExpansionStats(res.stats); } catch (e) {}
                try { _logSourceDiagnostics(res.evidence); } catch (e) {}
                let ctx = '';
                try {
                    ctx = (promptBuilder.buildExpandedGroundingContext && typeof promptBuilder.buildExpandedGroundingContext === 'function')
                        ? promptBuilder.buildExpandedGroundingContext(res.evidence, q)
                        : '';
                } catch (e) { ctx = ''; }
                if (!ctx) return _fallback();
                let obj = null;
                if (Gt && typeof Gt.createGroundingContext === 'function') {
                    try { obj = Gt.createGroundingContext(ctxQuery, sources); } catch (e) { obj = null; }
                }
                cb({ groundingContext: ctx, groundingContextObj: obj });
            });
        } catch (e) {
            _fallback();
        }
    }

    function _stale(myGen) { return myGen !== gen; }

    // P4/P9: build a grounded-leg provider payload: runtime context marks web mode +
    // evidence used, and the web (factual) generation temperature is forwarded as a hint.
    function _groundedPayload(q, groundingContext, groundingContextObj, sources) {
        const p = {
            query: q,
            systemPrompt: _buildRequestSystemPrompt(promptBuilder, true, q),
            groundingContext,
            groundingContextObj,
            searchResults: sources,
            tools: []
        };
        const t = _modeTemperature(generationStrategy, true);
        if (t !== undefined) p.temperature = t;
        return p;
    }

    // Payload for the knowledge fallback: a plain, tool-less, ungrounded generation —
    // identical shape to the conversational direct-answer path. Used only when web
    // search cannot provide sources (availability outage / empty results) and the
    // question does not require live data.
    function _knowledgeRetryPayload(q, fallbackQuery) {
        const p = {
            query: q,
            systemPrompt: _buildRequestSystemPrompt(promptBuilder, false, fallbackQuery || q),
            tools: []
        };
        const t = _modeTemperature(generationStrategy, false);
        if (t !== undefined) p.temperature = t;
        return p;
    }

    // Keyless direct-API grounding for structured live data (weather/stocks/news).
    // Used when the general web search backend is down (upstream outage / zero results):
    // instead of failing a live-data question, ground it from its canonical free API.
    let _liveData = null;

    // H multi-aspect fan-out (single-round, read-only, max 2, fail-closed).
    // Tries Gt.decomposeMultiAspect on the query; null → single existing search.
    // Two aspect searches run concurrently via the SAME webSearchTool contract;
    // results merged (canonicalize+dedupe), aspect-tagged at snippet-text level only.
    // Rollback: deps.fanOut === false forces the legacy single-search path.
    const fanOutEnabled = deps.fanOut !== false;
    function _fanoutWebSearch(wsRequest, cancellable, cb) {
        const q = wsRequest && typeof wsRequest.query === 'string' ? wsRequest.query : '';
        const maxResults = wsRequest && wsRequest.maxResults;
        let plan = null;
        try {
            if (fanOutEnabled && Gt && typeof Gt.decomposeMultiAspect === 'function') {
                plan = Gt.decomposeMultiAspect(q);
            }
        } catch (e) { plan = null; }
        if (!plan || !Array.isArray(plan.queries) || plan.queries.length !== 2) {
            try { webSearchTool.search(wsRequest, cancellable, cb); } catch (e) {
                if (typeof cb === 'function') cb(e);
            }
            return;
        }
        const aspects = Array.isArray(plan.aspects) ? plan.aspects : [];
        const collected = [[], []];
        const errors = [null, null];
        let done = 0;
        let settled = false;
        function finish() {
            if (settled) return;
            settled = true;
            const okIdx = [0, 1].filter(i => !errors[i] && Array.isArray(collected[i]));
            if (okIdx.length === 0) {
                const firstErr = errors[0] || errors[1] || new Error('Web search unavailable');
                return cb(firstErr);
            }
            let merged = [];
            okIdx.forEach(i => {
                const tag = aspects[i] ? '[aspek: ' + String(aspects[i]).slice(0, 40) + '] ' : '';
                for (const s of collected[i]) {
                    if (!s || typeof s !== 'object') continue;
                    const copy = Object.assign({}, s);
                    if (tag && typeof copy.snippet === 'string' && copy.snippet) copy.snippet = tag + copy.snippet;
                    else if (tag && typeof copy.content === 'string' && copy.content) copy.content = tag + copy.content;
                    merged.push(copy);
                }
            });
            try {
                if (Gt && typeof Gt.canonicalizeSources === 'function') merged = Gt.canonicalizeSources(merged);
            } catch (e) {}
            cb(null, { type: 'tool_result', tool: 'web_search', query: q, sources: merged });
        }
        plan.queries.forEach((subQ, i) => {
            let req = wsRequest;
            try {
                if (Gt && typeof Gt.validateRequest === 'function') {
                    const v = Gt.validateRequest({ query: subQ, maxResults: maxResults });
                    if (!v || v.error) throw (v && v.error) || new Error('invalid_query');
                    req = { query: v.query, maxResults: v.maxResults };
                } else {
                    req = Object.assign({}, wsRequest, { query: subQ });
                }
            } catch (e) {
                errors[i] = e;
                collected[i] = null;
                done++;
                if (done === 2) finish();
                return;
            }
            try {
                webSearchTool.search(req, cancellable, (wErr, wResults) => {
                    if (settled) return;
                    if (_isCancelled(cancellable) || destroyed) return;
                    if (wErr) { errors[i] = wErr; collected[i] = null; }
                    else if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                        const e = new Error('Invalid AI response');
                        e.code = 'invalid_response';
                        errors[i] = e;
                        collected[i] = null;
                    } else {
                        collected[i] = wResults.sources;
                    }
                    done++;
                    if (done === 2) finish();
                });
            } catch (e) {
                if (settled) return;
                errors[i] = e;
                collected[i] = null;
                done++;
                if (done === 2) finish();
            }
        });
    }

    function _liveDataFallbackSources(query, cancellable) {
        // null (sync) = unavailable -> caller falls through synchronously; a Promise = async fetch
        if (deps.liveDataFallback === false) return null;
        if (!_liveData) {
            if (!liveDataMod || typeof liveDataMod.createLiveDataFallback !== 'function') return null;
            try { _liveData = liveDataMod.createLiveDataFallback({ httpGet: deps.liveDataHttpGet || null }); } catch (e) { return null; }
        }
        return _liveData.fetch(query, cancellable)
            .then((r) => {
                const sources = (r && Array.isArray(r.sources) && r.sources.length) ? r.sources : null;
                try { if (typeof global !== 'undefined' && global.log) global.log('[AI Search] live-data fallback: domain=' + (r && r.domain) + ' sources=' + (sources ? sources.length : 'none')); } catch (e) {}
                return sources;
            })
            .catch(() => null);
    }

    function _deliverAnswer(myGen, cancellable, callbacks, text, sources, meta) {
        if (_stale(myGen) || _isCancelled(cancellable) || destroyed) return;
        // sources is the numbered evidence of the grounded leg -> its text may carry [n] markers
        const finalText = (Array.isArray(sources) && sources.length > 0) ? _cleanAnswerText(text) : text;
        let payload;
        if (Gt && typeof Gt.createGroundedAnswer === 'function') {
            payload = Gt.createGroundedAnswer(finalText, sources || [], meta || null);
        } else {
            const normalizedSources = sourceFormatter.formatSources(sources || []);
            const grounded = normalizedSources.length > 0;
            payload = { type: 'answer', text: finalText, grounded, sources: normalizedSources };
            if (meta && meta.finishReason) payload.finishReason = meta.finishReason;
            payload.truncated = !!(meta && meta.truncated);
        }
        if (typeof callbacks === 'function') return callbacks(null, payload);
        if (callbacks && typeof callbacks.onAnswer === 'function') return callbacks.onAnswer(payload);
        if (callbacks && typeof callbacks.onDone === 'function') return callbacks.onDone(null, payload);
    }

    // Normalize a provider answer's completion metadata (finishReason + truncated) into the
    // engine meta shape, or null when absent. Guarantees finish_reason='length' surfaces as
    // truncated end-to-end even on non-streaming answers and fallback paths.
    function _metaOf(r) {
        if (!r || typeof r !== 'object') return null;
        const fr = typeof r.finishReason === 'string' ? r.finishReason : null;
        const trunc = !!(r.truncated) || fr === 'length';
        return (fr || trunc) ? { finishReason: fr || null, truncated: !!trunc } : null;
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
        let systemPrompt = _buildRequestSystemPrompt(promptBuilder, false, q);

        // Phase 8 §3: bounded conversation history (validated) attached to every provider payload.
        let historyMessages = [];
        try { historyMessages = promptBuilder.buildHistoryMessages(opts && opts.history); } catch (e) { historyMessages = []; }
        function _withHistory(p) {
            if (historyMessages.length > 0) {
                try { p.history = historyMessages; } catch (e) {}
            }
            return p;
        }

        // P3 (AI Pipeline V3): for live/current queries, web search FIRST then ONE grounded AI
        // generation — no hidden AI draft is ever generated on the successful path. Web/grounded
        // failures follow the existing error policy (same as the tool_call grounded leg), they
        // never re-run an ungrounded draft + search + second-generation cycle.
        if (enableGrounding && _isLiveIntent(q)) {
            try {
                const wsRequest = (Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number')
                    ? { query: q, maxResults: Gt.DEFAULT_MAX_RESULTS }
                    : { query: q, maxResults: 5 };
                _fanoutWebSearch(wsRequest, myCancellable, (wErr, wResults) => {
                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                    const outage = wErr ? _normalizeWebError(wErr) : null;
                    const emptyResults = !wErr && !!wResults && wResults.type === 'tool_result' && Array.isArray(wResults.sources) && wResults.sources.length === 0;
                    if (outage && outage.code === 'cancelled') return;
                    if (outage || emptyResults) {
                        // structured live data (weather/stocks/news)? ground from its keyless direct API
                        const altP1 = _liveDataFallbackSources(q, myCancellable);
                        if (altP1) { altP1.then((altSources) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            if (altSources) {
                                try { if (typeof global !== 'undefined' && global.log) global.log('[QuickSearch AI] web search unavailable -> live-data direct API grounding (structured query)'); } catch (e) {}
                                _prepareGroundingContext(myGen, myCancellable, q, altSources, q, (ctxInfo) => {
                                    if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                    try {
                                        provider.request(_withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, altSources)), myCancellable, (err2, res2) => {
                                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                            if (err2) {
                                                const n3 = _normalizeProviderError(err2);
                                                if (n3.code === 'cancelled') return;
                                                return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message, { stage: n3.stage, status: n3.status, name: n3.name });
                                            }
                                            if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string' || !String(res2.text).trim()) {
                                                return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                            }
                                            return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, altSources, _metaOf(res2));
                                        });
                                    } catch (e) {
                                        const n = _normalizeProviderError(e);
                                        return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                    }
                                });
                                return;
                            }
                            return _deliverError(myGen, myCancellable, callbacks,
                                outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                (outage && outage.message) || ERROR_MESSAGES.no_results,
                                outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                        });
                        } else {
                            return _deliverError(myGen, myCancellable, callbacks,
                                outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                (outage && outage.message) || ERROR_MESSAGES.no_results,
                                outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                        }
                        return;
                    }
                    if (wErr) {
                        const n2 = outage || _normalizeWebError(wErr);
                        if (n2.code === 'cancelled') return;
                        return _deliverError(myGen, myCancellable, callbacks, n2.code, n2.message, { stage: n2.stage || wErr.stage || wErr._stage || 'web_search_request', status: n2.status || wErr.status });
                    }
                    if (!wResults || wResults.type !== 'tool_result' || !Array.isArray(wResults.sources)) {
                        return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                    }
                    const sources = wResults.sources;
                    _logWebSearchSources((wResults && wResults.query) || q, sources);
                    if (sources.length === 0) {
                        return _deliverError(myGen, myCancellable, callbacks, 'no_results', ERROR_MESSAGES.no_results, { stage: 'web_search_normalize' });
                    }
                    _prepareGroundingContext(myGen, myCancellable, q, sources, q, (ctxInfo) => {
                        if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                        try {
                            provider.request(_withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, sources)), myCancellable, (err2, res2) => {
                                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                if (err2) {
                                    const n3 = _normalizeProviderError(err2);
                                    if (n3.code === 'cancelled') return;
                                    return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message, { stage: n3.stage, status: n3.status, name: n3.name });
                                }
                                if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string' || !String(res2.text).trim()) {
                                    return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                }
                                return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, sources, _metaOf(res2), q);
                            });
                        } catch (e) {
                            const n = _normalizeProviderError(e);
                            return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                        }
                    });
                });
            } catch (e) {
                return _deliverError(myGen, myCancellable, callbacks, 'grounding_error', ERROR_MESSAGES.grounding_error);
            }
            return;
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
                    return _deliverAnswer(myGen, myCancellable, callbacks, res.text, [], _metaOf(res));
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
                        _fanoutWebSearch(wsRequest, myCancellable, (wErr, wResults) => {
                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                            // Availability outage (no healthy upstream) or zero results: answer from
                            // model knowledge when the question does not need live data — a search
                            // outage must not kill the whole AI request (2026-09-13).
                            const outage = wErr ? _normalizeWebError(wErr) : null;
                            const emptyResults = !wErr && !!wResults && wResults.type === 'tool_result' && Array.isArray(wResults.sources) && wResults.sources.length === 0;
                            if (outage && outage.code === 'cancelled') return;
                            if ((outage && outage.code !== 'invalid_query') || emptyResults) {
                                // structured live data (weather/stocks/news)? ground from its keyless direct API
                                if (_isLiveIntent(toolQuery)) {
                                    const altP2 = _liveDataFallbackSources(toolQuery, myCancellable);
                                    if (altP2) { altP2.then((altSources) => {
                                        if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                        if (altSources) {
                                            try { if (typeof global !== 'undefined' && global.log) global.log('[QuickSearch AI] web search unavailable -> live-data direct API grounding (structured query)'); } catch (e) {}
                                            _prepareGroundingContext(myGen, myCancellable, q, altSources, toolQuery, (ctxInfo) => {
                                                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                                try {
                                                    provider.request(_withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, altSources)), myCancellable, (err2, res2) => {
                                                        if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                                        if (err2) {
                                                            const n3 = _normalizeProviderError(err2);
                                                            if (n3.code === 'cancelled') return;
                                                            return _deliverError(myGen, myCancellable, callbacks, n3.code, n3.message, { stage: n3.stage, status: n3.status, name: n3.name });
                                                        }
                                                        if (!res2 || res2.type !== 'answer' || typeof res2.text !== 'string' || !String(res2.text).trim()) {
                                                            return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                                        }
                                                        return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, altSources, _metaOf(res2));
                                                    });
                                                } catch (e) {
                                                    const n = _normalizeProviderError(e);
                                                    return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                                }
                                            });
                                            return;
                                        }
                                        return _deliverError(myGen, myCancellable, callbacks,
                                            outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                            (outage && outage.message) || ERROR_MESSAGES.no_results,
                                            outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                                    });
                                    } else {
                                        return _deliverError(myGen, myCancellable, callbacks,
                                            outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                            (outage && outage.message) || ERROR_MESSAGES.no_results,
                                            outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                                    }
                                    return;
                                }
                                if (!_isLiveIntent(toolQuery)) {
                                    try {
                                        provider.request(_withHistory(_knowledgeRetryPayload(q, toolQuery)), myCancellable, (errK, resK) => {
                                            if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                            if (errK) {
                                                const nk = _normalizeProviderError(errK);
                                                if (nk.code === 'cancelled') return;
                                                return _deliverError(myGen, myCancellable, callbacks, nk.code, nk.message, { stage: nk.stage, status: nk.status, name: nk.name });
                                            }
                                            if (!resK || resK.type !== 'answer' || typeof resK.text !== 'string' || !String(resK.text).trim()) {
                                                return _deliverError(myGen, myCancellable, callbacks, 'invalid_response', ERROR_MESSAGES.invalid_response);
                                            }
                                            return _deliverAnswer(myGen, myCancellable, callbacks, resK.text, [], _metaOf(resK));
                                        });
                                    } catch (e) {
                                        const n = _normalizeProviderError(e);
                                        return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                    }
                                    return;
                                }
                            }
                            if (wErr) {
                                const n2 = outage || _normalizeWebError(wErr);
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
                            _prepareGroundingContext(myGen, myCancellable, q, sources, toolQuery, (ctxInfo) => {
                                if (_stale(myGen) || _isCancelled(myCancellable) || destroyed) return;
                                try {
                                    provider.request(_withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, sources)), myCancellable, (err2, res2) => {
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
                                    return _deliverAnswer(myGen, myCancellable, callbacks, res2.text, sources, _metaOf(res2), q);
                                });
                                } catch (e) {
                                    const n = _normalizeProviderError(e);
                                    return _deliverError(myGen, myCancellable, callbacks, n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                }
                            });
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

        let systemPrompt = _buildRequestSystemPrompt(promptBuilder, false, q);

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

        // P3 (AI Pipeline V3): for live/current queries, WEB SEARCH FIRST then stream ONLY the
        // grounded synthesis — a first AI draft is never generated on the successful path, so
        // there is no provisional (possibly contradictory) answer to buffer or replace. Web / no
        // results / grounded-AI failures follow the existing error policy (same as the tool_call
        // grounded leg) and never re-run draft + search + second generation.
        if (enableGrounding && _isLiveIntent(q)) {
            try {
                const wsRequest = (Gt && typeof Gt.DEFAULT_MAX_RESULTS === 'number')
                    ? { query: q, maxResults: Gt.DEFAULT_MAX_RESULTS }
                    : { query: q, maxResults: 5 };
                _fanoutWebSearch(wsRequest, myCancellable, (wErr, wResults) => {
                    if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
                    const outage = wErr ? _normalizeWebError(wErr) : null;
                    const emptyResults = !wErr && !!wResults && wResults.type === 'tool_result' && Array.isArray(wResults.sources) && wResults.sources.length === 0;
                    if (outage && outage.code === 'cancelled') return;
                    if (outage || emptyResults) {
                        // structured live data (weather/stocks/news)? ground from its keyless direct API
                        const altP3 = _liveDataFallbackSources(q, myCancellable);
                        if (altP3) { altP3.then((altSources) => {
                            if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
                            if (altSources) {
                                try { if (typeof global !== 'undefined' && global.log) global.log('[QuickSearch AI] web search unavailable -> live-data direct API grounding (structured query)'); } catch (e) {}
                                groundedSources = altSources;
                                _prepareGroundingContext(myGen, myCancellable, q, altSources, q, (ctxInfo) => {
                                    if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
                                    accumulatedText = '';
                                    try {
                                        provider.streamRequest(
                                            _withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, altSources)),
                                            myCancellable,
                                            handleSecondStreamEvent
                                        );
                                    } catch (e) {
                                        const n = _normalizeProviderError(e);
                                        emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                    }
                                });
                                return;
                            }
                            emitError(outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                (outage && outage.message) || ERROR_MESSAGES.no_results,
                                outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                        });
                        } else {
                            emitError(outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                (outage && outage.message) || ERROR_MESSAGES.no_results,
                                outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                        }
                        return;
                    }
                    if (wErr) return;
                    const sources = wResults.sources;
                    _logWebSearchSources((wResults && wResults.query) || q, sources);
                    if (sources.length === 0) {
                        emitError('no_results', ERROR_MESSAGES.no_results, { stage: 'web_search_normalize' });
                        return;
                    }
                    groundedSources = sources;
                    _prepareGroundingContext(myGen, myCancellable, q, sources, q, (ctxInfo) => {
                        if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
                        accumulatedText = '';
                        try {
                            provider.streamRequest(
                                _withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, sources)),
                                myCancellable,
                                handleSecondStreamEvent
                            );
                        } catch (e) {
                            const n = _normalizeProviderError(e);
                            emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                        }
                    });
                });
            } catch (e) {
                emitError('grounding_error', ERROR_MESSAGES.grounding_error);
            }
            return;
        }

        function _staleS() { return myGen !== gen; }

        function emitComplete(finalText, sources, metaExtra) {
            if (settled || _staleS() || _isCancelled(myCancellable) || destroyed) return;
            const effectiveText = typeof finalText === 'string' ? finalText : accumulatedText;
            // groundedSources non-null <=> this text came from a grounded (numbered-evidence) leg
            const displayText = (groundedSources !== null) ? _cleanAnswerText(effectiveText) : effectiveText;
            // 9router reasoning models sometimes finish with EMPTY content (reasoning-only
            // stream). An empty answer must surface as an error, never as a blank bubble.
            if (!String(displayText || '').trim()) {
                emitError('invalid_response', ERROR_MESSAGES.invalid_response, { stage: 'provider_stream' });
                return;
            }
            settled = true;
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
                    payload = Gt.createGroundedAnswer(displayText, effectiveSources, metaExtra || null);
                } else {
                    const normalizedSources = sourceFormatter.formatSources(effectiveSources);
                    payload = { type: 'answer', text: displayText, grounded: normalizedSources.length > 0, sources: normalizedSources };
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
                // second leg is always grounded -> deltas are cleaned so markers never show mid-stream
                if (callbacks && typeof callbacks.onDelta === 'function') callbacks.onDelta(chunk, _cleanAnswerText(accumulatedText));
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
                    _fanoutWebSearch(wsRequest, myCancellable, (wErr, wResults) => {
                        if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                        // Availability outage (no healthy upstream) or zero results: answer from
                        // model knowledge when the question does not need live data — a search
                        // outage must not kill the whole AI request (2026-09-13).
                    const outage = wErr ? _normalizeWebError(wErr) : null;
                    const emptyResults = !wErr && !!wResults && wResults.type === 'tool_result' && Array.isArray(wResults.sources) && wResults.sources.length === 0;
                    if (outage && outage.code === 'cancelled') return;
                        if ((outage && outage.code !== 'invalid_query') || emptyResults) {
                            // structured live data (weather/stocks/news)? ground from its keyless direct API
                            if (_isLiveIntent(toolQuery)) {
                                const altP4 = _liveDataFallbackSources(toolQuery, myCancellable);
                                if (altP4) { altP4.then((altSources) => {
                                    if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                                    if (altSources) {
                                        try { if (typeof global !== 'undefined' && global.log) global.log('[QuickSearch AI] web search unavailable -> live-data direct API grounding (structured query)'); } catch (e) {}
                                        groundedSources = altSources;
                                        _prepareGroundingContext(myGen, myCancellable, q, altSources, toolQuery, (ctxInfo) => {
                                            if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                                            accumulatedText = '';
                                            try {
                                                provider.streamRequest(
                                                    _withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, altSources)),
                                                    myCancellable,
                                                    handleSecondStreamEvent
                                                );
                                            } catch (e) {
                                                const n = _normalizeProviderError(e);
                                                emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                            }
                                        });
                                        return;
                                    }
                                    emitError(outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                        (outage && outage.message) || ERROR_MESSAGES.no_results,
                                        outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                                });
                                } else {
                                    emitError(outage ? (outage.code || 'web_search_unavailable') : 'no_results',
                                        (outage && outage.message) || ERROR_MESSAGES.no_results,
                                        outage ? { stage: outage.stage || 'web_search_request', status: outage.status } : { stage: 'web_search_normalize' });
                                }
                                return;
                            }
                            if (!_isLiveIntent(toolQuery)) {
                                accumulatedText = '';
                                try {
                                    provider.streamRequest(_withHistory(_knowledgeRetryPayload(q, toolQuery)), myCancellable, handleSecondStreamEvent);
                                } catch (e) {
                                    const n = _normalizeProviderError(e);
                                    emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                                }
                                return;
                            }
                        }
                        if (wErr) {
                            const n2 = outage || _normalizeWebError(wErr);
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
                        _prepareGroundingContext(myGen, myCancellable, q, sources, toolQuery, (ctxInfo) => {
                            if (_staleS() || _isCancelled(myCancellable) || destroyed || settled) return;
                            // Reset accumulation for grounded answer streaming
                            accumulatedText = '';
                            try {
                                provider.streamRequest(
                                    _withHistory(_groundedPayload(q, ctxInfo.groundingContext, ctxInfo.groundingContextObj, sources)),
                                    myCancellable,
                                    handleSecondStreamEvent
                                );
                            } catch (e) {
                                const n = _normalizeProviderError(e);
                                emitError(n.code, n.message, { stage: n.stage, status: n.status, name: n.name });
                            }
                        });
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
