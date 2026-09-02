// ai/groundingTypes.js — canonical contracts for Web Search Grounding (AI-3A)
// Pure, no I/O, no UI. Single source for request/source/tool/grounding/answer shapes.
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const MAX_TOOL_ROUNDS = 1;
const TOOL_NAME = 'web_search';

const ERROR_CODES = {
    invalid_query: 'invalid_query',
    backend_unavailable: 'backend_unavailable',
    request_failed: 'request_failed',
    cancelled: 'cancelled',
    invalid_response: 'invalid_response'
};

function isValidHttpUrl(u) {
    if (typeof u !== 'string') return false;
    const s = u.trim();
    if (!s) return false;
    if (!/^https?:\/\/.+/i.test(s)) return false;
    try {
        const parsed = new URL(s);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) { return false; }
}

function normalizeMaxResults(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_MAX_RESULTS;
    let n = Math.floor(v);
    if (n <= 0) return DEFAULT_MAX_RESULTS;
    if (n > MAX_RESULTS) return MAX_RESULTS;
    return n;
}

function normalizeSource(entry, id) {
    if (!entry || typeof entry !== 'object') return null;
    const urlRaw = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!isValidHttpUrl(urlRaw)) return null;
    const url = urlRaw;
    let title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) {
        try { title = new URL(url).hostname || url; } catch (e) { title = url; }
        title = String(title).trim();
        if (!title) return null;
    }
    let snippet = '';
    if (typeof entry.snippet === 'string') snippet = entry.snippet;
    else if (typeof entry.content === 'string') snippet = entry.content;
    else if (typeof entry.description === 'string') snippet = entry.description;
    else snippet = '';
    snippet = String(snippet).slice(0, 500);
    title = title.slice(0, 200);
    const out = { title, url, snippet };
    if (id) out.id = id;
    return out;
}

// Lightweight URL normalization for dedupe only — does not rewrite destination semantics.
// - trim
// - lowercase protocol + hostname
// - normalize empty path "/" consistently (https://example.com vs https://example.com/ are duplicates)
// Does NOT strip querystring, fragment, or tracking params.
// Preserves path case ( /path vs /PATH are distinct) and query distinctness.
function normalizeDedupeKey(url) {
    const raw = String(url || '').trim();
    try {
        const u = new URL(raw);
        const protocol = u.protocol.toLowerCase(); // "https:" / "http:"
        const hostname = u.hostname.toLowerCase();
        const port = u.port ? ':' + u.port : '';
        let pathname = u.pathname || '/';
        if (pathname === '/') pathname = '/';
        return protocol + '//' + hostname + port + pathname + u.search + u.hash;
    } catch (e) {
        return raw.toLowerCase();
    }
}

function isCanonicalSource(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id !== 'string' || !entry.id.trim()) return false;
    if (!/^web-\d+$/.test(entry.id.trim())) return false;
    if (typeof entry.title !== 'string' || !entry.title.trim()) return false;
    if (entry.title.length > 200) return false;
    if (typeof entry.url !== 'string' || !isValidHttpUrl(entry.url)) return false;
    if (typeof entry.snippet !== 'string') return false;
    if (entry.snippet.length > 500) return false;
    return true;
}

// Inspection helper — separates already-canonical sources, does not normalize raw.
// For enforcement/normalization use canonicalizeSources() / normalizeSources() / builders.
function validateSources(sources) {
    if (!Array.isArray(sources)) return { valid: [], invalid: [] };
    const valid = [];
    const invalid = [];
    for (const s of sources) {
        if (isCanonicalSource(s)) valid.push(s);
        else invalid.push(s);
    }
    return { valid, invalid };
}

function normalizeSources(raw, maxResults) {
    if (!Array.isArray(raw)) return [];
    const max = normalizeMaxResults(maxResults);
    const seen = new Set();
    const tmp = [];
    for (const entry of raw) {
        const n = normalizeSource(entry);
        if (!n) continue;
        const key = normalizeDedupeKey(n.url);
        if (seen.has(key)) continue;
        seen.add(key);
        tmp.push(n);
        if (tmp.length >= max) break;
    }
    return tmp.map((s, i) => ({ id: `web-${i + 1}`, title: s.title, url: s.url, snippet: s.snippet }));
}

