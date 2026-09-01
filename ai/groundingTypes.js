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

function normalizeSources(raw, maxResults) {
    if (!Array.isArray(raw)) return [];
    const max = normalizeMaxResults(maxResults);
    const seen = new Set();
    const tmp = [];
    for (const entry of raw) {
        const n = normalizeSource(entry);
        if (!n) continue;
        const key = n.url.trim();
        if (seen.has(key)) continue;
        seen.add(key);
        tmp.push(n);
        if (tmp.length >= max) break;
    }
    return tmp.map((s, i) => ({ id: `web-${i + 1}`, title: s.title, url: s.url, snippet: s.snippet }));
}

function createToolResult(query, sources) {
    const q = typeof query === 'string' ? query.trim() : String(query || '').trim();
    const src = Array.isArray(sources) ? sources : [];
    return { type: 'tool_result', tool: TOOL_NAME, query: q, sources: src };
}

function createToolError(code, message) {
    const allowed = ['invalid_query', 'backend_unavailable', 'request_failed', 'cancelled', 'invalid_response'];
    const c = allowed.includes(code) ? code : 'request_failed';
    const msg = typeof message === 'string' && message.trim() ? message.trim() : 'Web search error';
    return { type: 'tool_error', tool: TOOL_NAME, code: c, message: msg };
}

function createGroundingContext(query, sources) {
    const q = typeof query === 'string' ? query.trim() : String(query || '').trim();
    const src = Array.isArray(sources) ? sources : [];
    return { type: 'grounding_context', query: q, sources: src };
}

function createGroundedAnswer(text, sources) {
    const t = String(text || '');
    const src = Array.isArray(sources) ? sources : [];
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
    if (raw.type === 'tool_call' && raw.tool === TOOL_NAME) {
        const q = raw.arguments && raw.arguments.query;
        if (typeof q === 'string' && q.trim()) return { type: 'tool_call', tool: TOOL_NAME, arguments: { query: q.trim() } };
        return { type: 'unsupported_tool', tool: raw.tool };
    }
    if (raw.type === 'tool_call') return { type: 'unsupported_tool', tool: String(raw.tool || '') };
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
    createToolResult,
    createToolError,
    createGroundingContext,
    createGroundedAnswer,
    validateRequest,
    normalizeToolCall
};
