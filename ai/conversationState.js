// ai/conversationState.js — Phase 8: canonical conversation message model.
// Pure state, no GJS/UI/network. UI (applet.js) is a thin shell over this.
//
// Message: { id, role, content, timestamp, status }
//   role:   'user' | 'assistant' | 'system' (system reserved, internal only)
//   status: 'streaming' | 'complete' | 'cancelled' | 'error'   (assistant only)
// Assistant messages additionally carry:
//   sources — array of { title, url, snippet } attached to the message that produced them (§10)
//   error   — sanitized { code, stage, message } for error/cancelled states (§8/§9)

const DEFAULT_HISTORY_LIMIT = 10;

function _now() {
    try { return Date.now(); } catch (e) { return 0; }
}

function createConversation() {
    return { messages: [], seq: 0, activeId: null };
}

function _id(conv) {
    conv.seq += 1;
    return 'm' + conv.seq;
}

function appendUser(conv, text) {
    const content = String(text || '').trim();
    if (!conv || !content) return null;
    const msg = {
        id: _id(conv),
        role: 'user',
        content: content,
        timestamp: _now(),
        status: 'complete'
    };
    conv.messages.push(msg);
    return msg.id;
}

// Creates an empty assistant message in 'streaming' state; it becomes the active request.
function appendAssistant(conv) {
    if (!conv) return null;
    const msg = {
        id: _id(conv),
        role: 'assistant',
        content: '',
        timestamp: _now(),
        status: 'streaming',
        sources: []
    };
    conv.messages.push(msg);
    conv.activeId = msg.id;
    return msg.id;
}

function _find(conv, id) {
    if (!conv || !Array.isArray(conv.messages)) return null;
    for (const m of conv.messages) {
        if (m && m.id === id) return m;
    }
    return null;
}

function _isTerminal(status) {
    return status === 'complete' || status === 'cancelled' || status === 'error';
}

// In-place content update for the streaming assistant message (§5: one message per request,
// chunks append to the same message — never one message per chunk).
function updateAssistant(conv, id, fullText) {
    const m = _find(conv, id);
    if (!m || m.role !== 'assistant' || m.status !== 'streaming') return false;
    m.content = String(fullText || '');
    return true;
}

function completeAssistant(conv, id, text, sources, meta) {
    const m = _find(conv, id);
    if (!m || m.role !== 'assistant' || m.status !== 'streaming') return false;
    m.content = String(text || '');
    m.sources = Array.isArray(sources) ? sources.slice() : [];
    m.status = 'complete';
    if (meta && typeof meta.finishReason === 'string') m.finishReason = meta.finishReason;
    m.truncated = !!(meta && (meta.truncated || meta.finishReason === 'length'));
    if (conv.activeId === id) conv.activeId = null;
    return true;
}

// §8: cancellation keeps partial content; status becomes 'cancelled'; request no longer active.
function cancelAssistant(conv, id) {
    const m = _find(conv, id);
    if (!m || m.role !== 'assistant' || _isTerminal(m.status)) return false;
    m.status = 'cancelled';
    if (conv.activeId === id) conv.activeId = null;
    return true;
}

function cancelActive(conv) {
    if (!conv || conv.activeId == null) return false;
    return cancelAssistant(conv, conv.activeId);
}

// §9: errors belong to the current assistant interaction, history stays intact.
function failAssistant(conv, id, error) {
    const m = _find(conv, id);
    if (!m || m.role !== 'assistant' || _isTerminal(m.status)) return false;
    m.status = 'error';
    m.error = error && typeof error === 'object'
        ? { code: error.code || 'provider_error', stage: error.stage || error._stage || null, message: error.message || null }
        : { code: 'provider_error' };
    if (conv.activeId === id) conv.activeId = null;
    return true;
}

function getMessages(conv) {
    if (!conv || !Array.isArray(conv.messages)) return [];
    return conv.messages.slice();
}

