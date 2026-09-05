const Applet = require('ui.applet');
const Main = require('ui.main');
const ModalDialog = require('ui.modalDialog');
const Settings = require('ui.settings');
const St = require('gi.St');
const Clutter = require('gi.Clutter');
const Gio = require('gi.Gio');
const GLib = require('gi.GLib');
const GObject = require('gi.GObject');
const Pango = require('gi.Pango');
let FileUtils = null, Util = null, AppFavorites = null, Mainloop = null;
try { FileUtils = imports.misc.fileUtils; } catch (e) {}
try { Util = imports.misc.util; } catch (e) {}
try { AppFavorites = imports.ui.appFavorites; } catch (e) {}
try { Mainloop = imports.mainloop; } catch (e) { try { Mainloop = require('mainloop'); } catch (e2) {} }
let TooltipsMod = null;
try { TooltipsMod = imports.ui.tooltips; } catch (e) {}
try { if (!TooltipsMod && typeof require === 'function') { try { TooltipsMod = require('ui.tooltips'); } catch (e2) {} } } catch (e) {}

const resultMod = require('./result.js');
const utilsMod = require('./utils.js');
const appProviderMod = require('./providers/appProvider.js');
const fileProviderMod = require('./providers/fileProvider.js');
const webProviderMod = require('./providers/webProvider.js');
const urlProviderMod = require('./providers/urlProvider.js');
const calculatorProviderMod = require('./providers/calculatorProvider.js');
const searchEngineMod = require('./searchEngine.js');
const contextActionsMod = require('./providers/contextActions.js');
const fileLauncherMod = require('./providers/fileLauncher.js');
let aiFactoryMod = null;
try { aiFactoryMod = require('./ai/aiFactory.js'); } catch (e) {}
let convMod = null;
try { convMod = require('./ai/conversationState.js'); } catch (e) {}
let mdMod = null;
try {
    mdMod = require('./ai/markdownRenderer.js');
} catch (mdErr) {
    // Never silent: if the renderer is missing/broken the applet falls back to plain
    // text (no crash), but the failure must be diagnosable — raw ** markdown returning
    // to the UI is otherwise indistinguishable from a rendering bug.
    try {
        global.log("[quicksearch@yoji] markdown renderer load FAILED (AI answers will fall back to plain text): " +
            String(mdErr && mdErr.message || mdErr) +
            " stack=" + String(mdErr && mdErr.stack || '').slice(0, 600));
    } catch (logErr) {}
}

const UUID = "quicksearch@yoji";

