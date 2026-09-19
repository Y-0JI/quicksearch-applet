// ai/toolCallMarkup.js - deterministic guard against raw tool-call markup in UI.
// Pure, no I/O, no LLM, no UI. Some models answer a web_search tool request
// with XML-ish TEXT instead of OpenAI tool_calls JSON. That text must be
// treated as an INTERNAL tool call, never rendered to the user.
const XML_TOOL_RE = /<\s*tool_calls\s*>[\s\S]*?<\s*invoke\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>[\s\S]*?<\s*\/\s*tool_calls\s*>/i;
const XML_QUERY_RE = /<\s*parameter\b[^>]*\bname\s*=\s*["']query["'][^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/i;
const XML_ANY_RE = /<\s*\/?\s*tool_calls\s*>|<\s*\/?\s*invoke\b[^>]*>|<\s*\/?\s*parameter\b[^>]*>/gi;

function extractXmlToolCall(text) {
    const s = String(text == null ? '' : text);
    if (s.indexOf('<') === -1 || s.toLowerCase().indexOf('tool_calls') === -1) return null;
    const m = XML_TOOL_RE.exec(s);
    if (!m) return null;
    const tool = String(m[1] || '').trim();
    const inner = String(m[2] || '');
    const qm = XML_QUERY_RE.exec(inner);
    const query = qm ? String(qm[1] || '').trim() : '';
    if (!tool || !query) return null;
    return { tool, query, start: m.index, end: m.index + m[0].length };
}

function isOnlyXmlToolCall(text) {
    const hit = extractXmlToolCall(text);
    if (!hit) return false;
    const rest = (String(text).slice(0, hit.start) + String(text).slice(hit.end)).trim();
    return rest === '';
}

function stripToolCallMarkup(text) {
    const s = String(text == null ? '' : text);
    if (s.indexOf('<') === -1) return s;
    return s.replace(XML_ANY_RE, '').replace(/[ \t]+\n/g, '\n').trim();
}

function containsToolCallMarkup(text) {
    return extractXmlToolCall(text) !== null;
}

module.exports = { extractXmlToolCall, isOnlyXmlToolCall, stripToolCallMarkup, containsToolCallMarkup };