// Internal single canonical path — normalize raw, validate, dedupe, re-id.
// Used by createToolResult / createGroundingContext / createGroundedAnswer so they don't drift.
function canonicalizeSources(sources) {
    if (!Array.isArray(sources)) return [];
    const filtered = [];
    for (const s of sources) {
        if (isCanonicalSource(s)) filtered.push(s);
        else {
            const n = normalizeSource(s);
            if (n) filtered.push({ id: `web-${filtered.length + 1}`, title: n.title, url: n.url, snippet: n.snippet });
        }
    }
    const seen = new Set();
    const deduped = [];
    for (const s of filtered) {
        const key = normalizeDedupeKey(s.url);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(s);
    }
    return deduped.map((s, i) => ({ id: `web-${i + 1}`, title: s.title, url: s.url, snippet: s.snippet }));
}

function createToolResult(query, sources) {
    const q = typeof query === 'string' ? query.trim() : String(query || '').trim();
    const src = canonicalizeSources(sources);
    return { type: 'tool_result', tool: TOOL_NAME, query: q, sources: src };
}

function createToolError(code, message) {
    const allowed = ['invalid_query', 'backend_unavailable', 'request_failed', 'cancelled', 'invalid_response'];
    const c = allowed.includes(code) ? code : 'request_failed';
    const msg = typeof message === 'string' && message.trim() ? message.trim().split('\n')[0].slice(0, 200) : 'Web search error';
    return { type: 'tool_error', tool: TOOL_NAME, code: c, message: msg };
}

// Canonical error → callback Error instance boundary.
// Pure contract is {type:'tool_error',...}; Node callback expects Error with code/type/tool fields.
function toCallbackError(toolError) {
    const e = new Error(toolError.message || 'Web search error');
    e.code = toolError.code;
    e.type = toolError.type;
    e.tool = toolError.tool;
    e.message = toolError.message;
    Object.assign(e, toolError);
    return e;
}

function fromCallbackError(err) {
    if (!err) return createToolError('request_failed', 'Web search error');
    if (err.type === 'tool_error' && err.code && err.tool) return { type: err.type, tool: err.tool, code: err.code, message: err.message };
    const code = err.code;
    const msg = typeof err.message === 'string' ? err.message.split('\n')[0].slice(0, 200) : 'Web search error';
    if (code === 'invalid_query' || code === 'backend_unavailable' || code === 'request_failed' || code === 'cancelled' || code === 'invalid_response') {
        return createToolError(code, msg);
    }
    return createToolError('request_failed', msg);
}

function createGroundingContext(query, sources) {
    const q = typeof query === 'string' ? query.trim() : String(query || '').trim();
    const src = canonicalizeSources(sources);
    return { type: 'grounding_context', query: q, sources: src };
}

function createGroundedAnswer(text, sources) {
    const t = String(text || '');
    const src = canonicalizeSources(sources);
    const grounded = src.length > 0;
    return { type: 'answer', text: t, grounded, sources: src };
}

function validateRequest(req) {
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
        return { error: createToolError('invalid_query', 'Invalid search query') };
    }
    const q = typeof req.query === 'string' ? req.query.trim() : '';
    if (!q) return { error: createToolError('invalid_query', 'Invalid search query') };
    const maxResults = normalizeMaxResults(req.maxResults);
    return { query: q, maxResults };
}

function normalizeToolCall(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'unsupported_tool', tool: String(raw && raw.tool || '') };
    if (raw.type === 'tool_call') {
        if (raw.tool !== TOOL_NAME) {
            return { type: 'unsupported_tool', tool: String(raw.tool || '') };
        }
        const q = raw.arguments && raw.arguments.query;
        if (typeof q !== 'string' || !q.trim()) {
            return createToolError('invalid_query', 'Invalid search query');
        }
        return { type: 'tool_call', tool: TOOL_NAME, arguments: { query: q.trim() } };
    }
    return { type: 'unsupported_tool', tool: String(raw.tool || '') };
}

module.exports = {
    DEFAULT_MAX_RESULTS,
    MAX_RESULTS,
    MAX_TOOL_ROUNDS,
    TOOL_NAME,
    ERROR_CODES,
    isValidHttpUrl,
    normalizeMaxResults,
    normalizeSource,
    normalizeSources,
    normalizeDedupeKey,
    isCanonicalSource,
    validateSources,
    canonicalizeSources,
    createToolResult,
    createToolError,
    toCallbackError,
    fromCallbackError,
    createGroundingContext,
    createGroundedAnswer,
    validateRequest,
    normalizeToolCall
};
