// Phase 9 — AI chat actions regression tests.
// Covers the conversation-model semantics behind Clear chat (§1), Cancel (§2),
// per-message Edit (§3), per-message Resend (§4), the bottom follow-up composer (§5),
// sticky auto-scroll (§6), message-action isolation (§7), footer state (§8) and the
// stale-callback guards shared with Phase 8 (§11). The Cinnamon/GJS UI itself cannot
// run under node, so the UI half of this file guards the applet source (the repo's
// established pattern) while the pure conversation model is exercised directly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const convMod = require('../ai/conversationState.js');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'stylesheet.css'), 'utf8');

// conv: [U1,A1, U2,A2, U3,A3] all completed
function completedConversation() {
    const conv = convMod.createConversation();
    for (let i = 1; i <= 3; i++) {
        const s = convMod.rapidSend(conv, 'U' + i);
        convMod.completeAssistant(conv, s.assistantId, 'A' + i, []);
    }
    return conv;
}

function roles(conv) {
    return convMod.getMessages(conv).map(m => m.role);
}

function contents(conv) {
    return convMod.getMessages(conv).map(m => m.content);
}

function userMsgs(conv) {
    return convMod.getMessages(conv).filter(m => m.role === 'user');
}

// ---- §3 Edit: middle message rewritten in place, later turns dropped ----
test('editAndRestart middle user message rewrites in place and drops later turns', () => {
    const conv = completedConversation();
    const msgs = convMod.getMessages(conv);
    const u2 = msgs[2]; // U2
    assert.strictEqual(u2.content, 'U2');
    const res = convMod.editAndRestart(conv, u2.id, 'U2 edited');
    assert.ok(res);
    assert.strictEqual(res.userMsgId, u2.id, 'edited message keeps its identity');
    const after = convMod.getMessages(conv);
    assert.deepStrictEqual(roles(conv), ['user', 'assistant', 'user', 'assistant']);
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2 edited', '']);
    assert.strictEqual(after[2].id, u2.id, 'same message object updated');
    assert.strictEqual(after[3].status, 'streaming');
    assert.ok(convMod.hasActive(conv));
    // no duplicate user message / no orphan turns
    assert.strictEqual(userMsgs(conv).length, 2);
    assert.strictEqual(userMsgs(conv).filter(m => m.content === 'U2').length, 0);
    // history sent to the engine = prefix only, edited msg excluded (it is the live query)
    const hist = convMod.getHistory(conv, 10);
    assert.deepStrictEqual(hist, [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' }
    ]);
});

