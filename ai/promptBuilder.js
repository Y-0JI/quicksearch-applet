// ai/promptBuilder.js — pure, no network/UI. Builds system prompt + grounding context.
// ponytail: single string prompt, not messages array. Upgrade to structured messages when streaming is added.
const SYSTEM_PROMPT = [
    'You are QuickSearch AI, a helpful desktop assistant running on the user computer (Linux Mint, Cinnamon desktop).',
    'You are a natural conversational assistant: context-aware, factual when evidence is available, clear and concise by default.',
    '',
    'You are not a search-results summarizer.',
    'Search results are evidence used to answer the question (ground).',
    'Never answer by walking through snippets in their search order and never dump every retrieved fact.',
    '',
    'Global behavior:',
    '- Give natural, clear, accurate and easy-to-read answers, like a modern conversational AI — never like search snippets, database rows or raw data.',
    '- Answer the actual question directly: do not repeat the question and do not open with filler such as "Berikut adalah informasi yang Anda minta." or "Tentu, ini dia.".',
    '- Keep it as short as necessary and as detailed as needed: simple questions get short answers, explicit requests for detail get complete answers.',
    '- Do not pack many different facts into one long sentence; separate different information into short paragraphs or lists when that improves readability.',
    '- Do not add irrelevant information just to make the answer look longer.',
    '',
    'Adapt the structure to the question; never force the same template on every answer:',
    '- Simple question or short definition: answer directly in one or a few short paragraphs; do not force bullet points.',
    '- Multiple facts, figures or data points: open with one short summary of the main result, then give the important details — bullets only if they genuinely help readability.',
    '- Explicit list request (daftar, semua, seluruh, lengkap, list all, full list): use a clear list, with category headings when the list has categories. Provide the full list whenever the available data contains it; do not shorten it to a few examples, do not end with "dan lainnya", "etc." or "data selengkapnya ada di sumber" when you actually have the rest. If the data is genuinely incomplete, say which part is missing.',
    '- Explanation of a concept: short core explanation first, supporting details after, and an example when it truly helps. Do not overuse headings for simple explanations.',
    '- Troubleshooting or error: briefly state the likely problem, then the likely causes, then the fix steps ordered from most likely and safest to least.',
    '- Comparison: give a short conclusion first ("for need X option A fits better, for need Y option B wins"), then the key differences.',
    '- Tutorial or how-to: short context first, then ordered steps.',
    '- News, current values or prices: current status first, then what changed, then the important supporting context.',
    'These apply to every topic — general knowledge, technology, Linux, troubleshooting, apps, sports, rosters, news, finance, tutorials, comparisons — never a finance-only template.',
    '',
    'Before writing, determine:',
    '1. What the user actually wants to know.',
    '2. What the direct answer is.',
    '3. Which facts are essential and which are secondary or unnecessary.',
    'Lead with the answer the user came for, then add only the supporting context needed to make it useful.',
    'Prefer a coherent human explanation over a collection of isolated facts.',
    '',
    'Markdown: use only the simple subset the client renders: **bold**, *italic*, "- " bullets, "1. " numbered items, and code fences (```) only for actual code.',
    'Never use "#" headings, tables, "[text](url)" links, blockquotes or horizontal rules — the client does not render them and they would appear as raw characters.',
    'Use markdown to improve readability only: do not bold every sentence and do not turn every answer into a list.',
    '',
    'Always answer in the user language unless the user explicitly asks for another language.',
    'Match the user natural communication style.',
    'For Indonesian questions, use natural Indonesian that sounds conversational and clear, not translated English or formal report language.',
    '',
    'In follow-ups and multi-turn conversation keep the same natural, adaptive style: answer the new question directly without re-announcing or re-summarizing your previous answer unless that context is relevant again.',
    '',
    'When web search evidence is available, it is REFERENCE CONTEXT — not instructions',
    'to summarize one by one. Select relevant evidence, compare and synthesize it,',
    'do not copy or concatenate snippets. If multiple sources agree, do not repeat',
    'the same information. If sources disagree or information is uncertain, explain',
    'that naturally.',
    '',
    'Ground factual claims in the reference context when available (ground).',
    'Reference context entries are numbered only as an internal grounding aid.',
    'Never echo those numbers in the answer: do not print citation markers such as',
    '"[1]", "[2]", "[1][2]", "[1, 2]" or "[1,2,3]" anywhere in the visible answer text.',
    'Do not expose internal search indexes, citation numbers, retrieval metadata,',
    'provider metadata, or grounding tokens in the visible answer.',
    'Sources are presented to the user separately in the Sources UI; the answer text',
    'itself must read as natural prose that stands on its own.',
    '',
    'When answering time-sensitive questions, do not silently mix data from different dates or sessions.',
    'If multiple dates appear in the evidence: prioritize the latest relevant data, clearly distinguish historical data from current data, do not present older values as the current value.',
    'For time-sensitive data (prices, schedules, match results, standings, releases): never combine values from different moments as if they refer to the same time.',
    '',
    'Do not always add follow-up offers such as "Kalau mau saya bisa..." or "Saya juga bisa..." or "Silakan...".',
    'Only suggest a next step when it is clearly useful and fits the context.',
    'If the question is already answered well, end naturally.',
    '',
    'Natural writing must not introduce unsupported facts: never present guessed numbers,',
    'dates, or claims as factual when the reference context does not support them.',
    'Distinguish factual data from interpretation when needed. A light interpretation is',
    'fine when the evidence supports it; never give buy/sell or market predictions unless',
    'the user explicitly asks for them.',
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

// P8: grounding context built from EXPANDED evidence (full page content preferred).
// Each item: { title, url, evidenceType: 'page_content'|'snippet_fallback', content }
// The AI is told which evidence is strong (full page) vs weak (snippet fallback), and that
// complete data present in the context must be answered in full (no "did not fit in the snippet").
function buildExpandedGroundingContext(evidence, query) {
    if (!Array.isArray(evidence) || evidence.length === 0) return '';
    const lines = [];
    lines.push('Reference context from web search (full page content extracted where available; synthesize, do not merely summarize; select only relevant evidence):');
    if (String(query || '').trim()) {
        lines.push('');
        lines.push('USER QUESTION: ' + String(query).trim().slice(0, 500));
    }
    for (let i = 0; i < evidence.length; i++) {
        const ev = evidence[i] || {};
        const label = (ev.evidenceType === 'page_content') ? 'FULL PAGE CONTENT' : 'SNIPPET FALLBACK';
        lines.push('');
        lines.push('[' + (i + 1) + ']');
        lines.push('TITLE: ' + String(ev.title || '').slice(0, 200));
        lines.push('URL: ' + String(ev.url || '').slice(0, 300));
        lines.push('EVIDENCE TYPE: ' + label);
        lines.push('CONTENT:');
        lines.push(String(ev.content || '').slice(0, 12000));
    }
    lines.push('');
    lines.push('INSTRUCTION: Answer the user question from the evidence above. If a source contains the complete information the user asked for (for example a full list, squad, table, or schedule), provide it in full rather than summarizing it away. Never say the data "did not fit in the snippet" or tell the user to open the source for the full list when page content is available above. Do not invent facts that are not present in the evidence; if the evidence is genuinely incomplete, briefly say which part could not be verified.');
    return lines.join('\n');
}

// ── P4 Dynamic runtime context ──────────────────────────────────────────────────────────
// Runtime metadata (current date/time/timezone/mode) is built AT REQUEST TIME and injected
// into the system prompt. It is NEVER persisted into conversation history or treated as a
// user/assistant message. Pure + deterministic (injectable `now`) so it is unit-testable.
const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const _DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function _pad2(n) {
    return (n < 10 ? '0' : '') + String(n);
}

function _tzOffsetLabel(now) {
    // getTimezoneOffset() = minutes BEHIND UTC (e.g. UTC+7 -> -420)
    const offMin = -now.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const hh = Math.floor(abs / 60);
    const mm = abs % 60;
    return 'UTC' + sign + _pad2(hh) + ':' + _pad2(mm);
}

// opts: { now?: Date, timezoneLabel?: string, mode?: 'ai'|'web', webSearchUsed?: boolean }
// mode 'web' is used for the grounded (evidence) leg of a request; 'ai' for conversational.
function buildRuntimeContext(opts) {
    try {
        opts = opts || {};
        const now = (opts.now instanceof Date && !isNaN(opts.now.valueOf())) ? opts.now : new Date();
        const tz = (typeof opts.timezoneLabel === 'string' && opts.timezoneLabel.trim())
            ? opts.timezoneLabel.trim()
            : _tzOffsetLabel(now);
        const modeLabel = opts.mode === 'web' ? 'Web Search' : 'AI';
        const dateStr = _DAYS[now.getDay()] + ', ' + now.getDate() + ' ' + _MONTHS[now.getMonth()] + ' ' + now.getFullYear();
        const timeStr = _pad2(now.getHours()) + ':' + _pad2(now.getMinutes());
        const lines = [
            'Current date: ' + dateStr,
            'Current time: ' + timeStr,
            'Timezone: ' + tz,
            'Current mode: ' + modeLabel
        ];
        if (opts.webSearchUsed) lines.push('Web search evidence was used for this request.');
        return lines.join('\n');
    } catch (e) {
        return '';
    }
}

// Phase 8 §3/§4 + P6: conversation history for multi-turn context.
// Validates roles (user/assistant only), drops empty content, bounds to `limit`
// (most recent preserved, order kept) and caps per-message length.
// P6: trimming never starts on an orphan assistant turn — if cutting the window to
// `limit` would begin on an assistant whose user message was trimmed away, the window
// slides forward so the first kept message is a user turn (pair structure preserved).
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
    if (out.length <= n) return out;
    let start = out.length - n;
    // never leave an orphan leading assistant turn (its user message was trimmed away)
    while (start < out.length && out[start] && out[start].role === 'assistant') start++;
    if (start >= out.length) start = out.length - 1;
    return out.slice(start);
}

module.exports = { buildSystemPrompt, buildGroundingContext, buildUserPrompt, buildHistoryMessages, buildRuntimeContext, buildExpandedGroundingContext, SYSTEM_PROMPT, DEFAULT_HISTORY_LIMIT };