function getActiveId(conv) {
    return conv ? conv.activeId : null;
}

function hasActive(conv) {
    return !!(conv && conv.activeId != null && _find(conv, conv.activeId));
}

function getActiveMessage(conv) {
    if (!conv || conv.activeId == null) return null;
    return _find(conv, conv.activeId);
}

// §3/§4: bounded conversation history for the AI request.
// Returns only prior turns — the message(s) before the most recent user message —
// filtered to user + completed assistant messages, bounded to `limit`, order preserved.
// The current user message is never part of history (the engine always sends it as the
// live query); see getContextMessages() for the full "history + current user" view.
function getHistory(conv, limit) {
    const n = (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_HISTORY_LIMIT;
    if (!conv || !Array.isArray(conv.messages)) return [];
    const msgs = conv.messages;
    let end = msgs.length;
    // cut at the most recent user message (exclusive)
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'user') { end = i; break; }
    }
    const out = [];
    for (let i = 0; i < end; i++) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'user') {
            out.push({ role: 'user', content: String(m.content || '') });
        } else if (m.role === 'assistant' && m.status === 'complete') {
            out.push({ role: 'assistant', content: String(m.content || '') });
        }
        // streaming/cancelled/error assistant turns are not sent as context
    }
    return _tailWindow(out, n);
}

// Full context view: prior history + the most recent user message (§4: current user
// message always included). Used for verification/tests and diagnostics.
function getContextMessages(conv, limit) {
    const hist = getHistory(conv, limit);
    const msgs = conv && Array.isArray(conv.messages) ? conv.messages : [];
    let lastUser = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === 'user') { lastUser = msgs[i]; break; }
    }
    if (!lastUser) return hist;
    const out = hist.slice();
    out.push({ role: 'user', content: String(lastUser.content || '') });
    return _tailWindow(out, limit > 0 ? limit : DEFAULT_HISTORY_LIMIT);
}

// P-trim: context-window trimming must never leave an orphan leading assistant turn
// (an assistant message whose paired user message was cut by the limit). Real histories
// start with a user message; after slicing the most recent `n`, if the window happens to
// begin on an assistant (odd cut), slide forward so the window starts on a user message.
function _tailWindow(messages, n) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    const limit = (typeof n === 'number' && n > 0) ? n : DEFAULT_HISTORY_LIMIT;
    if (messages.length <= limit) return messages.slice();
    let start = messages.length - limit;
    // n is odd -> window starts on an assistant whose user was trimmed: drop it so the
    // user/assistant turn pairing stays intact (never send an orphan assistant turn).
    while (start < messages.length && messages[start] && messages[start].role === 'assistant') {
        start++;
    }
    // degenerate: window would be entirely assistant(s) — keep at least one message
    if (start >= messages.length) start = messages.length - 1;
    return messages.slice(start);
}

// §12 rapid-send contract: cancel the active request (preserve partial as 'cancelled'),
// append the new user message, then open a fresh streaming assistant message.
// Returns { userMsgId, assistantId } or null when text is empty.
function rapidSend(conv, text) {
    const q = String(text || '').trim();
    if (!conv || !q) return null;
    cancelActive(conv);
    const userMsgId = appendUser(conv, q);
    const assistantId = appendAssistant(conv);
    return { userMsgId, assistantId };
}

// §13 reset: cancel active (keep partial visible? No — reset clears everything), clear all
// messages, active id, and sequence. Next request starts fresh.
function reset(conv) {
    if (!conv) return;
    conv.messages = [];
    conv.activeId = null;
    conv.seq = 0;
}

function _indexOf(conv, id) {
    if (!conv || !Array.isArray(conv.messages) || id == null) return -1;
    for (let i = 0; i < conv.messages.length; i++) {
        if (conv.messages[i] && conv.messages[i].id === id) return i;
    }
    return -1;
}