// ---- §3 Edit: last user message ----
test('editAndRestart last user message regenerates only its own answer', () => {
    const conv = completedConversation();
    const last = userMsgs(conv).pop(); // U3
    const res = convMod.editAndRestart(conv, last.id, 'U3 fixed');
    assert.ok(res);
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2', 'A2', 'U3 fixed', '']);
    assert.deepStrictEqual(roles(conv), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.strictEqual(convMod.getMessages(conv)[5].status, 'streaming');
});

// ---- §3 Edit while a request is active: stale partial cannot survive ----
test('editAndRestart during active request drops the stale streaming turn', () => {
    const conv = completedConversation();
    const live = convMod.rapidSend(conv, 'U4'); // assistant streaming
    const staleId = live.assistantId;
    const msgs = convMod.getMessages(conv);
    const u2 = msgs[2];
    convMod.updateAssistant(conv, staleId, 'partial stale answer');
    const res = convMod.editAndRestart(conv, u2.id, 'U2 edited');
    assert.ok(res);
    // streaming tail (U3, A3, U4 + stale assistant) all removed
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2 edited', '']);
    // late update against the old request id can neither find nor mutate anything
    assert.strictEqual(convMod.updateAssistant(conv, staleId, 'LATE'), false);
    assert.strictEqual(convMod.completeAssistant(conv, staleId, 'LATE', []), false);
    assert.strictEqual(convMod.getMessages(conv)[3].content, '');
});

// ---- §4 Resend: first message ----
test('resendFrom first message restarts from scratch with a single user copy', () => {
    const conv = completedConversation();
    const first = userMsgs(conv)[0];
    const res = convMod.resendFrom(conv, first.id);
    assert.ok(res);
    const after = convMod.getMessages(conv);
    assert.strictEqual(after.length, 2);
    assert.strictEqual(after[0].role, 'user');
    assert.strictEqual(after[0].content, 'U1');
    assert.strictEqual(after[1].role, 'assistant');
    assert.strictEqual(after[1].status, 'streaming');
    assert.strictEqual(userMsgs(conv).filter(m => m.content === 'U1').length, 1, 'exactly one U1');
});

// ---- §4 Resend: middle message ----
test('resendFrom middle message keeps prefix and re-sends the target once', () => {
    const conv = completedConversation();
    const target = userMsgs(conv)[1]; // U2
    const res = convMod.resendFrom(conv, target.id);
    assert.ok(res);
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2', '']);
    assert.deepStrictEqual(roles(conv), ['user', 'assistant', 'user', 'assistant']);
    const users = userMsgs(conv);
    assert.strictEqual(users.length, 2);
    assert.strictEqual(users.filter(m => m.content === 'U2').length, 1, 'no duplicate user message');
    assert.strictEqual(users[1].id, res.userMsgId, 'fresh message id after drop+reappend');
    assert.strictEqual(convMod.getHistory(conv, 10).length, 2, 'history = U1/A1 only');
});

// ---- §4 Resend: last message (including a trailing unanswered user message) ----
test('resendFrom last user message works with and without a trailing assistant', () => {
    // with trailing assistant
    const conv = completedConversation();
    const last = userMsgs(conv).pop();
    convMod.resendFrom(conv, last.id);
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2', 'A2', 'U3', '']);

    // dangling user message (no assistant yet)
    const conv2 = completedConversation();
    const danglingId = convMod.appendUser(conv2, 'U4');
    assert.strictEqual(convMod.getMessages(conv2).length, 7);
    const res = convMod.resendFrom(conv2, danglingId);
    assert.ok(res);
    assert.strictEqual(convMod.getMessages(conv2).length, 8);
    assert.deepStrictEqual(contents(conv2), ['U1', 'A1', 'U2', 'A2', 'U3', 'A3', 'U4', '']);
    assert.strictEqual(userMsgs(conv2).filter(m => m.content === 'U4').length, 1);
});

// ---- §1 Clear chat == reset: no old messages / sources / active id survive ----
test('reset clears messages, active request, and stale partial (Clear chat)', () => {
    const conv = completedConversation();
    const live = convMod.rapidSend(conv, 'U4');
    convMod.updateAssistant(conv, live.assistantId, 'partial');
    convMod.reset(conv);
    assert.strictEqual(convMod.count(conv), 0);
    assert.strictEqual(convMod.hasActive(conv), false);
    assert.strictEqual(convMod.getActiveId(conv), null);
    // a late callback targeting the old assistant id is a no-op
    assert.strictEqual(convMod.updateAssistant(conv, live.assistantId, 'LATE'), false);
    assert.strictEqual(convMod.count(conv), 0);
});

// ---- edit/resend invalid targets are safe no-ops ----
test('editAndRestart / resendFrom reject invalid targets', () => {
    const conv = completedConversation();
    assert.strictEqual(convMod.editAndRestart(conv, 'nope', 'x'), null);
    assert.strictEqual(convMod.editAndRestart(conv, userMsgs(conv)[0].id, '   '), null, 'empty edit rejected');
    assert.strictEqual(convMod.resendFrom(conv, 'nope'), null);
    assert.strictEqual(convMod.resendFrom(conv, convMod.getMessages(conv)[1].id), null, 'assistant target rejected');
    assert.strictEqual(convMod.count(conv), 6, 'no mutation on failure');
});

// ---- applet source guards ----

test('applet wires the bottom follow-up composer', () => {
    assert.ok(APPLET_SRC.includes('_aiComposer'), 'composer container exists');
    assert.ok(APPLET_SRC.includes('_composerEntry'), 'follow-up entry exists');
    assert.ok(APPLET_SRC.includes('_composerSend'), 'send button exists');
    assert.ok(APPLET_SRC.includes('_onComposerSend'), 'send handler wired');
    assert.ok(APPLET_SRC.includes('_onComposerKeyPress'), 'composer keyboard handler wired');
    assert.ok(APPLET_SRC.includes('Ask a follow-up'), 'composer hint present');
    // composer is the only input once a conversation exists
    assert.ok(APPLET_SRC.includes('_activateComposerInput') && APPLET_SRC.includes('_deactivateComposerInput'), 'input-mode switchers present');
    assert.ok(APPLET_SRC.includes('_entry.reactive = !composerActive'), 'top entry inert while composer active');
});

test('applet wires per-message Edit and Resend with click isolation', () => {
    assert.ok(APPLET_SRC.includes('_beginEditUserMessage'), 'edit handler present');
    assert.ok(APPLET_SRC.includes('_resendUserMessage'), 'resend handler present');
    assert.ok(APPLET_SRC.includes('_buildMessageActionButton'), 'action button builder present');
    assert.ok(APPLET_SRC.includes('_("Edit")') || APPLET_SRC.includes("_('Edit')"), 'Edit label');
    assert.ok(APPLET_SRC.includes('_("Resend")') || APPLET_SRC.includes("_('Resend')"), 'Resend label');
    // actions live only on user messages and never join keyboard row navigation
    assert.ok(APPLET_SRC.includes("msg.role === 'user'"), 'user branch exists');
    const userSection = APPLET_SRC.slice(APPLET_SRC.indexOf('_renderAIState'), APPLET_SRC.indexOf('_renderSourcesForMessage'));
    assert.ok(userSection.includes('_beginEditUserMessage(uid)') || userSection.includes('_beginEditUserMessage'), 'edit bound inside user row');
    assert.ok(!(userSection.match(/_rows\.push\(/g) || []).length, 'conversation rows never enter keyboard _rows');
});

test('footer state: Cancel only while active, Clear chat only when conversation exists', () => {
    assert.ok(APPLET_SRC.includes('_("\\u23f9 Cancel")') || APPLET_SRC.includes('Cancel'), 'Cancel label');
    assert.ok(APPLET_SRC.includes('_("\\u21ba Clear chat")') || APPLET_SRC.includes('Clear chat'), 'Clear chat label');
    assert.ok(APPLET_SRC.includes('ov._stopButton.visible = isAi && hasConv && active'), 'Cancel gated on active request');
    assert.ok(APPLET_SRC.includes('ov._resetButton.visible = isAi && hasConv'), 'Clear chat gated on conversation');
    assert.ok(APPLET_SRC.includes('ov._aiComposer.visible = isAi && hasConv'), 'composer gated on conversation');
    assert.ok(APPLET_SRC.includes('convMod.reset(this._conversation)'), 'clear resets the message model');
});

test('edit/resend staging goes through conversationState (single source of truth)', () => {
    assert.ok(APPLET_SRC.includes('convMod.editAndRestart'), 'edit staged via conversationState');
    assert.ok(APPLET_SRC.includes('convMod.resendFrom'), 'resend staged via conversationState');
    assert.ok(APPLET_SRC.includes('_runAIRequestStream'), 'shared streaming runner exists');
    assert.ok(APPLET_SRC.includes('convMod.updateAssistant'), 'chunks still update the single assistant message');
});

test('stale-callback guards survive the Phase 9 rework', () => {
    assert.ok(APPLET_SRC.includes('_aiGen'), 'generation counter present');
    assert.ok(APPLET_SRC.includes('myGen !== this._aiGen'), 'gen guard present');
    assert.ok(APPLET_SRC.includes("this._mode !== 'ai'"), 'mode guard present');
    assert.ok(APPLET_SRC.includes("code === 'cancelled'"), 'cancelled filter present');
    assert.ok(APPLET_SRC.includes('this._aiEngine.cancel()'), 'engine cancel present in close');
    assert.ok(APPLET_SRC.includes('this._aiGen++'), 'gen bump present');
    const stopDef = APPLET_SRC.indexOf('_stopAI() {');
    assert.ok(stopDef !== -1, '_stopAI() { method exists');
    const stopSection = APPLET_SRC.slice(stopDef, stopDef + 900);
    assert.ok(stopSection.indexOf('this._aiGen++') !== -1 && stopSection.indexOf('this._aiEngine.cancel()') !== -1, 'Cancel contains gen bump + engine cancel');
    assert.ok(stopSection.indexOf('this._aiGen++') < stopSection.indexOf('this._aiEngine.cancel()'), 'Cancel bumps gen BEFORE engine cancel');
    const resetDef = APPLET_SRC.indexOf('_resetConversation() {');
    assert.ok(resetDef !== -1, '_resetConversation() { method exists');
    const resetSection = APPLET_SRC.slice(resetDef, resetDef + 900);
    assert.ok(resetSection.indexOf('this._aiGen++') !== -1 && resetSection.indexOf('this._aiEngine.cancel()') !== -1, 'Clear chat contains gen bump + engine cancel');
    assert.ok(resetSection.indexOf('this._aiGen++') < resetSection.indexOf('this._aiEngine.cancel()'), 'Clear chat bumps gen BEFORE engine cancel');
});

test('sticky auto-scroll: follow only while near the bottom', () => {
    assert.ok(APPLET_SRC.includes('_aiStickBottom'), 'stick state exists');
    assert.ok(APPLET_SRC.includes('notify::value'), 'user-scroll tracking bound to adjustment');
    assert.ok(APPLET_SRC.includes('upper - ps - val') || APPLET_SRC.includes('upper - page_size'), 'near-bottom detection present');
    assert.ok(APPLET_SRC.includes('_scheduleAIScroll'), 'deferred scroll scheduler present');
    assert.ok(APPLET_SRC.includes('_scrollAIMessageIntoView'), 'scroll-to-message present (Edit/Resend)');
    assert.ok(APPLET_SRC.includes('_cancelAIScroll'), 'scroll timer cleanup present');
});

test('composer + message-action styling exists', () => {
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer'), 'composer surface style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer-entry'), 'follow-up entry style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-send'), 'send button style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-send-disabled'), 'send disabled style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-msg-action'), 'message action style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-user-editing'), 'editing highlight style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer-editrow'), 'edit hint row style');
});

test('lifecycle cleanup guards', () => {
    assert.ok(APPLET_SRC.includes('_cancelAIScroll()'), 'applet cancels scroll timer on teardown paths');
    const closeSection = APPLET_SRC.slice(APPLET_SRC.indexOf('close() {'), APPLET_SRC.indexOf('close() {') + 1200);
    assert.ok(closeSection.includes('this._aiEditId = null'), 'close clears edit state');
    assert.ok(closeSection.includes('_cancelAIScroll()'), 'close cancels pending scroll');
    const removal = APPLET_SRC.slice(APPLET_SRC.indexOf('on_applet_removed_from_panel'), APPLET_SRC.indexOf('on_applet_removed_from_panel') + 600);
    assert.ok(removal.includes('_cancelAIScroll()'), 'removal cancels pending scroll');
});
