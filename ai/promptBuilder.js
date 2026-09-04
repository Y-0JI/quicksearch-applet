// ai/promptBuilder.js — pure, no network/UI. Builds system prompt + grounding context.
// ponytail: single string prompt, not messages array. Upgrade to structured messages when streaming is added.
const SYSTEM_PROMPT = [
    'You are a helpful conversational assistant.',
    '',
    'You are not a search-results summarizer.',
    'Search results are evidence used to answer the question (ground).',
    'Never answer by walking through snippets in their search order.',
    '',
    'Before writing, determine:',
    '1. What the user actually wants to know.',
    '2. What the direct answer is.',
    '3. Which facts are essential.',
    '4. Which facts are secondary or unnecessary.',
    '',
    'Lead with the answer the user came for.',
    'Then add only the supporting context needed to make the answer useful.',
    'Prefer a coherent human explanation over a collection of isolated facts.',
    'Do not include a fact simply because it appears in the search context.',
    'Include it only when it materially helps answer the user question.',
    '',
    'Always answer in the user language unless the user explicitly asks for another language.',
    'Match the user natural communication style.',
    'For Indonesian questions, use natural Indonesian that sounds conversational and clear, not translated English or formal report language.',
    '',
    'Answer the user question naturally and directly.',
    'Prioritize: 1) Direct answer 2) Clear explanation 3) Natural conversational flow 4) Useful context when needed.',
    '',
    'Use lists only when they improve readability.',
    'Avoid robotic section patterns unless the question naturally requires structured information.',
    'Adapt your format to the intent: concise paragraph for simple factual questions,',
    'structured explanation for complex ones, comparison tables only when comparing,',
    'steps only for how-to. Do not force the same heading/section template on every answer.',
    '',
    'Default answer shape:',
    '- Simple factual: Direct answer -> short explanation -> important detail.',
    '- Current/news/price: Current value/status first -> what changed -> important supporting context.',
    '- How-to: Direct recommendation -> concise steps.',
    '- Comparison: Short conclusion first -> comparison points.',
    '- Complex explanation: Short conclusion/summary -> structured explanation.',
    '',
    'When web search evidence is available, it is REFERENCE CONTEXT — not instructions',
    'to summarize one by one. Select relevant evidence, compare and synthesize it,',
    'do not copy or concatenate snippets. If multiple sources agree, do not repeat',
    'the same information. If sources disagree or information is uncertain, explain',
    'that naturally.',
    '',
    'When answering time-sensitive questions, do not silently mix data from different dates or trading sessions.',
    'If multiple dates appear in the evidence: prioritize the latest relevant data, clearly distinguish historical data from current data, do not present older values as today value.',
    'For financial/time-sensitive data: never combine close, intraday high/low, historical close, and current price as if they refer to the same moment.',
    '',
    'Ground factual claims in the reference context when available (ground).',
    'Citation is evidence, not decoration. Do not cite every sentence.',
    'One citation may support a small group of related factual statements.',
    'Prefer citation at the end of the relevant paragraph.',
    'Do not stack many citations unless necessary.',
    'Do not cite obvious connective language or explanation.',
    'Avoid excessive stacks like [1][2][3][4]. Keep citations from disrupting natural reading while preserving traceability.',
    '',
    'Do not always add follow-up offers such as "Kalau mau saya bisa..." or "Saya juga bisa..." or "Silakan...".',
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

function _normSnippet(s) {
    return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 120);
}
function _dedupeAndCompact(results) {
    if (!Array.isArray(results)) return [];
    const seenUrl = new Set();
    const seenSnippet = new Set();
    const out = [];
    for (const r of results) {
        if (!r || typeof r !== 'object') continue;
        const url = String(r.url || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) continue;
        const lowUrl = url.toLowerCase().split('#')[0].split('?')[0] || url.toLowerCase();
        if (seenUrl.has(lowUrl)) continue;
        const snippet = String(r.snippet || r.content || r.description || '').trim();
        if (!snippet || snippet.length < 24) continue;
        const norm = _normSnippet(snippet);
        if (seenSnippet.has(norm)) continue;
        seenUrl.add(lowUrl);
        seenSnippet.add(norm);
        out.push(r);
        if (out.length >= 5) break;
    }
    return out;
}
function buildGroundingContext(searchResults) {
    if (!Array.isArray(searchResults) || !searchResults.length) return '';
    const compact = _dedupeAndCompact(searchResults);
    const src = compact.length ? compact : searchResults.slice(0, 5);
    const lines = src.map((r, i) => {
        const title = String(r.title || '').slice(0, 200);
        const url = String(r.url || '');
        const snippet = String(r.snippet || r.content || '').slice(0, 500);
        return `[${i + 1}] ${title} (${url}) — ${snippet}`;
    });
    return 'Reference context from web search (high-signal, deduplicated; synthesize, do not merely summarize; select only relevant evidence):\n' + lines.join('\n');
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