function findMessage(conv, id) {
    return _find(conv, id);
}

// Phase 9 §Edit: keep messages up to and including `id`, drop every later turn.
// The active request is cancelled first (its partial is preserved as 'cancelled', then
// dropped with the truncated tail) so no stale request can outlive the cut point.
function truncateAfter(conv, id) {
    const i = _indexOf(conv, id);
    if (i < 0) return false;
    cancelActive(conv);
    conv.messages = conv.messages.slice(0, i + 1);
    if (conv.activeId != null && _indexOf(conv, conv.activeId) < 0) conv.activeId = null;
    return true;
}

// Phase 9 §conditional-resend: pair a user message with the assistant message that
// answers it — the first assistant turn after it and before the next user turn. Each
// user message is judged by its OWN paired answer, never by a global "last request"
// state, so a failure on one turn never lights up Resend on another turn. Returns the
// assistant message object, or null when no paired answer exists yet (e.g. an edited
// message whose rewrite was never sent, or a dangling user message).
function getAssistantForUserMessage(conv, userMsgId) {
    if (!conv || !Array.isArray(conv.messages) || userMsgId == null) return null;
    const msgs = conv.messages;
    let idx = -1;
    for (let i = 0; i < msgs.length; i++) {
        if (msgs[i] && msgs[i].id === userMsgId) { idx = i; break; }
    }
    if (idx < 0 || !msgs[idx] || msgs[idx].role !== 'user') return null;
    for (let i = idx + 1; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'user') return null;
        if (m.role === 'assistant') return m;
    }
    return null;
}

// Phase 9 §Resend: remove `id` and everything after it (the target message itself is
// dropped too — the same text is re-appended as a fresh user message on resend).
function removeFrom(conv, id) {
    const i = _indexOf(conv, id);
    if (i < 0) return false;
    cancelActive(conv);
    conv.messages = conv.messages.slice(0, i);
    if (conv.activeId != null && _indexOf(conv, conv.activeId) < 0) conv.activeId = null;
    return true;
}

// Phase 9 §Edit send contract:
//   messages before the edited message
//   → edited user message (new content, same identity)
//   → fresh streaming assistant message
// Everything after the edited message is removed. Returns { userMsgId, assistantId }.
function editAndRestart(conv, userMsgId, newText) {
    const q = String(newText || '').trim();
    const m = _find(conv, userMsgId);
    if (!conv || !m || m.role !== 'user' || !q) return null;
    truncateAfter(conv, userMsgId);
    m.content = q;
    const assistantId = appendAssistant(conv);
    return { userMsgId: m.id, assistantId };
}

// Phase 9 §Resend contract:
//   messages before the target user message
//   → the same user message (fresh message, single copy)
//   → fresh streaming assistant message
// The target message and everything after it are removed first, so no duplicate user
// message can exist. Returns { userMsgId, assistantId }.
function resendFrom(conv, userMsgId) {
    const m = _find(conv, userMsgId);
    if (!conv || !m || m.role !== 'user') return null;
    const text = String(m.content || '').trim();
    if (!text) return null;
    removeFrom(conv, userMsgId);
    const newUser = appendUser(conv, text);
    const assistantId = appendAssistant(conv);
    return { userMsgId: newUser, assistantId };
}

function count(conv) {
    return conv && Array.isArray(conv.messages) ? conv.messages.length : 0;
}

module.exports = {
    createConversation,
    appendUser,
    appendAssistant,
    updateAssistant,
    completeAssistant,
    cancelAssistant,
    cancelActive,
    failAssistant,
    getMessages,
    getActiveId,
    getActiveMessage,
    hasActive,
    getHistory,
    getContextMessages,
    rapidSend,
    reset,
    count,
    findMessage,
    getAssistantForUserMessage,
    truncateAfter,
    removeFrom,
    editAndRestart,
    resendFrom,
    DEFAULT_HISTORY_LIMIT
};