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
    assert.ok(APPLET_SRC.includes('_entryRow.visible = !composerActive'), 'top search row fully hidden while composer active');
    assert.ok(APPLET_SRC.includes('ov._aiHeader.visible = composerActive'), 'chat header tied to conversation state');
});

// ---- Phase 9 §conditional-resend: per-message user→assistant pairing ----
test('getAssistantForUserMessage pairs each user message with its own answer', () => {
    const conv = completedConversation();
    const msgs = convMod.getMessages(conv);
    for (let i = 0; i < 3; i++) {
        const u = msgs[i * 2];
        const a = convMod.getAssistantForUserMessage(conv, u.id);
        assert.strictEqual(a.id, msgs[i * 2 + 1].id, 'U' + (i + 1) + ' pairs with A' + (i + 1));
        assert.strictEqual(a.status, 'complete');
    }
    // assistant ids are not valid user targets; unknown ids are null
    assert.strictEqual(convMod.getAssistantForUserMessage(conv, msgs[1].id), null);
    assert.strictEqual(convMod.getAssistantForUserMessage(conv, 'nope'), null);
    // a dangling user message (answer never started) has no pair
    const conv2 = completedConversation();
    const danglingId = convMod.appendUser(conv2, 'U4');
    assert.strictEqual(convMod.getAssistantForUserMessage(conv2, danglingId), null);
});

test('pairing is per-turn: a failed follow-up never flags earlier turns', () => {
    const convB = convMod.createConversation();
    const s1 = convMod.rapidSend(convB, 'U1');
    convMod.completeAssistant(convB, s1.assistantId, 'A1', []);
    const s2 = convMod.rapidSend(convB, 'U2');
    convMod.failAssistant(convB, s2.assistantId, { code: 'provider_error' });
    const msgs = convMod.getMessages(convB);
    // user A pairs with its own COMPLETE answer (no resend); user B with its ERROR
    assert.strictEqual(convMod.getAssistantForUserMessage(convB, msgs[0].id).status, 'complete');
    assert.strictEqual(convMod.getAssistantForUserMessage(convB, msgs[2].id).status, 'error');
});

test('cancelled answers pair but are not resend-eligible failures', () => {
    const conv = convMod.createConversation();
    const s1 = convMod.rapidSend(conv, 'U1');
    convMod.cancelAssistant(conv, s1.assistantId); // user pressed Cancel
    const u = convMod.getMessages(conv)[0];
    const pair = convMod.getAssistantForUserMessage(conv, u.id);
    assert.ok(pair, 'cancelled partial still pairs with its user message');
    assert.strictEqual(pair.status, 'cancelled');
    assert.notStrictEqual(pair.status, 'error', 'cancel is a user action, not a provider failure');
});

test('resend after an errored answer keeps prefix and drops only the failed turn', () => {
    const conv = convMod.createConversation();
    const s1 = convMod.rapidSend(conv, 'U1');
    convMod.completeAssistant(conv, s1.assistantId, 'A1', []);
    const s2 = convMod.rapidSend(conv, 'U2');
    convMod.updateAssistant(conv, s2.assistantId, 'partial');
    convMod.failAssistant(conv, s2.assistantId, { code: 'provider_error' });
    const msgs = convMod.getMessages(conv);
    const u2 = msgs[2];
    assert.strictEqual(convMod.getAssistantForUserMessage(conv, u2.id).status, 'error');
    const res = convMod.resendFrom(conv, u2.id);
    assert.ok(res);
    assert.deepStrictEqual(contents(conv), ['U1', 'A1', 'U2', '']);
    assert.strictEqual(convMod.getMessages(conv)[3].status, 'streaming', 'fresh retry streams');
    assert.strictEqual(userMsgs(conv).length, 2);
    assert.strictEqual(userMsgs(conv).filter(m => m.content === 'U2').length, 1, 'no duplicate user message');
    assert.strictEqual(convMod.getAssistantForUserMessage(conv, res.userMsgId).status, 'streaming');
});