// i18n: bind UUID domain so _("Mau cari apa") picks locale from ~/.local/share/locale
try { imports.gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale"); } catch (e) {}
function _(str) {
    try {
        const t = imports.gettext.dgettext(UUID, str);
        if (t && t !== str) return t;
    } catch (e) {}
    try { return imports.gettext.gettext(str); } catch (e2) {}
    return str;
}

const RECENT_MAX = 15;

// UI/UX redesign (ADVANCED_SEARCH_AI_UIUX_REDESIGN): single source of truth for the
// adaptive layout. Presentation only — search/AI ranking + logic stay untouched.
const LAYOUT = {
    topPad: 120,        // dialog top padding (px) — keeps the pill floating near the top
    pillH: 54,          // search pill nominal height (px)
    filterH: 34,        // category filter row height (px) when visible
    hintsH: 22,         // keyboard hints bar height (px) when visible
    maxResultsH: 664    // hard cap for the results/chat panel height (px)
};

const FALLBACK_URLS = {
    ddgo: q => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
    google: q => 'https://www.google.com/search?q=' + encodeURIComponent(q),
    bing: q => 'https://www.bing.com/search?q=' + encodeURIComponent(q)
};

const QuickSearchOverlay = GObject.registerClass(
class QuickSearchOverlay extends ModalDialog.ModalDialog {
    constructor(applet) {
        super({ styleClass: "quicksearch-dialog", destroyOnClose: false });

        this._applet = applet;

        this._entry = new St.Entry({
            hint_text: _("Mau cari apa"),
            can_focus: true,
            track_hover: true,
            style_class: "quicksearch-entry"
        });
        this._entry.clutter_text.set_cursor_visible(true);
        const entryRow = new St.BoxLayout({ style_class: "quicksearch-entry-row" });
        this._entryRow = entryRow;
        // UI-1: leading search icon inside the pill (launcher identity). P1-3: each
        // new optional widget is isolated — a runtime failure logs instead of silently
        // killing the whole overlay (which would make the searchbox never appear).
        try {
            this._searchIcon = new St.Icon({
                icon_name: "system-search",
                icon_size: 14,
                icon_type: St.IconType.SYMBOLIC,
                style_class: "quicksearch-search-icon"
            });
            entryRow.add(this._searchIcon);
        } catch (e) {
            try { global.log("[quicksearch@yoji] search icon init failed: " + e); } catch (e2) {}
        }
        entryRow.add(this._entry, { expand: true });
        // AI mode control lives inside the existing searchbox pill (Phase AI-4).
        // Single overlay, single searchbox — toggle does not create a second searchbox.
        this._modeButton = new St.Button({
            style_class: "quicksearch-mode-button",
            can_focus: false,
            reactive: true,
            track_hover: true
        });
        const _modeIcon = new St.Icon({
            icon_name: "system-search",
            icon_size: 14,
            icon_type: St.IconType.SYMBOLIC,
            style_class: "quicksearch-mode-icon"
        });
        const _modeLabel = new St.Label({
            text: _("\u2728 Mode AI"),
            style_class: "quicksearch-mode-label"
        });
        const _modeContent = new St.BoxLayout({ style_class: "quicksearch-mode-content", vertical: false });
        _modeContent.add(_modeIcon);
        _modeContent.add(_modeLabel);
        this._modeButton.set_child(_modeContent);
        this._modeIcon = _modeIcon;
        this._modeLabel = _modeLabel;
        entryRow.add(this._modeButton);
        // UI-1: compact close button at the right of the search pill (✕)
        try {
            this._closeButton = new St.Button({
                style_class: "quicksearch-close-button",
                can_focus: false,
                reactive: true,
                track_hover: true
            });
            const _closeLabel = new St.Label({ text: _("\u2715"), style_class: "quicksearch-close-button-label" });
            try { this._closeButton.set_child(_closeLabel); } catch (e) {}
            entryRow.add(this._closeButton);
            this._closeButton.connect("clicked", () => {
                try { this._applet.close(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
        } catch (e) {
            try { global.log("[quicksearch@yoji] close button init failed: " + e); } catch (e2) {}
        }
        try {
            this._modeButton.connect("clicked", () => {
                try { this._applet._toggleMode(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
        } catch (e) {}
        this.contentLayout.add_style_class_name("quicksearch-content");
        this.contentLayout.add(entryRow);

        // UI-2: horizontal category filter chips (Search mode only, hidden while idle).
        // Presentation-only: switching a chip re-renders the ALREADY ranked result set
        // through a type filter — ranking/Best Match logic is never re-run.
        // P2-1: the chips live inside a horizontal ScrollView so a narrow panel / high
        // DPI / font scaling can never push them out of the container — all categories
        // stay reachable via horizontal overflow instead of a second nav layer.
        // P1-3: the filter row is optional UI — if ANY step fails on this Cinnamon/GJS
        // runtime (unsupported property, layout manager quirk, actor parenting), log it
        // and continue: the searchbox must still open. All consumers guard on
        // _filterRow/_filterScroll/_filterButtons existing, so a partial init is safe.
        this._filterButtons = [];
        try {
            this._filterRow = new St.BoxLayout({ style_class: "quicksearch-filter-row", vertical: false, visible: false, x_expand: false });
            this._filterScroll = new St.ScrollView({
                style_class: "quicksearch-filter-scroll",
                x_fill: true, y_fill: false,
                clip_to_allocation: true,
                visible: false
            });
            try { this._filterScroll.set_policy(St.PolicyType.AUTOMATIC, St.PolicyType.NEVER); } catch (e) {}
            const _categories = [
                ["all", _("All")],
                ["app", _("Apps")],
                ["file", _("Files")],
                ["folder", _("Folders")],
                ["web", _("Web")]
            ];
            for (let ci = 0; ci < _categories.length; ci++) {
                const catId = _categories[ci][0];
                const catLabel = _categories[ci][1];
                const btn = new St.Button({ style_class: "quicksearch-filter-chip", can_focus: false, reactive: true, track_hover: true });
                const lbl = new St.Label({ text: catLabel, style_class: "quicksearch-filter-chip-label" });
                try { btn.set_child(lbl); } catch (e) {}
                btn.connect("clicked", () => {
                    try { this._applet._setCategory(catId); } catch (e) {}
                    return Clutter.EVENT_STOP;
                });
                this._filterButtons.push({ id: catId, button: btn, label: lbl });
                this._filterRow.add(btn);
            }
            try { this._filterScroll.add_actor(this._filterRow); } catch (e) { try { this._filterScroll.add_child(this._filterRow); } catch (e2) {} }
            this.contentLayout.add(this._filterScroll);
        } catch (e) {
            try { global.log("[quicksearch@yoji] category filter row init failed: " + e); } catch (e2) {}
        }
        this._caretBlinkId = 0;
        this._caretVisible = true;
        this._blinkEntry = this._entry;

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this._scroll = new St.ScrollView({
            style_class: "quicksearch-results",
            x_fill: false, y_fill: false,
            y_align: St.Align.START
        });
        this._scroll.add_actor(this.resultsBox);
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.resultsRegion = new St.Widget({ x_expand: true });
        // NOTE: no `expand: true` — the region must size itself to the results/chat
        // content so the follow-up composer packs directly below the panel instead of
        // being pushed to the bottom of the screen by an expanded layout allotment.
        this.contentLayout.add(this.resultsRegion, {
            x_fill: true, y_fill: false,
            x_align: St.Align.MIDDLE, y_align: St.Align.START
        });
        this.resultsRegion.add_actor(this._scroll);

        this.autoCompleteBox = new St.BoxLayout({ vertical: true });
        this._autoScroll = new St.BoxLayout({
            vertical: true,
            style_class: "quicksearch-results quicksearch-autocomplete",
            clip_to_allocation: true,
            visible: false
        });
        this._autoScroll.add_actor(this.autoCompleteBox);
        this.resultsRegion.add_actor(this._autoScroll);

        // Phase 9 chat layout: once a conversation exists the top search row is hidden
        // and replaced by a chat panel = [header(+New Chat) / conversation / composer].
        // The composer sits directly under the results panel — the region above is NOT
        // expanded so nothing gets pushed to the bottom of the screen (issue #1/#7).
        // Note: build explicit St.Label children (set_child) — the St.Button `label:`
        // constructor property is not used anywhere in this codebase and renders empty
        // in this GJS runtime.
        this._aiComposer = new St.BoxLayout({ style_class: "quicksearch-ai-composer", vertical: true, visible: false });
        // edit-in-progress hint row (shown while an earlier user message is being edited)
        this._aiEditRow = new St.BoxLayout({ style_class: "quicksearch-ai-composer-editrow", vertical: false, visible: false });
        this._aiEditLabel = new St.Label({ text: _("Editing message..."), style_class: "quicksearch-ai-composer-editlabel" });
        this._aiEditCancel = new St.Button({ style_class: "quicksearch-ai-composer-editcancel", can_focus: false, reactive: true, track_hover: true });
        const _editCancelLabel = new St.Label({ text: _("\u2715"), style_class: "quicksearch-ai-composer-editcancel-label" });
        try { this._aiEditCancel.set_child(_editCancelLabel); } catch (e) {}
        this._aiEditRow.add(this._aiEditLabel, { expand: true });
        this._aiEditRow.add(this._aiEditCancel);
        this._aiComposer.add(this._aiEditRow);
        // follow-up composer row: entry + [Cancel while streaming] + Send
        this._composerRow = new St.BoxLayout({ style_class: "quicksearch-ai-composer-row", vertical: false });
        this._composerEntry = new St.Entry({
            hint_text: _("Ask a follow-up..."),
            can_focus: true,
            track_hover: true,
            style_class: "quicksearch-ai-composer-entry"
        });
        try { this._composerEntry.clutter_text.set_cursor_visible(true); } catch (e) {}
        this._stopButton = new St.Button({ style_class: "quicksearch-ai-stop", can_focus: false, reactive: true, track_hover: true, visible: false });
        const _stopLabel = new St.Label({ text: _("\u23f9 Stop"), style_class: "quicksearch-ai-stop-label" });
        try { this._stopButton.set_child(_stopLabel); } catch (e) {}
        this._composerSend = new St.Button({ style_class: "quicksearch-ai-send", can_focus: false, reactive: false, track_hover: true });
        const _sendLabel = new St.Label({ text: _("Send"), style_class: "quicksearch-ai-send-label" });
        try { this._composerSend.set_child(_sendLabel); } catch (e) {}
        // UI-3: compact “+” prefix before the follow-up entry (AI-tool feel, not a chat app)
        try {
            this._composerPlus = new St.Icon({ icon_name: "list-add-symbolic", icon_size: 12, icon_type: St.IconType.SYMBOLIC, style_class: "quicksearch-ai-composer-plus" });
            this._composerRow.add(this._composerPlus);
        } catch (e) {
            try { global.log("[quicksearch@yoji] composer plus icon init failed: " + e); } catch (e2) {}
        }
        this._composerRow.add(this._composerEntry, { expand: true });
        this._composerRow.add(this._stopButton);
        this._composerRow.add(this._composerSend);
        this._aiComposer.add(this._composerRow);
        // UI-4: context-aware keyboard hints bar (subtle, under the panel area)
        try {
            this._hintsLabel = new St.Label({ text: "", style_class: "quicksearch-hints", visible: false });
            this.contentLayout.add(this._hintsLabel);
        } catch (e) {
            try { global.log("[quicksearch@yoji] hints bar init failed: " + e); } catch (e2) {}
        }
        this.contentLayout.add(this._aiComposer);
        // conversation header pinned above the results panel (chat mode only): [+ New Chat]
        this._aiHeader = new St.BoxLayout({ style_class: "quicksearch-ai-chat-header", vertical: false, visible: false });
        // Phase 15: the header lives above the conversation in AI chat mode, so it is
        // ALWAYS reachable (streaming, follow-up composer, edit mode) — this is how the
        // user gets back to normal Search without closing the applet or New Chat. The
        // entry-row pill alone cannot do that: it is hidden as soon as a conversation
        // starts (bug: no way back to Search Mode).
        this._headerModeButton = new St.Button({ style_class: "quicksearch-ai-header-mode", can_focus: false, reactive: true, track_hover: true });
        const _hmIcon = new St.Icon({ icon_name: "system-search", icon_size: 12, icon_type: St.IconType.SYMBOLIC, style_class: "quicksearch-ai-header-mode-icon" });
        const _hmLabel = new St.Label({ text: _("Search"), style_class: "quicksearch-ai-header-mode-label" });
        const _hmContent = new St.BoxLayout({ style_class: "quicksearch-ai-header-mode-content", vertical: false });
        try { _hmContent.add(_hmIcon); } catch (e) {}
        try { _hmContent.add(_hmLabel); } catch (e) {}
        try { this._headerModeButton.set_child(_hmContent); } catch (e) {}
        this._resetButton = new St.Button({ style_class: "quicksearch-ai-reset", can_focus: false, reactive: true, track_hover: true });
        const _newLabel = new St.Label({ text: _("\u271a New Chat"), style_class: "quicksearch-ai-reset-label" });
        try { this._resetButton.set_child(_newLabel); } catch (e) {}
        const _headerGap = new St.Widget({ x_expand: true, y_expand: false });
        this._aiHeader.add(this._headerModeButton);
        this._aiHeader.add(_headerGap, { expand: true });
        this._aiHeader.add(this._resetButton);
        this.resultsRegion.add_actor(this._aiHeader);
        try { if (this._applet && this._applet._attachTooltip) this._applet._attachTooltip(this._resetButton, _("New Chat")); } catch (e) {}
        try { if (this._applet && this._applet._attachTooltip) this._applet._attachTooltip(this._headerModeButton, _("Switch to search mode")); } catch (e) {}
        try { if (this._applet && this._applet._attachTooltip) this._applet._attachTooltip(this._stopButton, _("Stop generating")); } catch (e) {}
        try { global.log("[quicksearch@yoji] Phase 9 chat layout init ok (header/search-switch/new-chat/composer)"); } catch (e) {}
        try {
            this._stopButton.connect("clicked", () => {
                try { this._applet._stopAI(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._headerModeButton.connect("clicked", () => {
                try { this._applet._goToSearchMode(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._resetButton.connect("clicked", () => {
                try { this._applet._resetConversation(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._aiEditCancel.connect("clicked", () => {
                try { this._applet._cancelEdit(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._composerSend.connect("clicked", () => {
                try { this._applet._onComposerSend(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._composerEntry.clutter_text.connect("text-changed", () => {
                try { this._applet._onComposerChanged(); } catch (e) {}
            });
            this._composerEntry.clutter_text.connect("key-press-event", (actor, event) => {
                try { return this._applet._onComposerKeyPress(event); } catch (e) { return Clutter.EVENT_PROPAGATE; }
            });
            this._composerEntry.connect("key-focus-in", () => this._startCaretBlink(this._composerEntry));
            this._composerEntry.connect("key-focus-out", () => this._stopCaretBlink(this._composerEntry));
        } catch (e) {}

        // dedicated popup layer for context menu — must be above the
        // lightbox shade and not clipped by ScrollView / Dialog.
        // Lightbox tracks direct children of the Modal and lowers any new
        // direct child below its shade, so the layer is inserted inside
        // backgroundStack (child of the highlighted _backgroundBin) where
        // Lightbox does not intervene. Use a fixed layout for absolute
        // positioning; fill the monitor work area via the parent bin.
        this._contextLayer = new St.Widget({
            reactive: false,
            visible: true,
            clip_to_allocation: false,
            layout_manager: new Clutter.FixedLayout()
        });
        let _layerOk = false;
        try { this.backgroundStack.add_actor(this._contextLayer); _layerOk = true; } catch (e) {}
        if (!_layerOk) { try { this._backgroundBin.add_actor(this._contextLayer); _layerOk = true; } catch (e2) {} }
        if (!_layerOk) { try { this.add_actor(this._contextLayer); } catch (e3) {} }
        // let the layer fill its parent (backgroundStack / work area)
        try {
            this._contextLayer.set_position(0, 0);
            this._contextLayer.set_size(global.screen_width || 1920, global.screen_height || 1080);
        } catch (e) {}
        // keep the layer above the dialog content inside backgroundStack
        try { this._contextLayer.raise_top(); } catch (e) {}
        // if we fell back to a direct child of the Modal, undo Lightbox lowering
        try {
            if (this._lightbox && this._lightbox.actor && this._contextLayer.get_parent() === this) {
                this._lightbox.actor.lower(this._contextLayer);
                this._contextLayer.raise_top();
            }
        } catch (e) {}

        this._entryRow.reactive = true;
        this._autoScroll.reactive = true;
        this._hoverIds = [];
        for (const [actor, key] of [
            [this._entryRow, "_ptrInEntry"],
            [this._autoScroll, "_ptrInPopup"]
        ]) {
            this._hoverIds.push(actor.connect("enter-event", () => this._applet._notePointer(key, true)));
            this._hoverIds.push(actor.connect("leave-event", () => this._applet._notePointer(key, false)));
        }
        this._keyFocusIds = [];

        // caret blink: 530ms toggle when entry has key focus
        this._keyFocusIds.push(this._entry.connect("key-focus-in", () => this._startCaretBlink()));
        this._keyFocusIds.push(this._entry.connect("key-focus-out", () => this._stopCaretBlink()));
        this._entry.clutter_text.connect("text-changed", (actor) => {
            // reset to visible on typing so caret doesn't hide mid-type
            this._caretVisible = true;
            try { this._entry.clutter_text.set_cursor_visible(true); } catch (e) {}
            this._applet.onTextChanged(actor.get_text());
        });

        this._entry.clutter_text.connect("key-press-event", (actor, event) => {
            return this._applet.onKeyPress(event);
        });

        if (this._lightbox && this._lightbox.actor) {
            this._outsideClickId = this._lightbox.actor.connect("button-press-event", () => {
                if (this._applet._contextMenu && this._applet._contextMenu.isVisible()) { this._applet._contextMenu.hide(); return Clutter.EVENT_STOP; }
                this._applet.close();
                return Clutter.EVENT_STOP;
            });
        } else {
            this._outsideClickId = this._backgroundBin.connect("button-press-event", (actor, event) => {
                if (this._applet._contextMenu && this._applet._contextMenu.isVisible()) { this._applet._contextMenu.hide(); return Clutter.EVENT_STOP; }
                const [gx, gy] = event.get_coords();
                if (!this._isInsideDialog(gx, gy)) {
                    this._applet.close();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    // Phase 9: caret blink is bound to whichever entry currently owns keyboard focus
    // (top entry while the conversation is empty, bottom follow-up composer afterwards).
    _startCaretBlink(entry) {
        this._stopCaretBlink();
        this._blinkEntry = entry || this._entry;
        if (!this._blinkEntry) return;
        this._caretVisible = true;
        try { this._blinkEntry.clutter_text.set_cursor_visible(true); } catch (e) {}
        this._caretBlinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 530, () => {
            this._caretVisible = !this._caretVisible;
            try { this._blinkEntry.clutter_text.set_cursor_visible(this._caretVisible); } catch (e) {}
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCaretBlink() {
        if (this._caretBlinkId) {
            try { GLib.source_remove(this._caretBlinkId); } catch (e) {}
            this._caretBlinkId = 0;
        }
        try { if (this._blinkEntry) this._blinkEntry.clutter_text.set_cursor_visible(true); } catch (e) {}
        this._caretVisible = true;
    }

    _isInsideDialog(gx, gy) {
        const [px, py] = this.dialogLayout.get_transformed_position();
        const [w, h] = this.dialogLayout.get_transformed_size();
        return gx >= px && gx <= px + w && gy >= py && gy <= py + h;
    }

    getText() { return this._entry.get_text(); }

    setText(text) {
        this._entry.set_text(text);
        this._entry.clutter_text.set_cursor_position(text.length);
    }
});

// Small popup context menu — custom St, not PopupMenu, to match floating style
class QuickSearchContextMenu {
    constructor(overlay) {
        this._overlay = overlay;
        this.actor = new St.BoxLayout({ vertical: true, style_class: "quicksearch-context-menu", visible: false, reactive: true });
        // hidden until shown; parent will be global.stage or overlay container
        this._outsideId = 0;
        this._actions = [];
    }
    ensureParent() {
        if (this.actor.get_parent()) return;
        // prefer dedicated _contextLayer (inside backgroundStack, above lightbox shade
        // and outside ScrollView clipping). fallback to stage/contentLayout for headless tests.
        try {
            const L = this._overlay && this._overlay._contextLayer;
            if (L) { L.add_actor(this.actor); return; }
        } catch (e) {}
        try { global.stage.add_actor(this.actor); } catch (e) { try { this._overlay.contentLayout.add_actor(this.actor); } catch (e2) {} }
    }
    show(actions, anchorActor, event) {
        this._actions = actions || [];
        this.ensureParent();
        while (this.actor.get_n_children() > 0) this.actor.remove_child(this.actor.get_child_at_index(0));
        for (let i = 0; i < this._actions.length; i++) {
            const a = this._actions[i];
            const icon = new St.Icon({ icon_name: a.iconName, icon_size: 16, icon_type: St.IconType.SYMBOLIC, x_align: Clutter.ActorAlign.START });
            const label = new St.Label({ text: a.label, x_align: Clutter.ActorAlign.START });
            const content = new St.BoxLayout({ vertical: false, x_align: Clutter.ActorAlign.START });
            content.add(icon);
            content.add(label, { expand: true });
            const btn = new St.Button({ style_class: "quicksearch-context-item", x_align: St.Align.START, child: content });
            const act = a;
            btn.connect("clicked", () => { try { act.run(); } catch (e) {} this.hide(); });
            this.actor.add_child(btn);
        }
        this.actor.visible = true;
        try { if (this._overlay && this._overlay._contextLayer) this._overlay._contextLayer.raise_top(); } catch (e) {}
        try {
            const L = this._overlay && this._overlay._contextLayer;
            const lb = this._overlay && this._overlay._lightbox;
            if (L && lb && lb.actor && L.get_parent() === this._overlay) {
                lb.actor.lower(L);
                L.raise_top();
            }
        } catch (e) {}
        this.actor.raise_top();
        this._positionNear(anchorActor, event);
        this._bindOutside();
    }
    _positionNear(anchorActor, event) {
        try {
            let ax = 0, ay = 0, aw = 0, ah = 0;
            let usePointer = false;
            let px = 0, py = 0;
            try {
                if (event && typeof event.get_coords === 'function') {
                    const c = event.get_coords();
                    if (Array.isArray(c) && c.length >= 2) { px = c[0]; py = c[1]; usePointer = true; }
                }
            } catch (e) {}
            try {
                if (anchorActor && typeof anchorActor.get_transformed_position === 'function') {
                    const p = anchorActor.get_transformed_position();
                    ax = p[0] || 0; ay = p[1] || 0;
                    const s = anchorActor.get_transformed_size();
                    aw = s[0] || 0; ah = s[1] || 0;
                }
            } catch (e) {}
            let [mw, mh] = this.actor.get_preferred_size ? (() => { const [, w] = this.actor.get_preferred_width(-1); const [, h] = this.actor.get_preferred_height(w); return [w, h]; })() : [220, 160];
            if (!mw || mw < 120) mw = 220;
            if (!mh || mh < 40) mh = this._actions.length * 36 + 12;
            let lx = 0, ly = 0;
            try {
                const L = this._overlay && this._overlay._contextLayer;
                if (L && L.get_parent()) { const p = L.get_transformed_position(); lx = p[0] || 0; ly = p[1] || 0; }
            } catch (e) {}
            const sw = global.screen_width || 1920;
            const sh = global.screen_height || 1080;
            let x, y;
            if (usePointer) {
                x = px + 8 - lx;
                y = py + 8 - ly;
                if (x + lx + mw > sw - 8) x = px - mw - 8 - lx;
                if (x + lx < 8) x = 8 - lx;
                if (y + ly + mh > sh - 8) y = py - mh - 8 - ly;
                if (y + ly < 8) y = 8 - ly;
            } else {
                x = ax + aw + 6 - lx;
                y = ay - 4 - ly;
                const absX = x + lx, absY = y + ly;
                if (absX + mw > sw - 8) x = ax - mw - 6 - lx;
                if (x + lx < 8) x = 8 - lx;
                if (absY + mh > sh - 8) y = sh - mh - 8 - ly;
                if (y + ly < 8) y = 8 - ly;
            }
            this.actor.set_position(Math.round(x), Math.round(y));
            try { this.actor.set_size(mw, mh); } catch (e) {}
        } catch (e) {}
    }
    _bindOutside() {
        this._unbindOutside();
        try {
            this._outsideId = global.stage.connect("button-press-event", (actor, event) => {
                try {
                    const [gx, gy] = event.get_coords();
                    const [mx, my] = this.actor.get_transformed_position();
                    const [mw, mh] = this.actor.get_transformed_size();
                    const inside = gx >= mx && gx <= mx + mw && gy >= my && gy <= my + mh;
                    if (!inside && this.actor.visible) { this.hide(); return Clutter.EVENT_STOP; }
                } catch (e) {}
                return Clutter.EVENT_PROPAGATE;
            });
        } catch (e) {}
    }
    _unbindOutside() {
        if (this._outsideId) { try { global.stage.disconnect(this._outsideId); } catch (e) {} this._outsideId = 0; }
    }
    hide() {
        this.actor.visible = false;
        this._unbindOutside();
    }
    isVisible() { try { return this.actor.visible; } catch (e) { return false; } }
    destroy() {
        this._unbindOutside();
        try { this.actor.destroy(); } catch (e) {}
    }
}

class QuickSearchSourcesPopover {
    constructor(overlay, onOpenUrl) {
        this._overlay = overlay;
        this._onOpenUrl = onOpenUrl;
        this.actor = new St.BoxLayout({ vertical: true, style_class: "quicksearch-sources-popover", visible: false, reactive: true });
        this._scrollView = new St.ScrollView({ style_class: "quicksearch-sources-popover-scroll", x_fill: true, y_fill: false });
        try { this._scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC); } catch (e) {}
        this._listBox = new St.BoxLayout({ vertical: true, style_class: "quicksearch-sources-popover-list" });
        try { this._scrollView.add_actor(this._listBox); } catch (e) { try { this._scrollView.add_child(this._listBox); } catch (e2) {} }
        this._headerLabel = new St.Label({ text: _("Sources"), style_class: "quicksearch-sources-popover-header" });
        try { this.actor.add_child(this._headerLabel); } catch (e) {}
        try { this.actor.add_child(this._scrollView); } catch (e) {}
        this._outsideId = 0;
        this._keyId = 0;
        this._sources = [];
    }
    ensureParent() {
        if (this.actor.get_parent()) return;
        try {
            const L = this._overlay && this._overlay._contextLayer;
            if (L) { L.add_actor(this.actor); return; }
        } catch (e) {}
        try { global.stage.add_actor(this.actor); } catch (e) { try { this._overlay.contentLayout.add_actor(this.actor); } catch (e2) {} }
    }
    show(sources, anchorActor) {
        this._sources = Array.isArray(sources) ? sources.slice() : [];
        if (this._sources.length === 0) return;
        this.ensureParent();
        while (this._listBox.get_n_children() > 0) this._listBox.remove_child(this._listBox.get_child_at_index(0));
        for (let i = 0; i < this._sources.length; i++) {
            const src = this._sources[i];
            if (!src || typeof src.url !== 'string' || !src.url) continue;
            const title = typeof src.title === 'string' && src.title.trim() ? src.title.trim() : (src.domain || src.url);
            const domain = typeof src.domain === 'string' && src.domain.trim() ? src.domain.trim() : '';
            const row = new St.Button({ style_class: "quicksearch-sources-popover-row", reactive: true, track_hover: true, can_focus: false });
            const rowBox = new St.BoxLayout({ vertical: true, style_class: "quicksearch-sources-popover-rowbox" });
            const titleLabel = new St.Label({ text: (i + 1) + ". " + title, style_class: "quicksearch-sources-popover-title" });
            try {
                const ct = titleLabel.get_clutter_text();
                ct.set_line_wrap(false);
                if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.END);
            } catch (e) {}
            const domainLabel = new St.Label({ text: domain || src.url, style_class: "quicksearch-sources-popover-domain" });
            try {
                const ct2 = domainLabel.get_clutter_text();
                ct2.set_line_wrap(false);
                if (typeof ct2.set_ellipsize === 'function') ct2.set_ellipsize(Pango.EllipsizeMode.END);
            } catch (e) {}
            try { rowBox.add_child(titleLabel); } catch (e) {}
            try { if (domain || src.url) rowBox.add_child(domainLabel); } catch (e) {}
            try { row.set_child(rowBox); } catch (e) {}
            const url = src.url;
            const handler = this._onOpenUrl;
            row.connect("clicked", () => {
                try { if (handler) handler(url); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            try { this._listBox.add_child(row); } catch (e) {}
        }
        this.actor.visible = true;
        try { if (this._overlay && this._overlay._contextLayer) this._overlay._contextLayer.raise_top(); } catch (e) {}
        try {
            const L = this._overlay && this._overlay._contextLayer;
            const lb = this._overlay && this._overlay._lightbox;
            if (L && lb && lb.actor && L.get_parent() === this._overlay) {
                lb.actor.lower(L);
                L.raise_top();
            }
        } catch (e) {}
        this.actor.raise_top();
        this._positionNear(anchorActor);
        this._bindOutside();
        this._bindKeys();
    }
    _positionNear(anchorActor) {
        try {
            let ax = 0, ay = 0, aw = 0, ah = 0;
            try {
                if (anchorActor && typeof anchorActor.get_transformed_position === 'function') {
                    const p = anchorActor.get_transformed_position();
                    ax = p[0] || 0; ay = p[1] || 0;
                    const s = anchorActor.get_transformed_size();
                    aw = s[0] || 0; ah = s[1] || 0;
                }
            } catch (e) {}
            let pw = 360, ph = 260;
            try {
                const [ , w] = this.actor.get_preferred_width(-1);
                const [ , h] = this.actor.get_preferred_height(w);
                if (w && w > 100) pw = Math.min(420, Math.max(260, w));
                if (h && h > 40) ph = Math.min(380, Math.max(80, h));
            } catch (e) {}
            if (!pw || pw < 200) pw = 360;
            if (!ph || ph < 60) ph = Math.min(320, this._sources.length * 56 + 36);
            if (ph > 380) ph = 380;
            let lx = 0, ly = 0;
            try {
                const L = this._overlay && this._overlay._contextLayer;
                if (L && L.get_parent()) { const p = L.get_transformed_position(); lx = p[0] || 0; ly = p[1] || 0; }
            } catch (e) {}
            const sw = global.screen_width || 1920;
            const sh = global.screen_height || 1080;
            let x = ax - lx;
            let y = ay + ah + 6 - ly;
            if (x + lx + pw > sw - 8) x = sw - pw - 8 - lx;
            if (x + lx < 8) x = 8 - lx;
            if (y + ly + ph > sh - 8) {
                const above = ay - ph - 6 - ly;
                if (above + ly >= 8) y = above;
                else y = Math.max(8 - ly, sh - ph - 8 - ly);
            }
            if (y + ly < 8) y = 8 - ly;
            this.actor.set_position(Math.round(x), Math.round(y));
            try { this.actor.set_size(pw, ph); } catch (e) {}
            try { this._scrollView.set_size(pw - 12, ph - 36); } catch (e) {}
        } catch (e) {}
    }
    _bindOutside() {
        this._unbindOutside();
        try {
            this._outsideId = global.stage.connect("button-press-event", (actor, event) => {
                try {
                    const [gx, gy] = event.get_coords();
                    const [mx, my] = this.actor.get_transformed_position();
                    const [mw, mh] = this.actor.get_transformed_size();
                    const inside = gx >= mx && gx <= mx + mw && gy >= my && gy <= my + mh;
                    if (!inside && this.actor.visible) { this.hide(); return Clutter.EVENT_STOP; }
                } catch (e) {}
                return Clutter.EVENT_PROPAGATE;
            });
        } catch (e) {}
    }
    _unbindOutside() {
        if (this._outsideId) { try { global.stage.disconnect(this._outsideId); } catch (e) {} this._outsideId = 0; }
    }
    _bindKeys() {
        this._unbindKeys();
        try {
            this._keyId = global.stage.connect("key-press-event", (actor, event) => {
                try {
                    const sym = event.get_key_symbol();
                    if (sym === Clutter.KEY_Escape && this.actor.visible) { this.hide(); return Clutter.EVENT_STOP; }
                } catch (e) {}
                return Clutter.EVENT_PROPAGATE;
            });
        } catch (e) {}
    }
    _unbindKeys() {
        if (this._keyId) { try { global.stage.disconnect(this._keyId); } catch (e) {} this._keyId = 0; }
    }
    hide() {
        this.actor.visible = false;
        this._unbindOutside();
        this._unbindKeys();
    }
    isVisible() { try { return this.actor.visible; } catch (e) { return false; } }
    destroy() {
        this._unbindOutside();
        this._unbindKeys();
        try { this.actor.destroy(); } catch (e) {}
    }
}

class QuickSearchApplet extends Applet.IconApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.set_applet_icon_name("system-search");
        this.set_applet_tooltip(_("Quick Search"));

        this._overlay = null;
        this._hotkeyName = UUID + "-open";
        this._hotkeyBound = null;
        this._autoRows = [];
        this._mainRows = [];
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        this._popupHideId = 0;
        this._lastPanelWidth = 0;

        // ---- settings ----
        this.settings = new Settings.AppletSettings(this, UUID, instance_id);
        this.open_shortcut = "<Super>f";
        this.enable_web = true;
        this.enable_files = true;
        this.search_engine = "ddgo";
        this.web_search_api_key = "";
        this.searxng_url = "http://127.0.0.1:8080";
        this.file_locations = [];
        this.max_apps = 5;
        this.max_files = 15;
        this.max_web = 5;
        this.debounce_ms = 150;
        this.show_recent = true;
        this.recent_queries_json = "";

        this.settings.bind("open-shortcut", "open_shortcut", () => this._bindHotkey());
        this.settings.bind("enable-web", "enable_web", () => this._rebuildEngine());
        this.settings.bind("enable-files", "enable_files", () => this._rebuildEngine());
        this.settings.bind("search-engine", "search_engine", (v) => {
            this.search_engine = v;
            this._applySearchEngineSetting();
            this._rebuildEngine();
            this._rebuildAiEngine();
        });
        this.settings.bind("file-locations", "file_locations", () => this._rebuildEngine());
        this.settings.bind("max-apps", "max_apps", () => this._rebuildEngine());
        this.settings.bind("max-files", "max_files", () => this._rebuildEngine());
        this.settings.bind("max-web", "max_web", () => this._rebuildEngine());
        this.settings.bind("debounce-ms", "debounce_ms", () => this._rebuildEngine());
        this.settings.bind("show-recent", "show_recent");
        this.settings.bind("recent-queries", "recent_queries_json");
        this.settings.bind("web-search-api-key", "web_search_api_key", () => { this._rebuildEngine(); this._rebuildAiEngine(); });
        this.settings.bind("searxng-url", "searxng_url", () => { this._rebuildEngine(); this._rebuildAiEngine(); });
        this.settings.bind("ai-base-url", "ai_base_url", () => this._rebuildAiEngine());
        this.settings.bind("ai-api-key", "ai_api_key", () => this._rebuildAiEngine());
        this.settings.bind("ai-model", "ai_model", () => this._rebuildAiEngine());
        this.ai_debug_mode = false;
        this.settings.bind("ai-debug-mode", "ai_debug_mode");
        this.ai_max_output_tokens = 4096;
        this.settings.bind("ai-max-output-tokens", "ai_max_output_tokens", () => this._rebuildAiEngine());
        this.settings.bind("ai-source-expansion", "ai_source_expansion", () => this._rebuildAiEngine());

        this._applySearchEngineSetting();

        if (this.open_shortcut === "<Super>space") {
            this.open_shortcut = "<Super>f";
        }

        try { this._recent = JSON.parse(this.recent_queries_json || "[]") || []; }
        catch (e) { this._recent = []; }

        this._rows = [];
        this._selIdx = -1;
        this._current = [];
        this._sortedResults = [];
        this._contextMenu = null;
        this._sourcesPopover = null;
        this._sourcesPopoverAnchorId = null;

        // ---- UI-2: active category filter (presentation only) ----
        this._category = 'all';

        // ---- AI Search mode state (Phase AI-4/AI-5) ----
        // Spec AI-4 §4.2: explicit _searchMode = 'normal' | 'ai' (alias to _mode='search'|'ai' for compat)
        // _mode kept as legacy alias; _searchMode is canonical per spec.
        this._mode = 'search';
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiGen = 0;
        this._aiEngine = null;
        // Phase 9: chat-actions state — edit target, sticky auto-scroll, per-message actors
        this._aiEditId = null;
        this._aiMsgActors = {};
        this._aiStickBottom = true;
        this._aiLayoutId = 0;
        this._aiScrollId = 0;
        this._aiScrollAdjIds = [];
        this._aiScrollBound = false;
        this._aiTooltips = [];
        this._aiMsgTooltips = [];
        // Phase 8: canonical conversation state (message model, history, per-message sources)
        this._conversation = null;
        if (convMod && typeof convMod.createConversation === 'function') {
            try { this._conversation = convMod.createConversation(); } catch (e) { this._conversation = null; }
        }
        this.ai_base_url = this.ai_base_url || "";
        this.ai_api_key = this.ai_api_key || "";
        this.ai_model = this.ai_model || "";
        // ponytail: _searchMode alias via accessor so both stay in sync; ceiling=AI-4 spec, no extra state.
        try {
            Object.defineProperty(this, '_searchMode', {
                get() { return this._mode === 'ai' ? 'ai' : 'normal'; },
                set(v) { this._mode = (v === 'ai') ? 'ai' : 'search'; },
                enumerable: true,
                configurable: true
            });
        } catch (e) {
            this._searchMode = 'normal';
        }

        this._createEngine();
        this._createAiEngine();
        this._bindHotkey();
    }

    _createEngine() {
        if (this._engine) {
            try { this._engine.destroy(); } catch (e) {}
            this._engine = null;
        }

        this._applySearchEngineSetting();
        const engineChoice = utilsMod.normalizeSearchEngine(this.search_engine) || "ddgo";
        const searchEngineLabel = this._searchEngineLabel(engineChoice);
        this._engineForId = engineChoice;
        const helperDeps = {
            makeResult: resultMod.makeResult,
            scoreResult: resultMod.scoreResult,
            pickFileBackend: utilsMod.pickFileBackend,
            sanitizeGlob: utilsMod.sanitizeGlob,
            limits: { app: this.max_apps, file: this.max_files, web: this.max_web },
            locations: Array.isArray(this.file_locations) ? this.file_locations : [],
            searchEngineLabel: searchEngineLabel
        };

        const providers = {
            appProvider: appProviderMod.createAppProvider(helperDeps),
            fileProvider: this.enable_files ? fileProviderMod.createFileProvider(helperDeps) : null,
            webProvider: this.enable_web ? webProviderMod.createWebProvider(Object.assign({}, helperDeps, {
                fallbackUrlFor: FALLBACK_URLS[engineChoice] || FALLBACK_URLS.ddgo,
                useInstantAnswers: engineChoice === "ddgo",
                engine: engineChoice,
                googleApiKey: this.web_search_api_key || '',
                searxngUrl: this.searxng_url || 'http://127.0.0.1:8080'
            })) : null
        };

        this._appProvider = providers.appProvider;

        this._engine = searchEngineMod.createSearchEngine({
            makeResult: resultMod.makeResult,
            scoreResult: resultMod.scoreResult,
            classifyQuery: resultMod.classifyQuery,
            processResults: resultMod.processResults,
            detectUrl: urlProviderMod.detectUrl,
            tryCalculate: calculatorProviderMod.tryCalculate,
            debounceMs: this.debounce_ms || 150,
            limits: { app: this.max_apps, file: this.max_files, web: this.max_web },
            appProvider: providers.appProvider,
            fileProvider: providers.fileProvider,
            webProvider: providers.webProvider
        });

        if (providers.webProvider && typeof providers.webProvider.preflight === 'function') {
            try {
                providers.webProvider.preflight(err => {
                    if (err) {
                        try { global.log('[quicksearch@yoji] SearXNG pre-flight: unreachable'); } catch (e) {}
                    }
                });
            } catch (e) {}
        }
    }

    _rebuildEngine() {
        this._createEngine();
    }

    _normalizeMaxOutputTokens(v) {
        let n = Number(v);
        if (!Number.isFinite(n)) return 4096;
        n = Math.floor(n);
        if (n < 512) return 512;
        if (n > 16384) return 16384;
        return n;
    }
    _createAiEngine() {
        if (this._aiEngine) {
            try { this._aiEngine.destroy(); } catch (e) {}
            this._aiEngine = null;
        }
        if (!aiFactoryMod || typeof aiFactoryMod.createAiEngine !== 'function') return;
        if (this._injectedProvider) {
            try {
                const injOpts = { provider: this._injectedProvider };
                if (this._injectedWebSearchTool) injOpts.webSearchTool = this._injectedWebSearchTool;
                if (this._injectedEnableGrounding !== undefined) injOpts.enableGrounding = !!this._injectedEnableGrounding;
                this._aiEngine = aiFactoryMod.createAiEngine(injOpts);
            } catch (e) {}
            return;
        }
        let baseUrl = this.ai_base_url;
        let apiKey = this.ai_api_key;
        let model = this.ai_model;
        if (!String(baseUrl || '').trim() || !String(apiKey || '').trim() || !String(model || '').trim()) {
            try {
                const GLib2 = imports.gi.GLib;
                const path = GLib2.get_home_dir() + "/.config/cinnamon/spices/quicksearch@yoji/quicksearch@yoji.json";
                const [ok, contents] = GLib2.file_get_contents(path);
                if (ok) {
                    const text = imports.byteArray.toString(contents);
                    const j = JSON.parse(text);
                    if (!String(baseUrl || '').trim() && j["ai-base-url"] && j["ai-base-url"].value) baseUrl = j["ai-base-url"].value;
                    if (!String(apiKey || '').trim() && j["ai-api-key"] && j["ai-api-key"].value) apiKey = j["ai-api-key"].value;
                    if (!String(model || '').trim() && j["ai-model"] && j["ai-model"].value) model = j["ai-model"].value;
                }
            } catch (e) {}
        }
        try { this.ai_base_url = String(baseUrl || '').trim(); } catch (e) {}
        try { this.ai_api_key = String(apiKey || '').trim(); } catch (e) {}
        try { this.ai_model = String(model || '').trim(); } catch (e) {}
        try {
            const hasBase = !!String(baseUrl || '').trim();
            const hasKey = !!String(apiKey || '').trim();
            const hasModel = !!String(model || '').trim();
            const msg = "[quicksearch@yoji] AI config base=" + (hasBase ? "set" : "empty") + " key=" + (hasKey ? "set len " + String(apiKey).length : "empty") + " model=" + (hasModel ? String(model).slice(0, 30) : "empty");
            try { global.log(msg); } catch (e) {}
        } catch (e) {}
        try {
            if (!aiFactoryMod || typeof aiFactoryMod.createAiEngine !== 'function') {
                try { global.log("[quicksearch@yoji] aiFactoryMod missing: " + String(typeof aiFactoryMod) + " createAiEngine=" + String(aiFactoryMod && typeof aiFactoryMod.createAiEngine)); } catch (e2) {}
            }
            let searchEngine = this.search_engine;
            let searxngUrl = this.searxng_url;
            let webSearchApiKey = this.web_search_api_key;
            if (!String(searchEngine || '').trim() || !String(searxngUrl || '').trim()) {
                try {
                    const GLib3 = imports.gi.GLib;
                    const path3 = GLib3.get_home_dir() + "/.config/cinnamon/spices/quicksearch@yoji/quicksearch@yoji.json";
                    const [ok3, contents3] = GLib3.file_get_contents(path3);
                    if (ok3) {
                        const text3 = imports.byteArray.toString(contents3);
                        const j3 = JSON.parse(text3);
                        if (!String(searchEngine || '').trim() && j3["search-engine"] && j3["search-engine"].value) searchEngine = j3["search-engine"].value;
                        if (!String(searxngUrl || '').trim() && j3["searxng-url"] && j3["searxng-url"].value) searxngUrl = j3["searxng-url"].value;
                        if (!String(webSearchApiKey || '').trim() && j3["web-search-api-key"] && j3["web-search-api-key"].value) webSearchApiKey = j3["web-search-api-key"].value;
                    }
                } catch (e) {}
            }
            this._aiEngine = aiFactoryMod.createAiEngine({
                baseUrl: baseUrl,
                apiKey: apiKey,
                model: model,
                maxOutputTokens: this._normalizeMaxOutputTokens(this.ai_max_output_tokens),
                searchEngine: searchEngine,
                searxngUrl: searxngUrl,
                webSearchApiKey: webSearchApiKey,
                enableGrounding: true,
                sourceExpansion: !!this.ai_source_expansion,
                debug: !!this.ai_debug_mode
            });
            try { global.log("[quicksearch@yoji] AI engine created ok stream=" + String(!!(this._aiEngine && this._aiEngine.searchStream)) + " grounding=" + String(!!(this._aiEngine && this._aiEngine.__webSearchInitError ? " err:" + this._aiEngine.__webSearchInitError : " ok"))); } catch (e2) {}
        } catch (e) {
            try { global.log("[quicksearch@yoji] AI engine create failed: " + String(e && e.message || e) + " stack=" + String(e && e.stack || "").slice(0, 800)); } catch (e2) {}
        }
    }

    _rebuildAiEngine() {
        const wasLoading = !!this._aiLoading;
        // P1: destroy old engine so owned provider resources are released
        const oldEngine = this._aiEngine;
        this._aiEngine = null;
        if (oldEngine) {
            try { oldEngine.cancel(); } catch (e) {}
            try { oldEngine.destroy(); } catch (e) {}
        }
        this._aiGen++;
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._createAiEngine();
        if (this._mode === 'ai') {
            try { this._syncModeUI(); } catch (e) {}
            try { this._renderAIState(); } catch (e) {}
        } else if (wasLoading) {
            try { this._renderAIState(); } catch (e) {}
        }
    }

    _syncModeUI() {
        const ov = this._overlay;
        if (!ov || !ov._entry || !ov._modeButton) return;
        const isAi = this._mode === 'ai';
        try {
            // St.Entry hint_text property (Cinnamon's St.Entry uses hint_text)
            if (ov._entry) {
                try { ov._entry.hint_text = isAi ? _("Ask AI...") : _("Mau cari apa"); } catch (e) {
                    try { ov._entry.set_hint_text && ov._entry.set_hint_text(isAi ? _("Ask AI...") : _("Mau cari apa")); } catch (e2) {}
                }
            }
        } catch (e) {}
        try {
            if (ov._modeLabel) ov._modeLabel.set_text(isAi ? _("AI ON") : _("\u2728 Mode AI"));
        } catch (e) {}
        try {
            if (ov._modeIcon) ov._modeIcon.icon_name = isAi ? "emblem-favorite" : "system-search";
        } catch (e) {}
        try {
            if (isAi) {
                ov._entryRow.add_style_class_name("quicksearch-mode-active");
                ov._modeButton.add_style_class_name("quicksearch-mode-active");
            } else {
                ov._entryRow.remove_style_class_name("quicksearch-mode-active");
                ov._modeButton.remove_style_class_name("quicksearch-mode-active");
            }
        } catch (e) {}
        // UI-2/8: category chips belong to Search Mode only — AI Mode never shows them
        try { this._setFilterRowVisible(false); } catch (e) {}
        try { this._syncAIComposerState(); } catch (e) {}
        try { this._syncAIFooter(); } catch (e) {}
        try { this._updateHints(); } catch (e) {}
    }

    // Phase 15: mode switching is a two-way door. Entry-row pill and the chat-header
    // "Search" switch both land here; each direction is a dedicated method so AI→Search
    // always cancels any active AI request and Search→AI preserves the conversation.
    _toggleMode() {
        if (this._mode === 'ai') this._goToSearchMode();
        else this._goToAiMode();
    }

    _goToAiMode() {
        if (this._mode === 'ai' || !this._overlay) return;
        if (this._engine) try { this._engine.cancel(); } catch (e) {}
        this._clearNormalResultsForModeSwitch();
        this._clearAIState();
        this._mode = 'ai';
        this._aiGen++;
        this._aiLoading = false;
        this._aiEditId = null;
        this._syncModeUI();
        this._renderAIState();
        try { this._scheduleAILayoutSync(); } catch (e) {}
        if (this._hasConversation()) {
            // preserved conversation → bottom composer owns the input
            try { this._activateComposerInput(); } catch (e) {}
        } else {
            try {
                if (this._overlay && this._overlay._entry) {
                    if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(this._overlay._entry);
                    if (this._overlay._startCaretBlink) this._overlay._startCaretBlink();
                }
            } catch (e) {}
        }
    }

    // AI → Search. Safe under every AI state: an active/streaming request is stopped
    // FIRST (gen bump precedes engine cancel so no sync 'cancelled' callback can slip
    // through), stale callbacks are invalidated by the gen + mode guards, the composer/
    // edit state is cleaned and the normal Search UI is restored. The conversation is
    // preserved for the session — only New Chat clears it.
    _goToSearchMode() {
        if (this._mode !== 'ai') return;
        try { this._hideSourcesPopover(); } catch (e) {}
        this._cancelAILayoutSync();
        this._aiGen++;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        this._aiMsgActors = {};
        this._cancelAIScroll();
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._mode = 'search';
        this._syncModeUI();
        // clear AI visuals
        try { this._clearAIStateVisualOnly(); } catch (e) { this._clearAIState(); }
        // restore normal panel empty, then re-run query if text present
        this.renderResults([]);
        try { this._deactivateComposerInput(); } catch (e) {}
        try {
            if (this._overlay && this._overlay._entry) {
                if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(this._overlay._entry);
                if (this._overlay._startCaretBlink) this._overlay._startCaretBlink();
            }
        } catch (e) {}
        const txt = this._overlay ? this._overlay.getText() : "";
        if (txt && String(txt).trim()) {
            // re-trigger normal search for current text
            try { this.onTextChanged(txt); } catch (e) {}
        }
    }

    _clearNormalResultsForModeSwitch() {
        try {
            if (this._overlay) {
                if (this._overlay.resultsBox) {
                    while (this._overlay.resultsBox.get_n_children() > 0) this._overlay.resultsBox.remove_child(this._overlay.resultsBox.get_child_at_index(0));
                }
                if (this._overlay.autoCompleteBox) {
                    while (this._overlay.autoCompleteBox.get_n_children() > 0) this._overlay.autoCompleteBox.remove_child(this._overlay.autoCompleteBox.get_child_at_index(0));
                }
                this._autoRows = [];
                this._mainRows = [];
                this._rows = [];
                this._selIdx = -1;
                this._current = [];
                this._sortedResults = [];
                try { if (this._overlay._scroll) this._overlay._scroll.visible = false; } catch (e) {}
                try { if (this._overlay._autoScroll) this._overlay._autoScroll.visible = false; } catch (e) {}
                try { this._setFilterRowVisible(false); } catch (e) {}
            } else {
                this._autoRows = [];
                this._mainRows = [];
                this._rows = [];
                this._selIdx = -1;
            }
        } catch (e) {}
    }

    _clearAIState() {
        try { this._hideSourcesPopover(); } catch (e) {}
        this._cancelAILayoutSync();
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        this._cancelAIScroll();
        this._aiMsgActors = {};
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
    }

    _clearAIStateVisualOnly() {
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        const ov = this._overlay;
        if (!ov || !ov.resultsBox) return;
        try { while (ov.resultsBox.get_n_children() > 0) ov.resultsBox.remove_child(ov.resultsBox.get_child_at_index(0)); } catch (e) {}
        this._mainRows = [];
        this._aiMsgActors = {};
        // keep _rows recomputed via _syncSelection/_render paths; but ensure scroll hidden until normal renders
        try { if (ov._scroll) ov._scroll.visible = false; } catch (e) {}
        try { this._syncRegionGeometry(); } catch (e) {}
    }

    _buildAiDiagnosticText(err) {
        try {
            const stage = (err && (err.stage || err._stage)) ? String(err.stage || err._stage) : 'unknown';
            let status = null;
            try { status = (err && err.status != null) ? err.status : (err && err.httpStatus != null ? err.httpStatus : null); } catch (e) {}
            const code = (err && err.code) ? String(err.code) : '';
            const name = (err && err.name && String(err.name) !== 'Error') ? String(err.name) : '';
            let msg = (err && err.message) ? String(err.message) : (code || 'unknown error');
            try {
                const key = this.ai_api_key ? String(this.ai_api_key) : '';
                if (key && key.length >= 4) {
                    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    try { msg = msg.replace(new RegExp(esc, 'g'), '[REDACTED]'); } catch (e) {}
                }
                msg = msg.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
                msg = msg.replace(/api[_-]?key\s*[:=]\s*\S+/gi, 'api_key=[REDACTED]');
            } catch (e2) {}
            let out = 'AI request failed';
            out += '\nStage: ' + stage;
            if (name) out += '\nError: ' + name + ': ' + msg;
            else out += '\nError: ' + msg;
            if (code) out += ' (' + code + ')';
            out += '\nHTTP status: ' + (status != null ? String(status) : '-');
            try {
                out = out.replace(/Bearer\s+[A-Za-z0-9._\-~+\/]+=*/gi, 'Bearer [REDACTED]');
                if (this.ai_api_key && String(this.ai_api_key).length >= 4) {
                    const k2 = String(this.ai_api_key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    try { out = out.replace(new RegExp(k2, 'g'), '[REDACTED]'); } catch (e) {}
                }
            } catch (e) {}
            return out;
        } catch (e) { return 'AI request failed'; }
    }

    // Chat-mode control states (Phase 15): ONE compact action slot next to the entry —
    // [Stop] replaces [Send] while a request is active, never both (ChatGPT-style §5/§6).
    // + New Chat stays top-right in the chat header, and the header Search switch always
    // offers the way back to normal Search mode. No big footer row exists (§7).
    _syncAIFooter() {
        const ov = this._overlay;
        if (!ov || !ov._stopButton) return;
        const isAi = this._mode === 'ai';
        const hasConv = this._hasConversation();
        const composerActive = isAi && hasConv;
        const active = !!this._aiLoading || !!this._aiStreaming ||
            (convMod && this._conversation ? !!convMod.hasActive(this._conversation) : false);
        // single action slot: Stop while loading/streaming, Send otherwise (§5/§6)
        try { ov._stopButton.visible = composerActive && active; } catch (e) {}
        try { ov._composerSend.visible = composerActive && !active; } catch (e) {}
        // + New Chat: pinned top-right of the chat panel while a conversation exists (§3)
        try { if (ov._resetButton) ov._resetButton.visible = composerActive; } catch (e) {}
        // edit-in-progress hint row inside the composer (§6)
        try { if (ov._aiEditRow) ov._aiEditRow.visible = composerActive && this._aiEditId != null; } catch (e) {}
        try { this._syncComposerSendState(); } catch (e) {}
    }

    // ---- Phase 9: bottom follow-up composer + per-message chat actions ----

    _hasConversation() {
        return !!(convMod && this._conversation && convMod.count(this._conversation) > 0);
    }

    // §5/§2: exactly ONE input is ever visible. Conversation running → the top search
    // row (entryRow: entry + mode button) is fully hidden and the bottom composer is the
    // only input. No conversation → top input visible, composer + chat header hidden.
    _syncAIComposerState() {
        const ov = this._overlay;
        if (!ov || !ov._composerEntry) return;
        const composerActive = this._mode === 'ai' && this._hasConversation();
        try { ov._aiComposer.visible = composerActive; } catch (e) {}
        try { if (ov._aiHeader) ov._aiHeader.visible = composerActive; } catch (e) {}
        try {
            ov._entryRow.visible = !composerActive;
            ov._entry.reactive = !composerActive;
            ov._entry.can_focus = !composerActive;
        } catch (e) {}
        const editing = composerActive && this._aiEditId != null;
        try { if (ov._aiEditRow) ov._aiEditRow.visible = !!editing; } catch (e) {}
        if (editing && ov._aiEditLabel) {
            try {
                const m = convMod.findMessage(this._conversation, this._aiEditId);
                const excerpt = m ? String(m.content || '') : '';
                const shown = excerpt.length > 42 ? excerpt.slice(0, 42) + '...' : excerpt;
                ov._aiEditLabel.set_text(_("Editing message") + (shown ? ': \u201c' + shown + '\u201d' : '...'));
            } catch (e) {}
        }
        try { this._syncAIFooter(); } catch (e) {}
    }

    // Switch the UI to "conversation running" mode: hide the top search row completely
    // (entryRow.visible=false, not just inert) and show the bottom composer right below
    // the results panel with keyboard focus on it (§2/§5).
    _activateComposerInput() {
        const ov = this._overlay;
        if (!ov || !ov._composerEntry) return;
        try { ov._aiComposer.visible = true; } catch (e) {}
        try { if (ov._aiHeader) ov._aiHeader.visible = true; } catch (e) {}
        try {
            ov._entryRow.visible = false;
            ov._entry.reactive = false;
            ov._entry.can_focus = false;
            try { if (String(ov._entry.get_text ? ov._entry.get_text() : '') !== '') ov._entry.set_text(''); } catch (e2) {}
        } catch (e) {}
        try {
            const ct = ov._composerEntry.clutter_text;
            if (ct && typeof ct.set_cursor_visible === 'function') ct.set_cursor_visible(true);
        } catch (e) {}
        try { this._syncAIFooter(); } catch (e) {}
        try { this._syncComposerSendState(); } catch (e) {}
        try {
            if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(ov._composerEntry);
            if (ov._startCaretBlink) ov._startCaretBlink(ov._composerEntry);
        } catch (e) {}
    }

    // Switch back to "no conversation / initial chat" mode: bring the top input back,
    // hide the composer + chat header and clear composer text + edit state (§1/§2/§5).
    _deactivateComposerInput() {
        const ov = this._overlay;
        if (!ov) return;
        this._aiEditId = null;
        this._aiMsgActors = {};
        try { if (ov._aiComposer) ov._aiComposer.visible = false; } catch (e) {}
        try { if (ov._aiHeader) ov._aiHeader.visible = false; } catch (e) {}
        try { if (ov._composerEntry) ov._composerEntry.set_text(''); } catch (e) {}
        try {
            ov._entryRow.visible = true;
            ov._entry.reactive = true;
            ov._entry.can_focus = true;
        } catch (e) {}
        try { this._syncAIFooter(); } catch (e) {}
    }

    _syncComposerSendState() {
        const ov = this._overlay;
        if (!ov || !ov._composerEntry || !ov._composerSend) return;
        let text = '';
        try { text = String(ov._composerEntry.get_text ? ov._composerEntry.get_text() : '') || ''; } catch (e) {}
        const active = !!this._aiLoading || !!this._aiStreaming ||
            (convMod && this._conversation ? !!convMod.hasActive(this._conversation) : false);
        // Send is only meaningful while idle; during a request the Stop slot owns the row.
        const enabled = this._mode === 'ai' && this._hasConversation() && !active && !!String(text).trim();
        try {
            ov._composerSend.reactive = enabled;
            if (enabled) ov._composerSend.remove_style_class_name('quicksearch-ai-send-disabled');
            else ov._composerSend.add_style_class_name('quicksearch-ai-send-disabled');
        } catch (e) {}
    }

    _onComposerKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            if (this._aiEditId != null) {
                try { this._cancelEdit(); } catch (e) {}
            } else {
                try { this.close(); } catch (e) {}
            }
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            try { this._onComposerSend(); } catch (e) {}
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onComposerChanged() {
        try { this._syncComposerSendState(); } catch (e) {}
    }

    _onComposerSend() {
        const ov = this._overlay;
        if (!ov || !ov._composerEntry) return;
        if (this._mode !== 'ai' || !this._hasConversation()) {
            // conversation was cleared while the composer was visible → back to top input
            try { this._deactivateComposerInput(); } catch (e) {}
            return;
        }
        let text = '';
        try { text = String(ov._composerEntry.get_text ? ov._composerEntry.get_text() : '') || ''; } catch (e) {}
        if (!String(text).trim()) {
            // empty input never sends (§5)
            try {
                if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(ov._composerEntry);
            } catch (e) {}
            return;
        }
        try { ov._composerEntry.set_text(''); } catch (e) {}
        const editId = this._aiEditId != null ? this._aiEditId : null;
        try { this._syncComposerSendState(); } catch (e) {}
        try {
            if (editId != null) this._submitAIQuery(text, { editId });
            else this._submitAIQuery(text);
        } catch (e) {}
        // keep the composer focused for the next follow-up
        try {
            if (this._mode === 'ai' && this._hasConversation()) {
                if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(ov._composerEntry);
                if (ov._startCaretBlink) ov._startCaretBlink(ov._composerEntry);
            }
        } catch (e) {}
    }

    // §3 Edit: load the selected user message into the composer. Any running request is
    // cancelled first (partial stays as 'cancelled'), so no stale callback can race the
    // edit. The rewrite only happens when the edited text is sent.
    _beginEditUserMessage(id) {
        const ov = this._overlay;
        if (!ov || !convMod || !this._conversation) return;
        const m = convMod.findMessage(this._conversation, id);
        if (!m || m.role !== 'user') return;
        if (this._aiLoading || this._aiStreaming || convMod.hasActive(this._conversation)) {
            try { this._stopAI(); } catch (e) {}
        }
        this._aiEditId = id;
        try { this._activateComposerInput(); } catch (e) {}
        try {
            const content = String(m.content || '');
            ov._composerEntry.set_text(content);
            const ct = ov._composerEntry.clutter_text;
            if (ct && typeof ct.set_cursor_position === 'function') ct.set_cursor_position(content.length);
        } catch (e) {}
        try { this._syncAIComposerState(); } catch (e) {}
        try { this._renderAIState(); } catch (e) {}
        try { this._scrollAIMessageIntoView(id); } catch (e) {}
    }

    _cancelEdit() {
        this._aiEditId = null;
        try { this._syncAIComposerState(); } catch (e) {}
        try { this._renderAIState(); } catch (e) {}
        const ov = this._overlay;
        try {
            if (ov && ov._composerEntry && global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(ov._composerEntry);
        } catch (e) {}
    }

    // Copy: puts ONLY the user message content on the clipboard. Uses the Cinnamon/GJS
    // St.Clipboard API (the same one searchEngine.js already uses) — never a browser
    // navigator.clipboard. Pure side-effect: no conversation/state/focus changes.
    _copyUserMessageToClipboard(text) {
        try {
            const content = String(text || '');
            if (!content) return;
            const clip = St.Clipboard.get_default();
            if (clip && typeof clip.set_text === 'function') {
                clip.set_text(St.ClipboardType.CLIPBOARD, content);
            }
        } catch (e) {}
    }

    // §4 Resend: restart the conversation at the selected user message — everything from
    // that message down is dropped and the same text is re-sent once (no duplicate).
    // Only reachable from the conditional [resend] action, which appears solely when
    // this message's own paired answer failed — so retry drops the failed turn and
    // streams a fresh answer, leaving earlier turns untouched.
    _resendUserMessage(id) {
        if (!convMod || !this._conversation) return;
        const m = convMod.findMessage(this._conversation, id);
        if (!m || m.role !== 'user') return;
        const text = String(m.content || '');
        if (!String(text).trim()) return;
        this._aiEditId = null;
        try { this._submitAIQuery(text, { resendId: id }); } catch (e) {}
    }

    // ---- Phase 9 §6: sticky auto-scroll ----

    _cancelAILayoutSync() {
        if (this._aiLayoutId) {
            try { GLib.source_remove(this._aiLayoutId); } catch (e) {}
            this._aiLayoutId = 0;
        }
    }
    _scheduleAILayoutSync() {
        this._cancelAILayoutSync();
        const self = this;
        function _do() {
            try {
                const ov = self._overlay;
                if (!ov || !ov._entryRow) return GLib.SOURCE_REMOVE;
                let pw = 0;
                try { pw = Math.round(ov._entryRow.get_transformed_size()[0]) || 0; } catch (e) {}
                if (!pw) {
                    try { pw = Math.round(ov._entryRow.get_allocation_box ? ov._entryRow.get_allocation_box().x2 - ov._entryRow.get_allocation_box().x1 : 0) || 0; } catch (e) {}
                }
                if (pw <= 0) {
                    try { if (ov._entryRow.queue_relayout) ov._entryRow.queue_relayout(); } catch (e) {}
                    try { if (ov.resultsRegion.queue_relayout) ov.resultsRegion.queue_relayout(); } catch (e) {}
                    self._aiLayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { self._aiLayoutId = 0; _do(); return GLib.SOURCE_REMOVE; });
                    return GLib.SOURCE_REMOVE;
                }
                try { self._syncRegionGeometry(); } catch (e) {}
                try { self._ensureScrollTracking(); } catch (e) {}
                if (self._aiStickBottom) try { self._scheduleAIScroll(false); } catch (e) {}
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        }
        this._aiLayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => { this._aiLayoutId = 0; _do(); return GLib.SOURCE_REMOVE; });
    }
    _cancelAIScroll() {
        if (this._aiScrollId) {
            try { GLib.source_remove(this._aiScrollId); } catch (e) {}
            this._aiScrollId = 0;
        }
    }

    _ensureScrollTracking() {
        const ov = this._overlay;
        if (!ov || !ov._scroll || this._aiScrollBound) return;
        try {
            const vbar = ov._scroll.get_vscroll_bar();
            const adj = vbar.get_adjustment();
            if (!adj || typeof adj.connect !== 'function') return;
            const handler = () => {
                try { this._onAIUserScroll(); } catch (e) {}
            };
            // St.Adjustment signal naming varies across Cinnamon/GJS versions — bind every
            // candidate; whichever exists drives the sticky-scroll state.
            for (const sig of ['notify::value', 'value-changed', 'changed']) {
                try { this._aiScrollAdjIds.push(adj.connect(sig, handler)); } catch (e) {}
            }
            this._aiScrollBound = this._aiScrollAdjIds.length > 0;
        } catch (e) {}
    }

    _onAIUserScroll() {
        const ov = this._overlay;
        if (!ov || !ov._scroll) return;
        try {
            const vbar = ov._scroll.get_vscroll_bar();
            const adj = vbar.get_adjustment();
            const upper = Number(adj.upper) || 0;
            const ps = Number(adj.page_size) || 0;
            const val = Number(adj.value) || 0;
            // only follow the stream while (near) the bottom; reading older turns stops it
            this._aiStickBottom = (upper - ps - val) <= 48;
        } catch (e) {}
    }

    _scheduleAIScroll(force) {
        const ov = this._overlay;
        if (!ov || !ov._scroll) return;
        if (!force && !this._aiStickBottom) return;
        this._cancelAIScroll();
        const self = this;
        this._aiScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            self._aiScrollId = 0;
            try {
                const ov2 = self._overlay;
                if (!ov2 || !ov2._scroll || !ov2._scroll.visible) return GLib.SOURCE_REMOVE;
                const vbar = ov2._scroll.get_vscroll_bar();
                const adj = vbar.get_adjustment();
                const upper = Number(adj.upper) || 0;
                const ps = Number(adj.page_size) || 0;
                adj.set_value(Math.max(Number(adj.lower) || 0, upper - ps));
                self._aiStickBottom = true;
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _scrollAIMessageIntoView(id) {
        this._cancelAIScroll();
        const self = this;
        this._aiScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            self._aiScrollId = 0;
            try {
                const ov2 = self._overlay;
                if (!ov2 || !ov2._scroll || !ov2._scroll.visible) return GLib.SOURCE_REMOVE;
                const actor = self._aiMsgActors ? self._aiMsgActors[id] : null;
                if (!actor) return GLib.SOURCE_REMOVE;
                const vbar = ov2._scroll.get_vscroll_bar();
                const adj = vbar.get_adjustment();
                const [, sy] = ov2._scroll.get_transformed_position();
                const [, by] = actor.get_transformed_position();
                if (typeof by !== 'number') return GLib.SOURCE_REMOVE;
                const rowTop = by - sy + (Number(adj.value) || 0);
                const rowH = Number(actor.get_transformed_size()[1]) || 0;
                const viewH = Number(adj.page_size) || 0;
                const curVal = Number(adj.value) || 0;
                if (rowTop < curVal) adj.set_value(Math.max(Number(adj.lower) || 0, rowTop - 4));
                else if (rowTop + rowH > curVal + viewH) adj.set_value(rowTop + rowH - viewH + 4);
                const upper = Number(adj.upper) || 0;
                self._aiStickBottom = (upper - viewH - (Number(adj.value) || 0)) <= 48;
            } catch (e) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    // §4: small circular icon buttons (St.Icon, no visible text) with an optional
    // tooltip. A fallback icon chain is tried in case a theme lacks the primary name.
    _buildIconActionButton(iconNames, tooltipText, styleClass, onActivate, tooltipBucket) {
        const btn = new St.Button({ style_class: styleClass, reactive: true, can_focus: false, track_hover: true });
        const icon = new St.Icon({ icon_size: 13, icon_type: St.IconType.SYMBOLIC, style_class: styleClass + "-icon" });
        const names = Array.isArray(iconNames) ? iconNames : [iconNames];
        try { icon.icon_name = names[0]; } catch (e) {}
        try { btn.set_child(icon); } catch (e) {}
        try {
            btn.connect("clicked", () => {
                try { onActivate(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
        } catch (e) {}
        if (tooltipText) {
            try { this._attachTooltip(btn, tooltipText, tooltipBucket); } catch (e) {}
        }
        return btn;
    }

    _attachTooltip(actor, text, bucket) {
        try {
            if (typeof TooltipsMod !== 'undefined' && TooltipsMod && TooltipsMod.Tooltip) {
                const t = new TooltipsMod.Tooltip(actor, String(text));
                const arr = bucket || this._aiTooltips;
                if (arr) arr.push(t);
                return t;
            }
        } catch (e) {}
        return null;
    }

    // Per-render tooltips (message actions) are destroyed on every re-render so a long
    // streaming conversation cannot accumulate Tooltip objects for dead buttons.
    _clearMsgTooltips() {
        try {
            if (this._aiMsgTooltips) {
                for (const t of this._aiMsgTooltips) { try { t.destroy(); } catch (e) {} }
                this._aiMsgTooltips = [];
            }
        } catch (e) {}
    }

    _destroyTooltips() {
        this._clearMsgTooltips();
        try {
            if (this._aiTooltips) {
                for (const t of this._aiTooltips) { try { t.destroy(); } catch (e) {} }
                this._aiTooltips = [];
            }
        } catch (e) {}
    }

    // Render an assistant message's raw markdown into a SAFE vertical stack of St.Labels
    // (one label per block: paragraph / list / code). AI output is UNTRUSTED — only our own
    // <b>/<i> Pango tags are emitted by ai/markdownRenderer (all other text escaped), and the
    // markup goes through clutter_text.set_markup(), never innerHTML. Returns null for empty
    // content; on any failure it degrades to a single plain label (pre-markdown behaviour).
    _setLabelMarkupSafe(lbl, markup) {
        try {
            const ct = lbl.get_clutter_text();
            if (!ct) return false;
            if (typeof ct.set_markup === 'function') { ct.set_markup(markup); return true; }
            // older St/Clutter variants: enable the markup property then assign text
            try { ct.use_markup = true; ct.text = markup; return ct.use_markup === true; } catch (e2) {}
            return false;
        } catch (e) { return false; }
    }

    _buildAiAnswerActor(content) {
        try {
            const text = String(content || '');
            if (!text) return null;
            let blocks = null;
            if (mdMod && typeof mdMod.parseMarkdownBlocks === 'function') {
                try { blocks = mdMod.parseMarkdownBlocks(text); } catch (e) { blocks = null; }
            }
            const box = new St.BoxLayout({ vertical: true, style_class: "quicksearch-ai-answer-md" });
            const arr = (blocks && blocks.length) ? blocks :
                [{ kind: 'paragraph', lines: text.split('\n').map(l => ({ spans: [{ style: 'plain', text: l }] })) }];
            for (const block of arr) {
                // UI-3: code blocks get a distinct surface + a FUNCTIONAL copy action
                // (St.Clipboard — same API the message copy action uses).
                // P2-3: long lines scroll horizontally inside the code surface instead of
                // escaping the panel; the copy button stays above, visible + clickable.
                if (block.kind === 'code') {
                    try {
                        const codeText = String((block.lines || []).join('\n'));
                        const codeBox = new St.BoxLayout({ vertical: true, style_class: "quicksearch-ai-md-codebox" });
                        const codeLbl = new St.Label({ text: '', style_class: "quicksearch-ai-md-code", x_expand: false });
                        try {
                            const ct = codeLbl.get_clutter_text();
                            ct.set_line_wrap(false);
                            if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                        } catch (e) {}
                        let ok = false;
                        try {
                            const markup = (mdMod && typeof mdMod.blockToMarkup === 'function') ? mdMod.blockToMarkup(block) : null;
                            if (markup != null) ok = this._setLabelMarkupSafe(codeLbl, markup);
                        } catch (e) { ok = false; }
                        if (!ok) {
                            try { codeLbl.set_text(codeText); } catch (e2) {}
                        }
                        const codeScroll = new St.ScrollView({
                            style_class: "quicksearch-ai-md-code-scroll",
                            x_fill: true, y_fill: false,
                            clip_to_allocation: true
                        });
                        try { codeScroll.set_policy(St.PolicyType.AUTOMATIC, St.PolicyType.NEVER); } catch (e) {}
                        try { codeScroll.add_actor(codeLbl); } catch (e) { try { codeScroll.add_child(codeLbl); } catch (e2) {} }
                        const codeHeader = new St.BoxLayout({ vertical: false, style_class: "quicksearch-ai-md-code-header" });
                        const copyBtn = this._buildIconActionButton(["edit-copy-symbolic", "edit-copy"], _("Copy code"), "quicksearch-ai-md-code-copy", () => {
                            this._copyUserMessageToClipboard(codeText);
                        });
                        try { copyBtn.add_style_class_name("quicksearch-ai-action-icon-btn"); } catch (e) {}
                        try { codeHeader.add(copyBtn, { x_align: St.Align.END }); } catch (e) {}
                        try { codeBox.add(codeHeader); } catch (e) {}
                        try { codeBox.add(codeScroll); } catch (e) {}
                        box.add_child(codeBox);
                    } catch (e) {}
                    continue;
                }
                const cls = block.kind === 'list' ? "quicksearch-ai-md-list" : "quicksearch-ai-md-text";
                const lbl = new St.Label({ text: '', style_class: cls });
                try {
                    const ct = lbl.get_clutter_text();
                    if (ct) {
                        ct.set_line_wrap(true);
                        if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                    }
                } catch (e) {}
                let ok = false;
                try {
                    const markup = (mdMod && typeof mdMod.blockToMarkup === 'function') ? mdMod.blockToMarkup(block) : null;
                    if (markup != null) ok = this._setLabelMarkupSafe(lbl, markup);
                } catch (e) { ok = false; }
                if (!ok) {
                    // plain fallback — no markup, markers stripped, zero injection surface
                    let plain = String(content || '');
                    try {
                        if (mdMod && typeof mdMod.blockToPlainText === 'function') plain = mdMod.blockToPlainText(block);
                    } catch (e) {}
                    try { lbl.set_text(plain); } catch (e2) { try { lbl.text = plain; } catch (e3) {} }
                }
                box.add_child(lbl);
            }
            return box;
        } catch (e) {
            // last resort: single plain label exactly like the pre-markdown renderer
            try {
                const lbl = new St.Label({ text: String(content || ''), style_class: "quicksearch-ai-answer" });
                try { lbl.get_clutter_text().set_line_wrap(true); } catch (e2) {}
                return lbl;
            } catch (e3) { return null; }
        }
    }

    _renderAIState() {
        const ov = this._overlay;
        if (!ov || !ov.resultsBox) return;
        try { if (ov._autoScroll) ov._autoScroll.visible = false; } catch (e) {}
        // UI-2/8: strict separation — AI Mode never renders search filter chips
        try { this._setFilterRowVisible(false); } catch (e) {}
        this._autoRows = [];
        try { while (ov.resultsBox.get_n_children() > 0) ov.resultsBox.remove_child(ov.resultsBox.get_child_at_index(0)); } catch (e) {}
        this._clearMsgTooltips();
        this._mainRows = [];
        this._rows = [];
        this._selIdx = -1;
        this._sortedResults = [];
        this._aiMsgActors = {};

        // Phase 8 §1/§2: render the full conversation from the message model — never
        // just the latest answer. Each assistant message owns its content + sources (§10)
        // and its status (streaming/complete/cancelled/error) (§5/§8/§9).
        const messages = (convMod && this._conversation) ? convMod.getMessages(this._conversation) : [];
        const diagOn = !!this.ai_debug_mode;

        for (const msg of messages) {
            if (!msg) continue;
            if (msg.role === 'user') {
                try {
                    // ChatGPT-style message: content first, then a small utility action
                    // row BELOW it — never a big right-side cluster inside the card.
                    const block = new St.BoxLayout({ vertical: true, style_class: "quicksearch-ai-user-block" });
                    const editing = this._aiEditId === msg.id;
                    if (editing) try { block.add_style_class_name("quicksearch-ai-user-editing"); } catch (e) {}
                    const lbl = new St.Label({ text: _("You") + ": " + String(msg.content || ''), style_class: "quicksearch-ai-user" });
                    try { lbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                    block.add(lbl);
                    const uid = msg.id;
                    // Resend is CONDITIONAL: only when THIS message's own paired assistant
                    // answer actually failed (status 'error'). Success, cancellation,
                    // streaming and missing pairs never offer Resend — and one failed
                    // follow-up never lights Resend on earlier turns (pairing per user
                    // message via conversationState, never global loading/error state).
                    const pairedMsg = convMod ? convMod.getAssistantForUserMessage(this._conversation, uid) : null;
                    const paired = pairedMsg ? (pairedMsg.status || null) : null;
                    // tooltips only on stable (non-streaming) renders — buttons are
                    // recreated on every delta and tooltips would otherwise leak
                    const tipBucket = (!this._aiLoading && !this._aiStreaming) ? this._aiMsgTooltips : null;
                    const actionsRow = new St.BoxLayout({ vertical: false, style_class: "quicksearch-ai-msg-actions" });
                    // [copy] — always available; copies only the user content via St.Clipboard
                    actionsRow.add(this._buildIconActionButton(["edit-copy-symbolic", "edit-copy"], tipBucket ? _("Copy message") : '', "quicksearch-ai-action-icon-btn", () => {
                        this._copyUserMessageToClipboard(String(msg.content || ''));
                    }, tipBucket));
                    // [edit] — always available
                    actionsRow.add(this._buildIconActionButton(["document-edit-symbolic", "edit-symbolic"], tipBucket ? _("Edit message") : '', "quicksearch-ai-action-icon-btn", () => {
                        this._beginEditUserMessage(uid);
                    }, tipBucket));
                    // [resend] — only when this message's own answer failed
                    if (paired === 'error') {
                        actionsRow.add(this._buildIconActionButton(["view-refresh-symbolic", "reload-symbolic"], tipBucket ? _("Resend message") : '', "quicksearch-ai-action-icon-btn", () => {
                            this._resendUserMessage(uid);
                        }, tipBucket));
                    }
                    block.add(actionsRow);
                    ov.resultsBox.add_child(block);
                    if (this._aiMsgActors) this._aiMsgActors[uid] = block;
                } catch (e) {}
            } else if (msg.role === 'assistant') {
                // UI-3: small "✨ AI Answer" heading marks every answer surface — it is
                // re-created per render (streaming deltas rebuild it), never duplicated.
                const addAnswerHeading = () => {
                    try {
                        const h = new St.Label({ text: _("\u2728 AI Answer"), style_class: "quicksearch-ai-answer-heading" });
                        ov.resultsBox.add_child(h);
                    } catch (e) {}
                };
                if (msg.status === 'streaming') {
                    if (msg.content) {
                        try {
                            addAnswerHeading();
                            const actor = this._buildAiAnswerActor(String(msg.content));
                            if (actor) ov.resultsBox.add_child(actor);
                        } catch (e) {}
                    } else {
                        try {
                            const lbl = new St.Label({ text: _("Thinking..."), style_class: "quicksearch-ai-loading" });
                            try { lbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                            ov.resultsBox.add_child(lbl);
                        } catch (e) {}
                    }
                } else if (msg.status === 'complete') {
                    try {
                        addAnswerHeading();
                        const actor = this._buildAiAnswerActor(String(msg.content || ''));
                        if (actor) ov.resultsBox.add_child(actor);
                    } catch (e) {}
                    if (msg.truncated) {
                        try {
                            const tLbl = new St.Label({ text: _("Jawaban terhenti karena mencapai batas output."), style_class: "quicksearch-ai-truncated" });
                            try { tLbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                            ov.resultsBox.add_child(tLbl);
                        } catch (e) {}
                    }
                    if (Array.isArray(msg.sources) && msg.sources.length > 0) {
                        this._renderSourcesForMessage(ov, msg.sources, msg.id);
                    }
                } else if (msg.status === 'cancelled') {
                    // §8: partial content remains visible, status shown, request inactive
                    if (msg.content) {
                        try {
                            addAnswerHeading();
                            const actor = this._buildAiAnswerActor(String(msg.content));
                            if (actor) ov.resultsBox.add_child(actor);
                        } catch (e) {}
                    }
                    try {
                        const errLbl = new St.Label({ text: _("\u26a0 Interrupted") + " [" + _("Stopped") + "]", style_class: "quicksearch-ai-error" });
                        try { errLbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                        ov.resultsBox.add_child(errLbl);
                    } catch (e) {}
                } else if (msg.status === 'error') {
                    // §9: error belongs to this assistant interaction; history stays intact
                    const errText = diagOn ? this._buildAiDiagnosticText(msg.error) : _("Unable to get an AI response.");
                    if (msg.content) {
                        try {
                            addAnswerHeading();
                            const actor = this._buildAiAnswerActor(String(msg.content));
                            if (actor) ov.resultsBox.add_child(actor);
                        } catch (e) {}
                    }
                    try {
                        const errLbl = new St.Label({ text: errText, style_class: "quicksearch-ai-error" });
                        try {
                            const ct2 = errLbl.get_clutter_text();
                            ct2.set_line_wrap(true);
                            if (typeof ct2.set_selectable === 'function') try { ct2.set_selectable(true); } catch (e2) {}
                        } catch (e) {}
                        ov.resultsBox.add_child(errLbl);
                    } catch (e) {}
                }
            }
        }

        try { ov._scroll.visible = messages.length > 0; } catch (e) {}
        try { this._syncAIFooter(); } catch (e) {}
        try { this._syncRegionGeometry(); } catch (e) {}
        try { this._syncSelection(); } catch (e) {}
        try { this._syncAIComposerState(); } catch (e) {}
        try { this._updateHints(); } catch (e) {}
        if (messages.length > 0) {
            try { this._ensureScrollTracking(); } catch (e) {}
            try { this._scheduleAIScroll(false); } catch (e) {}
            try { this._scheduleAILayoutSync(); } catch (e) {}
        }
    }

    _openSourceUrl(url) {
        try {
            const trimmed = String(url || "").trim();
            if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return;
            if (/[\u0000-\u001f]/.test(trimmed)) return;
            try {
                if (Gio && Gio.AppInfo && typeof Gio.AppInfo.launch_default_for_uri_async === 'function') {
                    Gio.AppInfo.launch_default_for_uri_async(trimmed, null, null, null);
                    return;
                }
            } catch (e) {}
            const q = GLib.shell_quote(trimmed);
            if (Util) Util.spawnCommandLine('xdg-open ' + q);
            else if (imports.misc.util) imports.misc.util.spawnCommandLine('xdg-open ' + q);
        } catch (e) {}
    }

    _ensureSourcesPopover() {
        if (this._sourcesPopover) return this._sourcesPopover;
        try {
            if (!this._overlay) return null;
            this._sourcesPopover = new QuickSearchSourcesPopover(this._overlay, (url) => {
                try { this._openSourceUrl(url); } catch (e) {}
            });
        } catch (e) { this._sourcesPopover = null; }
        return this._sourcesPopover;
    }

    _hideSourcesPopover() {
        try { if (this._sourcesPopover) this._sourcesPopover.hide(); } catch (e) {}
        this._sourcesPopoverAnchorId = null;
    }

    _toggleSourcesPopover(sources, anchorActor, msgId) {
        try {
            const pop = this._ensureSourcesPopover();
            if (!pop) return;
            if (pop.isVisible() && this._sourcesPopoverAnchorId === msgId) {
                pop.hide();
                this._sourcesPopoverAnchorId = null;
                return;
            }
            if (pop.isVisible()) pop.hide();
            this._sourcesPopoverAnchorId = msgId;
            pop.show(sources, anchorActor);
        } catch (e) {}
    }

    _renderSourcesForMessage(ov, sources, msgId) {
        // compat: _renderSourcesForMessage(ov, sources) {
        // structural gate retained via _openSourceUrl: if (!/^https?:
        // Gio path retained via _openSourceUrl: launch_default_for_uri_async(trimmed
        if (!ov || !Array.isArray(sources) || sources.length === 0) return;
        try {
            const count = sources.length;
            // UI-3: inline compact sources — up to 3 clickable pills, metadata only.
            // P2 (final): layout is three stacked rows — 🔗 Sources label, then pills in
            // a WRAPPING flow container (narrow panels / DPI / font scaling wrap to
            // multiple lines instead of overflowing), then "View more" on its own line.
            // Pills open the source directly (structural http(s) gate in _openSourceUrl);
            // View more toggles the full popover kept from the previous UI.
            const wrap = new St.BoxLayout({ vertical: true, style_class: "quicksearch-ai-sources-wrap" });
            // header line: 🔗 Sources (own line — compact even on very narrow panels)
            const headRow = new St.BoxLayout({ vertical: false, style_class: "quicksearch-ai-sources-button quicksearch-ai-sources-row", x_expand: false });
            const icon = new St.Icon({ icon_name: "emblem-shared-symbolic", icon_size: 11, icon_type: St.IconType.SYMBOLIC, style_class: "quicksearch-ai-sources-button-icon" });
            try { icon.icon_name = "text-x-generic-symbolic"; } catch (e) {}
            const label = new St.Label({ text: _("Sources"), style_class: "quicksearch-ai-sources-button-label" });
            try { headRow.add(icon); } catch (e) {}
            try { headRow.add(label); } catch (e) {}
            try { wrap.add(headRow); } catch (e) {}
            // pills container: FlowLayout wraps when horizontal space runs out; falls
            // back to a plain horizontal row on runtimes without FlowLayout.
            let flowBox = null;
            try {
                flowBox = new St.Widget({
                    style_class: "quicksearch-ai-sources-row",
                    x_expand: true,
                    layout_manager: new Clutter.FlowLayout({
                        orientation: Clutter.Orientation.HORIZONTAL,
                        homogeneous: false,
                        column_spacing: 6,
                        row_spacing: 4
                    })
                });
            } catch (e) { flowBox = null; }
            if (!flowBox) {
                flowBox = new St.BoxLayout({ vertical: false, style_class: "quicksearch-ai-sources-row", x_expand: false });
            }
            const MAX_INLINE = 3;
            for (let i = 0; i < Math.min(count, MAX_INLINE); i++) {
                const src = sources[i];
                if (!src || typeof src.url !== 'string' || !src.url) continue;
                let title = typeof src.title === 'string' && src.title.trim() ? src.title.trim() : (src.domain || src.url);
                if (title.length > 28) title = title.slice(0, 28) + '\u2026';
                const pill = new St.Button({ style_class: "quicksearch-ai-source-pill", reactive: true, track_hover: true, can_focus: false });
                const pillLbl = new St.Label({ text: title, style_class: "quicksearch-ai-source-pill-label" });
                try {
                    const ct = pillLbl.get_clutter_text();
                    ct.set_line_wrap(false);
                    if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.END);
                } catch (e) {}
                try { pill.set_child(pillLbl); } catch (e) {}
                const url = src.url;
                pill.connect("clicked", () => {
                    try { this._openSourceUrl(url); } catch (e) {}
                    return Clutter.EVENT_STOP;
                });
                try { flowBox.add_actor(pill); } catch (e) { try { flowBox.add_child(pill); } catch (e2) {} }
            }
            try { wrap.add(flowBox); } catch (e) {}
            if (count > MAX_INLINE) {
                const moreBtn = new St.Button({ style_class: "quicksearch-ai-sources-button-viewmore", reactive: true, track_hover: true, can_focus: false });
                const moreLbl = new St.Label({ text: _("View more"), style_class: "quicksearch-ai-source-pill-label" });
                try { moreBtn.set_child(moreLbl); } catch (e) {}
                const capturedSources = sources.slice();
                const capturedId = msgId || String(count) + "-" + String(sources[0] && sources[0].url || "");
                moreBtn.connect("clicked", () => {
                    try { this._toggleSourcesPopover(capturedSources, moreBtn, capturedId); } catch (e) {}
                    return Clutter.EVENT_STOP;
                });
                try { wrap.add(moreBtn); } catch (e) {}
            }
            ov.resultsBox.add_child(wrap);
        } catch (e) {}
    }

    // Phase 8 §12 + Phase 9 §3/§4 staging. `opts`:
    //   { editId }   — rewrite that user message in place, drop every later turn, stream
    //   { resendId } — drop that user message + everything after, re-send the same text
    // (no opts)        — plain first message / follow-up (rapid-send contract)
    _submitAIQuery(raw, opts) {
        const q = String(raw || "").trim();
        if (!q) return;
        if (!convMod || !this._conversation) { this._aiLoading = false; return; }
        try { this._hideSourcesPopover(); } catch (e) {}

        const conv = this._conversation;
        const editId = opts && opts.editId != null ? opts.editId : null;
        const resendId = opts && opts.resendId != null ? opts.resendId : null;

        this._aiGen++;
        const myGen = this._aiGen;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}

        let settled = null;
        if (editId != null) {
            settled = convMod.editAndRestart(conv, editId, q);
            this._aiEditId = null;
        } else if (resendId != null) {
            settled = convMod.resendFrom(conv, resendId);
        } else {
            settled = convMod.rapidSend(conv, q);
        }
        if (!settled) {
            // defensive: invalid edit/resend target → plain follow-up send
            settled = convMod.rapidSend(conv, q);
            this._aiEditId = null;
        }
        const assistantId = settled ? settled.assistantId : null;
        this._aiLoading = true;
        this._aiStreaming = false;
        this._aiStickBottom = true;
        this._renderAIState();
        // a conversation now exists → the bottom follow-up composer owns the input (§5)
        try { this._activateComposerInput(); } catch (e) {}
        if (!this._aiEngine) this._createAiEngine();
        if (!this._aiEngine) {
            if (myGen !== this._aiGen || this._mode !== 'ai') return;
            this._aiLoading = false;
            if (assistantId != null) convMod.failAssistant(conv, assistantId, { code: 'provider_error' });
            this._renderAIState();
            return;
        }
        this._runAIRequestStream(q, assistantId, myGen);
    }

    // Shared streaming/answer runner for first message, follow-up, edit and resend.
    // Chunks always append to the single assistant message created by the staging step
    // above — never to a replaced/older message.
    _runAIRequestStream(q, assistantId, myGen) {
        const conv = this._conversation;
        if (!convMod || !conv || assistantId == null) return;
        const self = this;
        function _check() { return myGen !== self._aiGen || self._mode !== 'ai'; }
        function _render() { if (!_check()) self._renderAIState(); }

        // Phase 8 §3/§4: bounded prior history (excludes the current user message — the
        // engine always sends it as the live query).
        const history = convMod.getHistory(conv, 10);

        // Try streaming path first (§5: chunks append to the same assistant message)
        if (typeof this._aiEngine.searchStream === 'function') {
            try {
                this._aiEngine.searchStream(q, null, {
                    onStart: function() {
                        if (_check()) return;
                        self._aiLoading = false;
                        self._aiStreaming = true;
                        _render();
                    },
                    onDelta: function(chunk, fullText) {
                        if (_check()) return;
                        self._aiLoading = false;
                        self._aiStreaming = true;
                        convMod.updateAssistant(conv, assistantId, fullText || '');
                        _render();
                    },
                    onComplete: function(data) {
                        if (_check()) return;
                        self._aiLoading = false;
                        self._aiStreaming = false;
                        const text = data && typeof data.text === 'string' ? data.text : String((data && data.text) || '');
                        const sources = Array.isArray(data && data.sources) ? data.sources : [];
                        const meta = data && (data.truncated || data.finishReason) ? { finishReason: data.finishReason || null, truncated: !!data.truncated } : null;
                        convMod.completeAssistant(conv, assistantId, text, sources, meta);
                        _render();
                    },
                    onError: function(err) {
                        if (_check()) return;
                        const code = err && err.code ? err.code : 'provider_error';
                        self._aiLoading = false;
                        self._aiStreaming = false;
                        if (code === 'cancelled') {
                            convMod.cancelAssistant(conv, assistantId);
                        } else {
                            convMod.failAssistant(conv, assistantId, err || { code: code });
                        }
                        _render();
                    }
                }, { history });
            } catch (e) {
                if (_check()) return;
                self._aiLoading = false;
                convMod.failAssistant(conv, assistantId, { code: 'provider_error', message: e && e.message });
                _render();
            }
            return;
        }

        const cbs = {
            onAnswer: (data) => {
                if (_check()) return;
                self._aiLoading = false;
                self._aiStreaming = false;
                const meta = data && (data.truncated || data.finishReason) ? { finishReason: data.finishReason || null, truncated: !!data.truncated } : null;
                convMod.completeAssistant(conv, assistantId,
                    data && typeof data.text === 'string' ? data.text : String((data && data.text) || ''),
                    Array.isArray(data && data.sources) ? data.sources : [], meta);
                _render();
            },
            onError: (err) => {
                if (_check()) return;
                const code = err && err.code ? err.code : 'provider_error';
                self._aiLoading = false;
                self._aiStreaming = false;
                if (code === 'cancelled') convMod.cancelAssistant(conv, assistantId);
                else convMod.failAssistant(conv, assistantId, err || { code });
                _render();
            },
            onDone: (err, data) => {
                if (_check()) return;
                if (err) {
                    const code = err.code || 'provider_error';
                    self._aiLoading = false;
                    self._aiStreaming = false;
                    if (code === 'cancelled') convMod.cancelAssistant(conv, assistantId);
                    else convMod.failAssistant(conv, assistantId, err);
                    _render();
                } else if (data) {
                    self._aiLoading = false;
                    self._aiStreaming = false;
                    const meta2 = data.truncated || data.finishReason ? { finishReason: data.finishReason || null, truncated: !!data.truncated } : null;
                    convMod.completeAssistant(conv, assistantId, data.text || '', Array.isArray(data.sources) ? data.sources : [], meta2);
                    _render();
                }
            }
        };
        try {
            const maybe = this._aiEngine.search(q, null, cbs, { history });
            void maybe;
        } catch (e) {
            if (_check()) return;
            self._aiLoading = false;
            convMod.failAssistant(conv, assistantId, { code: 'provider_error', message: e && e.message });
            _render();
        }
    }

    _stopAI() {
        try { this._hideSourcesPopover(); } catch (e) {}
        this._cancelAILayoutSync();
        this._aiGen++;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        try { this._renderAIState(); } catch (e) {}
        // composer stays focused so the next follow-up can be typed immediately
        const ov = this._overlay;
        try {
            if (ov && ov._composerEntry && this._mode === 'ai' && this._hasConversation() && global.stage && typeof global.stage.set_key_focus === 'function') {
                global.stage.set_key_focus(ov._composerEntry);
            }
        } catch (e) {}
    }

    _resetConversation() {
        try { this._hideSourcesPopover(); } catch (e) {}
        this._cancelAILayoutSync();
        this._aiGen++;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        this._aiMsgActors = {};
        this._aiStickBottom = true;
        this._cancelAIScroll();
        if (convMod && this._conversation) { try { convMod.reset(this._conversation); } catch (e) {} }
        try { this._renderAIState(); } catch (e) {}
        try { this._deactivateComposerInput(); } catch (e) {}
        // back to the initial-chat state: top input visible and focused (§1/§5)
        const ov = this._overlay;
        try {
            if (ov && ov._entry && global.stage && typeof global.stage.set_key_focus === 'function') {
                ov._entry.set_text('');
                global.stage.set_key_focus(ov._entry);
                if (ov._startCaretBlink) ov._startCaretBlink();
            }
        } catch (e) {}
    }

    _applySearchEngineSetting() {
        const n = utilsMod.normalizeSearchEngine(this.search_engine);
        if (!n) {
            global.logWarning("[quicksearch@yoji] invalid search-engine value '" +
                              this.search_engine + "' - falling back to 'ddgo'");
            this.search_engine = "ddgo";
            try { this.settings.setValue("search-engine", "ddgo"); } catch (e) {}
        } else {
            this.search_engine = n;
        }
        return this.search_engine;
    }

    _searchEngineLabel(id) {
        return { ddgo: "DuckDuckGo", google: "Google", bing: "Bing", searxng: "SearXNG" }[id] || "DuckDuckGo";
    }

    _bindHotkey() {
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        Main.keybindingManager.addHotKey(this._hotkeyName, this.open_shortcut || "<Super>f", () => this.toggle());
    }

    on_applet_clicked() { this.toggle(); }

    toggle() {
        if (this._overlay && this._overlay.state !== ModalDialog.State.CLOSED) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        if (!this._overlay) {
            this._overlay = new QuickSearchOverlay(this);
        }
        // AI-2: every open starts in Normal Search (§16); conversation history is preserved
        // across open/close — only Clear chat removes it (§13/§1).
        this._mode = 'search';
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        this._aiMsgActors = {};
        // UI-2: every open starts on the All filter (predictable launcher state)
        this._category = 'all';
        try { this._syncFilterUI(); } catch (e) {
            try { global.log("[quicksearch@yoji] syncFilterUI failed on open: " + e); } catch (e2) {}
        }
        this._cancelAIScroll();
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._overlay.open(global.get_current_time());
        // P1-4: if the ModalDialog did not leave the CLOSED state after open(), the
        // searchbox can never appear — log it instead of failing silently. (OPENING/OPEN
        // are both fine; only CLOSED means open() itself failed.)
        try {
            if (this._overlay && typeof ModalDialog !== 'undefined' && this._overlay.state === ModalDialog.State.CLOSED) {
                try { global.log("[quicksearch@yoji] WARN overlay.state still CLOSED right after open() — dialog may not be visible"); } catch (e2) {}
            }
        } catch (e) {}
        this._overlay.dialogLayout.set_height(global.screen_height - 2);
        this._cancelAILayoutSync();
        try { this._scheduleAILayoutSync(); } catch (e) {}
        global.stage.set_key_focus(this._overlay._entry);
        this._overlay._startCaretBlink();
        this._overlay.setText("");
        if (this._overlay._composerEntry) try { this._overlay._composerEntry.set_text(''); } catch (e) {}
        this._syncModeUI();
        this._clearAIState();
        try { while (this._overlay.resultsBox.get_n_children() > 0) this._overlay.resultsBox.remove_child(this._overlay.resultsBox.get_child_at_index(0)); } catch (e) {}
        this._mainRows = [];
        this._autoRows = [];
        this._rows = [];
        this._selIdx = -1;
        if (this._overlay._autoScroll) try { this._overlay._autoScroll.visible = false; } catch (e) {}
        this.renderResults([]);
    }

    close() {
        this._cancelAILayoutSync();
        try { this._hideSourcesPopover(); } catch (e) {}
        try { if (this._contextMenu) this._contextMenu.hide(); } catch (e) {}
        if (this._engine) this._engine.cancel();
        // gen FIRST so no late 'cancelled'/stream callback can touch the UI after close
        this._aiGen++;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiEditId = null;
        this._aiMsgActors = {};
        this._cancelAIScroll();
        if (this._aiScrollAdjIds && this._aiScrollAdjIds.length > 0) {
            try {
                if (this._overlay && this._overlay._scroll) {
                    const vbar = this._overlay._scroll.get_vscroll_bar();
                    const adj = vbar.get_adjustment();
                    for (const id of this._aiScrollAdjIds) {
                        try { adj.disconnect(id); } catch (e) {}
                    }
                }
            } catch (e) {}
            this._aiScrollAdjIds = [];
            this._aiScrollBound = false;
        }
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._cancelPopupHide();
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        if (this._overlay) {
            try { this._overlay._stopCaretBlink(); } catch (e) {}
            if (this._overlay._composerEntry) try { this._overlay._composerEntry.set_text(''); } catch (e) {}
            this._overlay.close(global.get_current_time());
        }
    }

    _buildContextEnv() {
        const env = {};
        // app helpers
        env.canUninstall = false;
        try { env.canUninstall = GLib.file_test("/usr/bin/cinnamon-remove-application", GLib.FileTest.EXISTS); } catch (e) {}
        env.getUserDesktopDir = () => { try { return FileUtils ? FileUtils.getUserDesktopDir() : null; } catch (e) { return null; } };
        env.getAppFilename = (appId) => { try { const inf = Gio.DesktopAppInfo.new(appId); return inf ? inf.get_filename() : null; } catch (e) { return null; } };
        env.isFavorite = (appId) => { try { return AppFavorites ? AppFavorites.getAppFavorites().isFavorite(appId) : false; } catch (e) { return false; } };
        env.addFavorite = (appId) => { try { AppFavorites.getAppFavorites().addFavorite(appId); } catch (e) {} };
        env.removeFavorite = (appId) => { try { AppFavorites.getAppFavorites().removeFavorite(appId); } catch (e) {} };
        env.ensurePanelLauncher = () => {
            try {
                if (!Main.AppletManager.get_role_provider_exists(Main.AppletManager.Roles.PANEL_LAUNCHER)) {
                    const nid = global.settings.get_int("next-applet-id");
                    global.settings.set_int("next-applet-id", nid + 1);
                    const arr = global.settings.get_strv("enabled-applets");
                    arr.push("panel1:right:0:panel-launchers@cinnamon.org:" + nid);
                    global.settings.set_strv("enabled-applets", arr);
                }
            } catch (e) {}
        };
        env.acceptNewLauncher = (appId) => {
            try {
                const prov = Main.AppletManager.get_role_provider(Main.AppletManager.Roles.PANEL_LAUNCHER);
                if (prov) prov.acceptNewLauncher(appId);
            } catch (e) {}
        };
        env.acceptNewLauncherWithRetry = (appId) => {
            try {
                let retries = 10;
                const tick = () => {
                    if (retries-- <= 0) {
                        try { global.logWarning("[quicksearch@yoji] acceptNewLauncher timeout: " + appId); } catch (e) {}
                        return false;
                    }
                    let recognized = false;
                    try {
                        if (typeof Cinnamon !== "undefined" && Cinnamon.AppSystem) {
                            const sys = Cinnamon.AppSystem.get_default();
                            if (sys && sys.lookup_app) recognized = !!sys.lookup_app(appId);
                        }
                        if (!recognized) {
                            try { const inf = Gio.DesktopAppInfo.new(appId); if (inf) recognized = true; } catch (e2) {}
                        }
                    } catch (e) {}
                    if (!recognized) return true;
                    try {
                        const prov = Main.AppletManager.get_role_provider(Main.AppletManager.Roles.PANEL_LAUNCHER);
                        if (!prov) return true;
                        prov.acceptNewLauncher(appId);
                    } catch (e) {
                        try { global.logWarning("[quicksearch@yoji] acceptNewLauncher failed: " + e); } catch (e2) {}
                        return true;
                    }
                    return false;
                };
                if (Mainloop) Mainloop.timeout_add(100, tick);
                else GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, tick);
            } catch (e) {
                try { global.logWarning("[quicksearch@yoji] acceptNewLauncherWithRetry error: " + e); } catch (e2) {}
                try { env.acceptNewLauncher(appId); } catch (e2) {}
            }
        };
        env.copyToDesktop = (filename, desktopDir) => {
            try {
                const src = Gio.file_new_for_path(filename);
                const dest = Gio.file_new_for_path(desktopDir + "/" + src.get_basename());
                try { src.copy(dest, 0, null, () => {}); } catch (e) {
                    try { global.logWarning("[quicksearch@yoji] copyToDesktop copy failed: " + e); } catch (e2) {}
                    throw e;
                }
                try { if (FileUtils) FileUtils.changeModeGFile(dest, 755); } catch (e2) {
                    try { global.logWarning("[quicksearch@yoji] changeModeGFile failed: " + e2); } catch (e3) {}
                }
            } catch (e) {
                try { global.logWarning("[quicksearch@yoji] copyToDesktop failed: " + e); } catch (e2) {}
            }
        };
        env.uninstallApp = (filename) => {
            try {
                const q = GLib.shell_quote(filename);
                const cmd = "/usr/bin/cinnamon-remove-application " + q;
                if (Util) Util.spawnCommandLine(cmd);
                else imports.misc.util.spawnCommandLine(cmd);
            } catch (e) {}
        };
        // file helpers — persistent launcher for arbitrary files
        env.fileLauncherIdForPath = (p) => {
            try { return fileLauncherMod.fileLauncherIdForPath(String(p)); } catch (e) { return null; }
        };
        env.ensureFileLauncher = (p) => {
            try {
                const id = fileLauncherMod.fileLauncherIdForPath(String(p));
                let appsDir = null;
                try { if (GLib && GLib.get_user_data_dir) appsDir = GLib.get_user_data_dir() + "/applications"; } catch (e) {}
                if (!appsDir) try { appsDir = GLib.get_home_dir() + "/.local/share/applications"; } catch (e) {}
                if (!appsDir) return id;
                try { Gio.File.new_for_path(appsDir).make_directory_with_parents(null); } catch (e) {}
                const destPath = appsDir + "/" + id;
                const dest = Gio.File.new_for_path(destPath);
                let uri = "";
                try { uri = Gio.File.new_for_path(String(p)).get_uri(); } catch (e) { uri = String(p); }
                const contents = fileLauncherMod.buildFileLauncherContent(String(p), uri);
                let needsWrite = true;
                try {
                    if (dest.query_exists(null)) {
                        try {
                            const [ok, data] = dest.load_contents(null);
                            let existing = "";
                            try { existing = imports.byteArray ? imports.byteArray.toString(data) : String(data); } catch (e2) { existing = String(data); }
                            if (existing === contents) needsWrite = false;
                        } catch (e2) {}
                    }
                } catch (e) {}
                if (needsWrite) {
                    try { dest.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null); } catch (e) {
                        try { global.logWarning("[quicksearch@yoji] ensureFileLauncher write failed: " + e); } catch (e2) {}
                    }
                }
                return id;
            } catch (e) {
                try { global.logWarning("[quicksearch@yoji] ensureFileLauncher failed: " + e); } catch (e2) {}
                return null;
            }
        };
        env.openFileLocation = (p) => {
            try {
                const clean = String(p).replace(/\/+$/, "") || "/";
                const f = Gio.File.new_for_path(clean);
                if (!f.query_exists(null)) return false;
                let target = f;
                try {
                    let t = null;
                    try { t = f.query_file_type(Gio.FileQueryInfoFlags.FOLLOW_SYMLINKS, null); } catch (e2) {
                        const inf = f.query_info("standard::type", Gio.FileQueryInfoFlags.FOLLOW_SYMLINKS, null);
                        t = inf.get_file_type();
                    }
                    if (t !== Gio.FileType.DIRECTORY) {
                        const par = f.get_parent();
                        if (!par) return false;
                        target = par;
                    }
                } catch (e) {
                    const par = f.get_parent();
                    if (par) target = par;
                }
                Gio.AppInfo.launch_default_for_uri_async(target.get_uri(), null, null, null);
                return true;
            } catch (e) { return false; }
        };
        env.addFileToDesktop = (p, desktopDir) => {
            try {
                let uri = "";
                try { uri = Gio.File.new_for_path(String(p)).get_uri(); } catch (e) { uri = String(p); }
                const contents = fileLauncherMod.buildDesktopLauncherContent(String(p), uri);
                const src = Gio.File.new_for_path(String(p).replace(/\/+$/, "") || "/");
                const base = src.get_basename() || "file";
                const safe = base.replace(/[\/\\]/g, "_") + ".desktop";
                const dest = Gio.File.new_for_path(desktopDir + "/" + safe);
                try { dest.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null); } catch (e) {
                    try { global.logWarning("[quicksearch@yoji] addFileToDesktop write failed: " + e); } catch (e2) {}
                    throw e;
                }
                try { if (FileUtils) FileUtils.changeModeGFile(dest, 755); } catch (e2) {
                    try { global.logWarning("[quicksearch@yoji] addFileToDesktop chmod failed: " + e2); } catch (e3) {}
                }
            } catch (e) {
                try { global.logWarning("[quicksearch@yoji] addFileToDesktop failed: " + e); } catch (e2) {}
            }
        };
        return env;
    }

    _showContextMenu(result, anchorActor, event) {
        if (!result || !anchorActor) return;
        if (result.type !== "app" && result.type !== "file") return;
        if (!this._contextMenu) {
            if (!this._overlay) return;
            this._contextMenu = new QuickSearchContextMenu(this._overlay);
        }
        const env = this._buildContextEnv();
        const actions = contextActionsMod.getContextActions(result, env);
        if (!actions || !actions.length) return;
        this._contextMenu.show(actions, anchorActor, event || null);
    }

    // ---- input flow ----

    onTextChanged(text) {
        if (this._mode === 'ai') {
            this._selIdx = -1;
            try {
                if (this._overlay && this._overlay.autoCompleteBox) {
                    while (this._overlay.autoCompleteBox.get_n_children() > 0) this._overlay.autoCompleteBox.remove_child(this._overlay.autoCompleteBox.get_child_at_index(0));
                }
                this._autoRows = [];
                if (this._overlay && this._overlay._autoScroll) this._overlay._autoScroll.visible = false;
                this._rows = [];
            } catch (e) {}
            if (!this._aiLoading && !this._aiStreaming) { try { this._renderAIState(); } catch (e) {} }
            return;
        }
        this._selIdx = -1;
        this._renderAutocomplete(this._buildLocals(text));
        if (!text.trim()) {
            this._engine.cancel();
            this.renderResults([]);
            return;
        }
        if (this._applySearchEngineSetting() !== this._engineForId) {
            this._rebuildEngine();
        }
        this._engine.query(text, (results) => this.renderResults(results));
    }

    // ---- UI-2: category filter (presentation only — never re-ranks) ----

    // P2-4: no Settings chip — there is no dedicated Settings provider/type, only an
    // unreliable keyword heuristic, so the category is omitted until a real source
    // exists (reliability over filter count).
    _setCategory(id) {
        const valid = ["all", "app", "file", "folder", "web"];
        if (valid.indexOf(id) === -1) id = "all";
        this._category = id;
        this._syncFilterUI();
        if (this._mode === 'search') {
            try { this.renderResults(this._current || []); } catch (e) {}
        }
    }

    // Mirrors filter-row visibility to both the inner chip row and its scroll wrapper.
    _setFilterRowVisible(v) {
        const ov = this._overlay;
        try { if (ov && ov._filterRow) ov._filterRow.visible = v; } catch (e) {}
        try { if (ov && ov._filterScroll) ov._filterScroll.visible = v; } catch (e) {}
    }

    _syncFilterUI() {
        const ov = this._overlay;
        if (!ov || !ov._filterButtons) return;
        for (let i = 0; i < ov._filterButtons.length; i++) {
            const fb = ov._filterButtons[i];
            const active = fb.id === this._category;
            try {
                if (active) fb.button.add_style_class_name("quicksearch-filter-chip-active");
                else fb.button.remove_style_class_name("quicksearch-filter-chip-active");
            } catch (e) {}
        }
    }

    // Type filter over the ALREADY-ranked result set. "Folders"/"Files" split file
    // results by their folder icon; unknown categories fall through to All. There is
    // deliberately NO Settings category (P2-4) — only a real provider would justify it.
    _filterResults(results) {
        const cat = this._category || 'all';
        if (cat === 'all') return results;
        return (Array.isArray(results) ? results : []).filter(r => {
            if (!r) return false;
            if (cat === 'app') return r.type === 'app';
            if (cat === 'web') return r.type === 'web';
            if (cat === 'file') return r.type === 'file' && String(r.icon || '') !== 'folder-symbolic';
            if (cat === 'folder') return r.type === 'file' && String(r.icon || '') === 'folder-symbolic';
            return true;
        });
    }

    // UI-4: subtle, context-aware keyboard hints under the panel. Search shows
    // navigation only while a query/results are present; AI shows send/close.
    _updateHints() {
        const ov = this._overlay;
        if (!ov || !ov._hintsLabel) return;
        let text = "";
        if (this._mode === 'ai') {
            if (this._hasConversation()) text = _("Enter Send \u00b7 Esc Close");
            else text = _("Enter Ask \u00b7 Esc Close");
        } else {
            const q = (ov.getText && typeof ov.getText === 'function') ? String(ov.getText() || '').trim() : '';
            if (q || (this._rows && this._rows.length > 0)) text = _("\u2191 \u2193 Navigate \u00b7 Enter Open \u00b7 Esc Close");
        }
        try { ov._hintsLabel.set_text(text); } catch (e) {}
        try { ov._hintsLabel.visible = text !== ""; } catch (e) {}
    }

    _syncRegionGeometry() {
        const ov = this._overlay;
        if (!ov || !ov.resultsRegion) return;
        const pw = Math.round(ov._entryRow.get_transformed_size()[0]) || 0;
        if (pw > 0) this._lastPanelWidth = pw;
        const w = pw || this._lastPanelWidth || 690;
        let entryVisible = false;
        try { entryVisible = !!ov._entryRow && ov._entryRow.visible; } catch (e) {}
        let pillBottom = LAYOUT.topPad + LAYOUT.pillH;
        if (entryVisible) {
            const pillTf = ov._entryRow.get_transformed_position();
            pillBottom = (pillTf[1] || LAYOUT.topPad) + (ov._entryRow.get_transformed_size()[1] || LAYOUT.pillH);
        }
        // UI-2: the category filter row sits between the pill and the results panel,
        // so the available room below the pill must shrink by its height.
        let filterH = 0;
        try {
            if (this._mode === 'search' && ov._filterRow && ov._filterRow.visible) {
                const [, fh] = ov._filterRow.get_preferred_height(w);
                filterH = Math.round(Number(fh) || 0);
                if (filterH <= 0) filterH = LAYOUT.filterH;
                pillBottom += filterH + 4;
            }
        } catch (e) { pillBottom += LAYOUT.filterH + 4; }
        // Phase 9: keep the results area clear of the bottom follow-up composer so a long
        // conversation never renders underneath it (§1/§5).
        let bottomReserve = 0;
        if (this._mode === 'ai' && ov._aiComposer && ov._aiComposer.visible) {
            try {
                const [, ch] = ov._aiComposer.get_preferred_height(w);
                bottomReserve = (Number(ch) || 0) + 10;
            } catch (e) { bottomReserve = 110; }
        }
        // UI-4: keyboard hints bar height also reserves room below the panel.
        try {
            if (ov._hintsLabel && ov._hintsLabel.visible) {
                const [, hh] = ov._hintsLabel.get_preferred_height(w);
                bottomReserve += (Math.round(Number(hh) || 0) || LAYOUT.hintsH) + 4;
            }
        } catch (e) { bottomReserve += LAYOUT.hintsH + 4; }
        // P1: the ACTUAL remaining screen space is the hard upper bound — roomCap can
        // never exceed the screen (small screens / high scaling / edge panels stay
        // safe). The 1px floor is only a fallback for invalid/zero space.
        const avail = Math.max(0, global.screen_height - pillBottom - 6 - bottomReserve - 12);
        const roomCap = Math.max(1, avail);
        // chat-mode header [+ New Chat] pinned above the results panel
        let hdrH = 0;
        const hdrVisible = !!(ov._aiHeader && ov._aiHeader.visible);
        if (hdrVisible) {
            try {
                const [, hh] = ov._aiHeader.get_preferred_height(w);
                hdrH = Math.round(Number(hh) || 0);
            } catch (e) { hdrH = 0; }
            if (hdrH <= 0) hdrH = 34;
            try { ov._aiHeader.set_position(0, 0); } catch (e) {}
            try { ov._aiHeader.set_size(w, hdrH); } catch (e) {}
        }
        try {
            if (hdrVisible) ov._scroll.add_style_class_name('quicksearch-scroll-attached');
            else ov._scroll.remove_style_class_name('quicksearch-scroll-attached');
        } catch (e) {}
        let h = 0;
        if (ov._scroll.visible) {
            let natH = 0;
            try {
                const [ , contentNat] = ov.resultsBox.get_preferred_height(w);
                natH = Number(contentNat) || 0;
            } catch (e) { natH = 0; }
            if (natH <= 0) {
                const [, fb] = ov._scroll.get_preferred_height(w);
                natH = Number(fb) || 0;
            }
            natH += 16;
            const mainH = Math.min(natH, LAYOUT.maxResultsH, roomCap);
            ov._scroll.set_position(0, hdrH);
            ov._scroll.set_size(w, mainH);
            h = mainH + hdrH;
        } else if (hdrVisible) {
            ov._scroll.set_position(0, hdrH);
            h = hdrH;
        }
        if (ov._autoScroll.visible) {
            let natH = 0;
            try {
                const [ , cNat] = ov.autoCompleteBox.get_preferred_height(w);
                natH = Number(cNat) || 0;
            } catch (e) { natH = 0; }
            if (natH <= 0) {
                const [, fb] = ov._autoScroll.get_preferred_height(w);
                natH = Number(fb) || 0;
            }
            natH += 16;
            const autoH = Math.min(natH, roomCap);
            ov._autoScroll.set_position(0, hdrH);
            ov._autoScroll.set_size(w, autoH);
            h = Math.max(h, autoH + hdrH);
            ov._autoScroll.raise_top();
        }
        ov.resultsRegion.set_size(w, h);
    }

    _notePointer(key, inside) {
        this[key] = inside;
        if (inside) this._cancelPopupHide();
        else this._schedulePopupHide();
    }

    _cancelPopupHide() {
        if (this._popupHideId) {
            GLib.source_remove(this._popupHideId);
            this._popupHideId = 0;
        }
    }

    _schedulePopupHide() {
        if (this._popupHideId) return;
        this._popupHideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 140, () => {
            this._popupHideId = 0;
            const auto = this._overlay ? this._overlay._autoScroll : null;
            if (!this._ptrInEntry && !this._ptrInPopup && auto && auto.visible) {
                auto.visible = false;
                this._syncSelection();
                this._syncRegionGeometry();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildLocals(text) {
        if (!text.trim()) return [];
        if (!this.show_recent) return [];
        const appHits = this._appProvider
            ? this._appProvider.searchApps(text, 6).map(r => String(r.title))
            : [];
        const loc = utilsMod.buildLocalRows(text, this._recent, appHits);
        const histRows = loc.history.map(q => ({
            type: "history", title: q, description: _("History"),
            icon: "document-open-recent", score: resultMod.SCORES.history, query: q
        }));
        const sugRows = loc.suggestion.map(t => ({
            type: "suggestion", title: t, description: _("Suggestion"),
            icon: "system-search", score: resultMod.SCORES.suggestion, query: t
        }));
        return histRows.concat(sugRows);
    }

    _renderAutocomplete(locals) {
        const box = this._overlay.autoCompleteBox;
        while (box.get_n_children() > 0) box.remove_child(box.get_child_at_index(0));
        this._autoRows = locals.map(item => {
            const row = this._buildRow({ result: item });
            box.add_child(row.button);
            return row;
        });
        this._overlay._autoScroll.visible = this._autoRows.length > 0;
        this._syncRegionGeometry();
        this._syncSelection();
    }

    onKeyPress(event) {
        const sym = event.get_key_symbol();

        if (sym === Clutter.KEY_Escape) {
            if (this._sourcesPopover && this._sourcesPopover.isVisible()) { this._hideSourcesPopover(); return Clutter.EVENT_STOP; }
            if (this._contextMenu && this._contextMenu.isVisible()) { this._contextMenu.hide(); return Clutter.EVENT_STOP; }
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (this._mode === 'ai') {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                if (this._hasConversation()) {
                    // §5: after the first message the top entry is inert — keep the
                    // follow-up composer as the only send path
                    const ov = this._overlay;
                    try {
                        if (ov && ov._composerEntry && global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(ov._composerEntry);
                    } catch (e) {}
                } else {
                    try { this._submitAIQuery(this._overlay ? this._overlay.getText() : ""); } catch (e) {}
                }
                return Clutter.EVENT_STOP;
            }
            if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down || sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) {
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_KP_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up || sym === Clutter.KEY_KP_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            if (this._selIdx >= 0 && this._rows[this._selIdx]) {
                this.activateRow(this._rows[this._selIdx]);
                return Clutter.EVENT_STOP;
            }
            // P1-1: Enter without selection -> global Best Match (highest score)
            if (this._sortedResults && this._sortedResults.length) {
                const best = this._sortedResults[0];
                // find row matching best id, else activate result directly
                let bestRow = null;
                for (let i = 0; i < this._rows.length; i++) {
                    if (this._rows[i] && this._rows[i].result && this._rows[i].result.id === best.id) { bestRow = this._rows[i]; break; }
                }
                if (bestRow) { this.activateRow(bestRow); return Clutter.EVENT_STOP; }
                if (best.action) {
                    try { best.action(); } catch (e) { Main.notifyError(_("Quick Search"), _("Action failed")); }
                    this._pushRecent(this._overlay ? this._overlay.getText() : "");
                    this.close();
                    return Clutter.EVENT_STOP;
                }
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (!this._rows.length) return;
        let idx = this._selIdx < 0 ? 0 : this._selIdx + delta;
        idx = Math.max(0, Math.min(idx, this._rows.length - 1));
        this.setSelection(idx);
        const inAuto = idx < this._autoRows.length && this._autoRows.length > 0;
        const auto = this._overlay ? this._overlay._autoScroll : null;
        if (auto) auto.visible = inAuto;
    }

    setSelection(idx) {
        if (this._selIdx >= 0 && this._rows[this._selIdx]) {
            this._rows[this._selIdx].button.remove_style_class_name("quicksearch-row-selected");
        }
        this._selIdx = idx;
        const row = this._rows[idx];
        if (row) {
            row.button.add_style_class_name("quicksearch-row-selected");
            this._scrollToRow(row.button);
        }
    }

    _scrollToRow(button) {
        try {
            const scroll = this._overlay._scroll;
            if (!scroll.visible) return;
            const vbar = scroll.get_vscroll_bar();
            const adj = vbar.get_adjustment();
            const [sx, sy] = scroll.get_transformed_position();
            const [bx, by] = button.get_transformed_position();
            const rowTop = by - sy + adj.value;
            const rowH = button.get_transformed_size()[1];
            const viewH = adj.page_size;
            if (rowTop < adj.value) {
                adj.set_value(Math.max(adj.lower || 0, rowTop - 4));
            } else if (rowTop + rowH > adj.value + viewH) {
                adj.set_value(rowTop + rowH - viewH + 4);
            }
        } catch (e) {}
    }

    activateRow(row) {
        const r = row.result;
        if (r && r.query !== undefined) {
            this._overlay.setText(r.query);
            this.onTextChanged(r.query);
            const auto = this._overlay._autoScroll;
            if (auto) {
                auto.visible = false;
                this._selIdx = this._autoRows.length;
                if (this._rows[this._selIdx]) this.setSelection(this._selIdx);
            }
            return;
        }
        if (r && r.action) {
            try { r.action(); } catch (e) {
                Main.notifyError(_("Quick Search"), _("Action failed"));
            }
            this._pushRecent(this._overlay.getText());
            this.close();
        }
    }

    _pushRecent(q) {
        q = String(q || "").trim();
        if (!q) return;
        this._recent = [q].concat(this._recent.filter(x => x !== q)).slice(0, RECENT_MAX);
        this.recent_queries_json = JSON.stringify(this._recent);
    }

    // ---- rendering ----

    renderResults(results) {
        this._current = results;
        this._sortedResults = Array.isArray(results) ? results.slice() : [];

        const SECTION_ORDER = [
            ["calc", null],
            ["url", null],
            ["app", _("APPLICATIONS")],
            ["file", _("FILES")],
            ["web", _("WEB")]
        ];

        // UI-2: category chips are visible in Search Mode as soon as a query exists
        // (keeps the idle state compact). AI Mode never shows them.
        try {
            const ov = this._overlay;
            if (ov && ov._filterRow) {
                const q = (ov.getText && typeof ov.getText === 'function') ? String(ov.getText() || '').trim() : '';
                this._setFilterRowVisible(this._mode === 'search' && !!q);
            }
        } catch (e) {}

        // UI-2: Best Match hierarchy — the highest-ranked result of the CURRENT
        // (filtered) set leads the panel as a distinct surface, then the grouped
        // sections follow WITHOUT duplicating it. Ranking logic itself is untouched.
        const display = this._filterResults(this._sortedResults);
        const mainRows = [];
        if (display.length > 0) {
            const best = display[0];
            mainRows.push({ header: _("Best Match"), bestHeader: true });
            mainRows.push({ result: best, bestMatch: true });
            for (let s = 0; s < SECTION_ORDER.length; s++) {
                const type = SECTION_ORDER[s][0];
                const header = SECTION_ORDER[s][1];
                const group = display.filter(r => r.type === type && r.id !== best.id);
                if (!group.length) continue;
                if (header) mainRows.push({ header: header });
                for (const r of group) mainRows.push({ result: r });
            }
        } else {
            // empty state: only when a query is actually present (idle stays clean)
            const q = this._overlay && this._overlay.getText ? String(this._overlay.getText() || '').trim() : '';
            if (q) mainRows.push({ empty: true });
        }
        this._renderMainRows(mainRows);
    }

    _renderMainRows(flat) {
        const box = this._overlay.resultsBox;
        while (box.get_n_children() > 0) box.remove_child(box.get_child_at_index(0));
        this._mainRows = [];
        for (let i = 0; i < flat.length; i++) {
            const item = flat[i];
            if (item.empty) {
                const lbl = new St.Label({ text: _("Tidak ada hasil untuk pencarian ini."), style_class: "quicksearch-empty" });
                try { lbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                box.add_child(lbl);
                continue;
            }
            if (item.header) {
                const hdr = new St.Label({ text: item.header, style_class: "quicksearch-section-header" });
                if (item.bestHeader) try { hdr.add_style_class_name("quicksearch-bestmatch-header"); } catch (e) {}
                box.add_child(hdr);
                continue;
            }
            const row = this._buildRow(item);
            this._mainRows.push(row);
            box.add_child(row.button);
        }
        this._overlay._scroll.visible = flat.length > 0;
        this._syncRegionGeometry();
        this._syncSelection();
        try { this._updateHints(); } catch (e) {}
    }

    _syncSelection() {
        // P1-3: preserve selection by id if still valid, else clamped index
        let prevId = null;
        let prevIdx = this._selIdx;
        if (prevIdx >= 0 && this._rows && this._rows[prevIdx] && this._rows[prevIdx].result) {
            prevId = this._rows[prevIdx].result.id || null;
        }
        const hidden = this._overlay && !this._overlay._autoScroll.visible;
        const startAt = hidden ? Math.min(this._autoRows.length,
                                          Math.max(0, this._rows ? this._autoRows.length : 0)) : 0;
        this._rows = this._autoRows.concat(this._mainRows);
        if (!this._rows.length) { this._selIdx = -1; return; }
        // try restore by id
        if (prevId) {
            for (let i = 0; i < this._rows.length; i++) {
                if (this._rows[i].result && this._rows[i].result.id === prevId) {
                    this._selIdx = -1;
                    this.setSelection(i);
                    return;
                }
            }
        }
        // try restore by index if still in bounds
        if (prevIdx >= 0 && prevIdx < this._rows.length) {
            this._selIdx = -1;
            this.setSelection(prevIdx);
            return;
        }
        this._selIdx = -1;
        this.setSelection(Math.min(startAt, this._rows.length - 1));
    }

    _buildRow(item) {
        const isRecent = item.type === "recent";
        const r = isRecent ? item : item.result;

        const icon = new St.Icon({
            icon_size: 24,
            x_align: Clutter.ActorAlign.START,
            reactive: false
        });
        if (typeof r.icon === "string") icon.icon_name = r.icon;
        else if (r.icon) icon.gicon = r.icon;
        else icon.icon_name = "system-search";

        const titleLbl = new St.Label({ text: String(r.title || ""), style_class: "quicksearch-title" });
        titleLbl.get_clutter_text().set_line_wrap(false);
        titleLbl.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
        const descText = isRecent ? _("Recent") : String(r.description || "");
        const descLbl = new St.Label({ text: descText, style_class: "quicksearch-desc" });
        descLbl.get_clutter_text().set_line_wrap(false);
        descLbl.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);

        const labels = new St.BoxLayout({ vertical: true, y_align: St.Align.MIDDLE });
        labels.add(titleLbl);
        labels.add(descLbl);

        const content = new St.BoxLayout({ vertical: false, style_class: "quicksearch-row-inner" });
        content.add(icon);
        content.add(labels);

        // UI-2: Best Match gets a subtle keyboard hint on the right (Enter) — the row
        // itself stays a plain list row, never an oversized card.
        let bestMatch = false;
        try { bestMatch = !!(item && item.bestMatch); } catch (e) { bestMatch = false; }
        if (bestMatch) {
            try {
                const enterLbl = new St.Label({ text: _("Enter"), style_class: "quicksearch-best-match-hint" });
                content.add(enterLbl, { x_align: St.Align.END, expand: true });
            } catch (e) {}
        }

        const button = new St.Button({
            style_class: "quicksearch-row",
            x_align: St.Align.START,
            child: content
        });
        if (bestMatch) {
            try { button.add_style_class_name("quicksearch-best-match"); } catch (e) {}
        }

        const row = { button: button, result: r };
        button.connect("clicked", () => this.activateRow(row));
        button.connect("enter-event", () => {
            for (let i = 0; i < this._rows.length; i++) {
                if (this._rows[i] === row) { this.setSelection(i); break; }
            }
        });
        // right-click anywhere on row — only app/file produce a menu
        if (r && (r.type === "app" || r.type === "file")) {
            try {
                button.connect("button-press-event", (actor, event) => {
                    if (event.get_button() === 3) {
                        // select this row first so the menu belongs to it
                        try {
                            for (let i = 0; i < this._rows.length; i++) {
                                if (this._rows[i] === row) { this.setSelection(i); break; }
                            }
                        } catch (e) {}
                        try { this._showContextMenu(r, button, event); } catch (e) {}
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
            } catch (e) {}
        }
        return row;
    }

    // ---- lifecycle cleanup ----

    destroySettings() {
        try { this.settings.finalize(); } catch (e) {}
    }

    on_applet_removed_from_panel(reload) {
        try { if (this._contextMenu) { this._contextMenu.destroy(); this._contextMenu = null; } } catch (e) {}
        try { this._destroyTooltips(); } catch (e) {}
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        this._cancelPopupHide();
        // Phase 9 lifecycle: no pending scroll timer, edit target, or message actor map
        this._cancelAIScroll();
        this._aiEditId = null;
        this._aiMsgActors = {};
        if (this._overlay) {
            try { this._overlay._stopCaretBlink(); } catch (e) {}
            // disconnect hover/key-focus/outside signals
            try {
                if (this._overlay._hoverIds) for (const id of this._overlay._hoverIds) { try { this._overlay._entryRow.disconnect(id); } catch(e){} try { this._overlay._autoScroll.disconnect(id); } catch(e){} }
            } catch(e){}
            try {
                if (this._overlay._keyFocusIds) for (const id of this._overlay._keyFocusIds) { try { this._overlay._entry.disconnect(id); } catch(e){} }
            } catch(e){}
            try {
                if (this._overlay._outsideClickId) {
                    const tgt = (this._overlay._lightbox && this._overlay._lightbox.actor) ? this._overlay._lightbox.actor : this._overlay._backgroundBin;
                    if (tgt) try { tgt.disconnect(this._overlay._outsideClickId); } catch(e){}
                }
            } catch(e){}
            this._overlay._hoverIds = [];
            this._overlay._keyFocusIds = [];
            this._overlay._outsideClickId = 0;
        }
        this._cancelAILayoutSync();
        try { this._hideSourcesPopover(); } catch (e) {}
        try { if (this._sourcesPopover) { this._sourcesPopover.destroy(); this._sourcesPopover = null; } } catch (e) {}
        this._sourcesPopoverAnchorId = null;
        if (this._engine) {
            try { this._engine.cancel(); } catch(e){}
            try { this._engine.destroy(); } catch(e){}
            this._engine = null;
        }
        if (this._aiEngine) {
            try { this._aiEngine.cancel(); } catch(e){}
            try { this._aiEngine.destroy(); } catch(e){}
            this._aiEngine = null;
        }
        try { this.close(); } catch(e){}
        if (this._overlay) {
            try { this._overlay.destroy(); } catch(e){}
            this._overlay = null;
        }
        this.destroySettings();
        this._rows = [];
        this._current = [];
        this._sortedResults = [];
        this._recent = [];
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new QuickSearchApplet(orientation, panel_height, instance_id);
}

module.exports = { main };
