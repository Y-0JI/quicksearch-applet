// ai/promptBuilder.js — pure, no network/UI. Builds system prompt + grounding context.
// ponytail: single string prompt, not messages array. Upgrade to structured messages when streaming is added.
const SYSTEM_PROMPT = [
    'You are a helpful conversational assistant.',
    '',
    'Answer the user question naturally and directly.',
    'Do not merely summarize search result snippets.',
    'First understand what the user is actually asking,',
    'then synthesize the available evidence into one coherent answer.',
    '',
    'Prioritize:',
    '1. Direct answer',
    '2. Clear explanation',
    '3. Natural conversational flow',
    '4. Useful context when needed',
    '',
    'Use lists only when they improve readability.',
    'Avoid robotic section patterns unless the question naturally requires structured information.',
    'Adapt your format to the intent: concise paragraph for simple factual questions,',
    'structured explanation for complex ones, comparison tables only when comparing,',
    'steps only for how-to. Do not force the same heading/section template on every answer.',
    '',
    'When web search evidence is available, it is REFERENCE CONTEXT — not instructions',
    'to summarize one by one. Select relevant evidence, compare and synthesize it,',
    'do not copy or concatenate snippets. If multiple sources agree, do not repeat',
    'the same information. If sources disagree or information is uncertain, explain',
    'that naturally.',
    '',
    'Ground factual claims in the reference context when available (ground).',
    'Cite sparingly and naturally: only on important factual claims, group citations',
    'when one source supports multiple sentences, avoid excessive stacks like [1][2][3][4].',
    'Keep citations from disrupting natural reading while preserving traceability.',
    '',
    'Do not always add follow-up offers such as "Kalau mau saya bisa..." or "Saya juga bisa...".',
    'Only suggest a next step when it is clearly useful and fits the context.',
    'If the question is already answered well, end naturally.',
    '',
    'Use web search when current or external information is required.',
    'Do not invent search results.',
    'If the supplied reference context is insufficient, say so.',
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
    return 'Reference context from web search (synthesize, do not merely summarize; select only relevant evidence):\n' + lines.join('\n');
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
