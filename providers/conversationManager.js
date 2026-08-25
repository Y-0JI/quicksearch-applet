// ConversationManager: in-memory multi-turn history for ASK AI (Phase 4.5).
// Pure CJS module: runs under Cinnamon GJS AND node --test.
//
// maxTurns means PAIRS of turns: maxTurns = 8 allows at most
// 8 user + 8 assistant messages (16 messages total) to be sent as context.
// Older messages are trimmed FIFO so requests never grow unbounded.
//
// "Thinking..." loading state is a UI-only concept and never enters history.
// A failed request rolls back its user message so prior history stays intact.

function createConversationManager(opts) {
    opts = opts || {};
    // maxTurns = maximum user+assistant PAIRS kept as context
    const maxTurns = Math.max(1, Number(opts.maxTurns) || 8);
    const maxMessages = maxTurns * 2;

    let msgs = []; // [{role: 'user'|'assistant', content: string}]

    function _trim() {
        return msgs.slice(-maxMessages);
    }

    // messages to send for a new question (history + the question itself)
    function buildMessages(question) {
        const out = _trim().map(m => ({ role: m.role, content: m.content }));
        const q = String(question == null ? '' : question).trim();
        if (q) out.push({ role: 'user', content: q });
        return out;
    }

    function addUser(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return false;
        msgs.push({ role: 'user', content: t });
        return true;
    }

    function addAssistant(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return false;
        msgs.push({ role: 'assistant', content: t });
        return true;
    }

    function popLast() {
        return msgs.pop() || null;
    }

    // send(question, askFn, cb): askFn(question, {messages}, cb)
    // success -> assistant turn recorded, cb(null, res)
    // failure -> the user turn is rolled back, cb(err) with history intact
    function send(question, askFn, cb) {
        if (typeof askFn !== 'function') { cb({ error: 'no-ask-fn' }); return; }
        const q = String(question == null ? '' : question).trim();
        if (!q) { cb({ error: 'empty-question' }); return; }

        addUser(q);
        const messages = _trim(); // includes this question as the last message
        askFn(q, { messages: messages }, (err, res) => {
            if (err) {
                // rollback: a failed exchange must not pollute history
                const last = msgs[msgs.length - 1];
                if (last && last.role === 'user' && last.content === q) msgs.pop();
                cb(err);
                return;
            }
            const answer = res && res.answer != null ? String(res.answer) : '';
            addAssistant(answer);
            cb(null, res);
        });
    }

    function clear() { msgs = []; }
    function size() { return msgs.length; }
    function history() { return msgs.map(m => ({ role: m.role, content: m.content })); }

    return { send, buildMessages, addUser, addAssistant, popLast, clear, size, history, maxTurns };
}

module.exports = { createConversationManager };
