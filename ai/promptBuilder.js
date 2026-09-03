// ai/promptBuilder.js — pure, no network/UI. Builds system prompt + grounding context.
// ponytail: single string prompt, not messages array. Upgrade to structured messages when streaming is added.
const SYSTEM_PROMPT = [
    'You are QuickSearch AI Search.',
    'Answer the user question directly.',
    'Use web search when current or external information is required.',
    'Do not invent search results.',
    'When search results are supplied, ground factual claims in them.',
    'If the supplied information is insufficient, say so.',
    'Never claim web search was performed when it was not.',
    'Only the web_search tool is available.',
    'Do not request or execute arbitrary tools.'
].join('\n');

function buildSystemPrompt() {
    return SYSTEM_PROMPT;
}

function buildGroundingContext(searchResults) {
    if (!Array.isArray(searchResults) || !searchResults.length) return '';
    const lines = searchResults.map((r, i) => {
        const title = String(r.title || '').slice(0, 200);
        const url = String(r.url || '');
        const snippet = String(r.snippet || r.content || '').slice(0, 500);
        return `[${i + 1}] ${title} (${url}) — ${snippet}`;
    });
    return 'Web search results:\n' + lines.join('\n');
}

function buildUserPrompt(query, searchResults) {
    const q = String(query || '').trim();
    if (!searchResults || !searchResults.length) return q;
    return q + '\n\n' + buildGroundingContext(searchResults);
}

// Phase 8 §3/§4: conversation history for multi-turn context.
// Validates roles (user/assistant only), drops empty content, bounds to `limit`
// (most recent preserved, order kept) and caps per-message length.
// Returns an array of { role, content } ready to be pushed as chat messages.
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_MSG_LEN = 2000;

function buildHistoryMessages(history, limit) {
    const n = (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_HISTORY_LIMIT;
    if (!Array.isArray(history) || history.length === 0) return [];
    const out = [];
    for (const m of history) {
        if (!m || typeof m !== 'object') continue;
        const role = m.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = String(m.content || '').trim();
        if (!content) continue;
        out.push({ role, content: content.slice(0, MAX_HISTORY_MSG_LEN) });
    }
    return out.slice(-n);
}

module.exports = { buildSystemPrompt, buildGroundingContext, buildUserPrompt, buildHistoryMessages, SYSTEM_PROMPT, DEFAULT_HISTORY_LIMIT };