test('applet wires per-message Copy/Edit and conditional Resend as small icon actions', () => {
    assert.ok(APPLET_SRC.includes('_beginEditUserMessage'), 'edit handler present');
    assert.ok(APPLET_SRC.includes('_resendUserMessage'), 'resend handler present');
    assert.ok(APPLET_SRC.includes('_copyUserMessageToClipboard'), 'copy handler present');
    assert.ok(APPLET_SRC.includes('_buildIconActionButton'), 'icon action button builder present');
    assert.ok(APPLET_SRC.includes('edit-copy-symbolic'), 'copy uses a symbolic icon');
    assert.ok(APPLET_SRC.includes('document-edit-symbolic'), 'edit uses a symbolic icon');
    assert.ok(APPLET_SRC.includes('view-refresh-symbolic'), 'resend uses a symbolic icon');
    assert.ok(APPLET_SRC.includes('_("Copy message")'), 'copy tooltip text');
    assert.ok(APPLET_SRC.includes('_("Edit message")'), 'edit tooltip text');
    assert.ok(APPLET_SRC.includes('_("Resend message")'), 'resend tooltip text');
    // copy must use the Cinnamon/GJS St.Clipboard API, never navigator.clipboard
    assert.ok(APPLET_SRC.includes('St.Clipboard.get_default()'), 'copy uses the Cinnamon St.Clipboard API');
    assert.ok(APPLET_SRC.includes('St.ClipboardType.CLIPBOARD'), 'copy targets the CLIPBOARD selection');
    // actions live only on user messages and never join keyboard row navigation
    assert.ok(APPLET_SRC.includes("msg.role === 'user'"), 'user branch exists');
    const userSection = APPLET_SRC.slice(APPLET_SRC.indexOf('_renderAIState'), APPLET_SRC.indexOf('_renderSourcesForMessage'));
    assert.ok(userSection.includes('_copyUserMessageToClipboard'), 'copy bound inside user row');
    assert.ok(userSection.includes('_beginEditUserMessage(uid)') || userSection.includes('_beginEditUserMessage'), 'edit bound inside user row');
    // resend is CONDITIONAL on this message's own paired answer failing — pairing is
    // resolved through conversationState, never global loading/error state
    assert.ok(userSection.includes('convMod.getAssistantForUserMessage'), 'pairing via conversationState');
    assert.ok(userSection.includes("paired === 'error'"), 'resend gated on the paired answer status');
    assert.ok(!(userSection.match(/_rows\.push\(/g) || []).length, 'conversation rows never enter keyboard _rows');
});

test('chat controls: single Stop/Send action slot, New Chat + Search switch in header', () => {
    assert.ok(APPLET_SRC.includes('Stop'), 'Stop label present');
    assert.ok(APPLET_SRC.includes('New Chat'), 'New Chat label present');
    assert.ok(APPLET_SRC.includes('ov._stopButton.visible = composerActive && active'), 'Stop gated on active request');
    assert.ok(APPLET_SRC.includes('ov._composerSend.visible = composerActive && !active'), 'Send hidden while request active (single action slot)');
    assert.ok(APPLET_SRC.includes('ov._resetButton.visible = composerActive'), 'New Chat gated on conversation');
    assert.ok(APPLET_SRC.includes('ov._aiComposer.visible = composerActive'), 'composer gated on conversation');
    assert.ok(APPLET_SRC.includes('convMod.reset(this._conversation)'), 'New Chat resets the message model');
    assert.ok(APPLET_SRC.includes('_aiHeader'), 'chat header container exists');
});

test('mode switch is a two-way door: header Search switch + safe AI->Search lifecycle', () => {
    assert.ok(APPLET_SRC.includes('_goToAiMode') && APPLET_SRC.includes('_goToSearchMode'), 'directional mode methods exist');
    assert.ok(APPLET_SRC.includes('_headerModeButton'), 'header mode switch exists');
    assert.ok(APPLET_SRC.includes('_goToSearchMode(); }'), 'header Search switch wired');
    // AI->Search must stop any active request and invalidate stale callbacks: gen bump
    // FIRST, engine cancel second (repo invariant), then model/UI cleanup
    const def = APPLET_SRC.slice(APPLET_SRC.indexOf('_goToSearchMode() {'), APPLET_SRC.indexOf('_goToSearchMode() {') + 1000);
    assert.ok(def.indexOf('this._aiGen++') !== -1, 'gen bumped on leave');
    assert.ok(def.indexOf('this._aiEngine.cancel()') !== -1, 'engine cancelled on leave');
    assert.ok(def.indexOf('this._aiGen++') < def.indexOf('this._aiEngine.cancel()'), 'gen bump BEFORE engine cancel');
    assert.ok(def.includes('_cancelAIScroll()'), 'scroll timer cleaned on leave');
    assert.ok(def.includes("this._mode = 'search'"), 'mode reset to search');
    assert.ok(def.includes('_deactivateComposerInput()'), 'composer/header hidden on leave');
    assert.ok(def.includes('convMod.cancelActive'), 'active AI request cancelled on leave');
    // conversation is preserved across mode switches (only New Chat resets it)
    assert.ok(APPLET_SRC.includes('_clearAIState()'), 'AI state clear helper exists');
    const clearDef = APPLET_SRC.slice(APPLET_SRC.indexOf('_clearAIState() {'), APPLET_SRC.indexOf('_clearAIState() {') + 200);
    assert.ok(!clearDef.includes('convMod.reset'), 'switching modes never resets the conversation');
    assert.ok(APPLET_SRC.includes("this._mode !== 'ai'") || APPLET_SRC.includes("this._mode === 'ai'"), 'mode-aware branching present');
});

test('layout: no expanded region, composer packs under the results panel', () => {
    assert.ok(APPLET_SRC.includes('no `expand: true`'), 'results region must not expand');
    assert.ok(APPLET_SRC.includes('ov._scroll.set_position(0, hdrH)'), 'scroll is offset below the chat header');
    assert.ok(APPLET_SRC.includes('resultsRegion.set_size(w, h)'), 'region sized to content');
    assert.ok(APPLET_SRC.includes('quicksearch-scroll-attached'), 'attached scroll styling toggled');
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

// Phase 15: sources are clickable on every runtime — the click handler must not
// depend on the global Web `URL` API (missing in some Cinnamon/GJS sandboxes, where
// `new URL()` throws and silently kills the click). Structural http(s) gate only.
test('source-row click is runtime-safe: no global URL dependency', () => {
    const start = APPLET_SRC.indexOf('_renderSourcesForMessage(ov, sources) {');
    assert.ok(start !== -1, '_renderSourcesForMessage definition exists');
    const section = APPLET_SRC.slice(start, start + 2600);
    assert.ok(!section.includes('new URL(trimmed'), 'click handler must not construct from the global URL API');
    assert.ok(section.includes('if (!/^https?:'), 'structural http(s) gate present');
    assert.ok(section.includes('launch_default_for_uri_async(trimmed'), 'Gio launch path intact');
});

test('action row keeps a clear consistent gap below every user text', () => {
    const actionsCss = CSS_SRC.slice(CSS_SRC.indexOf('.quicksearch-ai-msg-actions'), CSS_SRC.indexOf('.quicksearch-ai-msg-actions') + 400);
    assert.ok(actionsCss.includes('padding: 5px 0 3px 10px;'), 'explicit 5px top gap between text and action row');
    assert.ok(actionsCss.includes('spacing: 4px;'), '4px horizontal gap between action icons');
});

test('chat layout + message-action styling exists', () => {
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer'), 'composer surface style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer-entry'), 'follow-up entry style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-send'), 'send button style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-send-disabled'), 'send disabled style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-action-icon-btn'), 'small circular icon action style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-chat-header'), 'chat header style');
    assert.ok(CSS_SRC.includes('.quicksearch-scroll-attached'), 'scroll-attached style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-user-editing'), 'editing highlight style');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-composer-editrow'), 'edit hint row style');
    // normal user card must stay light (no strong block background)
    const userBlock = CSS_SRC.slice(CSS_SRC.indexOf('.quicksearch-ai-user-block'), CSS_SRC.indexOf('.quicksearch-ai-user-block') + 300);
    assert.ok(userBlock.includes('rgba(255, 255, 255, 0.0)'), 'normal user message near-transparent');
});

test('tooltips and lifecycle cleanup guards', () => {
    assert.ok(APPLET_SRC.includes('_attachTooltip'), 'tooltip helper present');
    assert.ok(APPLET_SRC.includes('TooltipsMod') && (APPLET_SRC.includes('imports.ui.tooltips')), 'tooltips module imported');
    assert.ok(APPLET_SRC.includes('_destroyTooltips'), 'tooltip cleanup present');
    assert.ok(APPLET_SRC.includes('_cancelAIScroll()'), 'applet cancels scroll timer on teardown paths');
    const closeSection = APPLET_SRC.slice(APPLET_SRC.indexOf('close() {'), APPLET_SRC.indexOf('close() {') + 1200);
    assert.ok(closeSection.includes('this._aiEditId = null'), 'close clears edit state');
    assert.ok(closeSection.includes('_cancelAIScroll()'), 'close cancels pending scroll');
    const removal = APPLET_SRC.slice(APPLET_SRC.indexOf('on_applet_removed_from_panel'), APPLET_SRC.indexOf('on_applet_removed_from_panel') + 600);
    assert.ok(removal.includes('_cancelAIScroll()'), 'removal cancels pending scroll');
});
