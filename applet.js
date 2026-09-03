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
let FileUtils = null, Util = null, AppFavorites = null, XApp = null, Mainloop = null;
try { FileUtils = imports.misc.fileUtils; } catch (e) {}
try { Util = imports.misc.util; } catch (e) {}
try { AppFavorites = imports.ui.appFavorites; } catch (e) {}
try { XApp = imports.gi.XApp; } catch (e) {}
try { Mainloop = imports.mainloop; } catch (e) { try { Mainloop = require('mainloop'); } catch (e2) {} }

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
        try {
            this._modeButton.connect("clicked", () => {
                try { this._applet._toggleMode(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
        } catch (e) {}
        this.contentLayout.add_style_class_name("quicksearch-content");
        this.contentLayout.add(entryRow);
        this._caretBlinkId = 0;
        this._caretVisible = true;

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this._scroll = new St.ScrollView({
            style_class: "quicksearch-results",
            x_fill: false, y_fill: false,
            y_align: St.Align.START
        });
        this._scroll.add_actor(this.resultsBox);
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.resultsRegion = new St.Widget({ x_expand: true });
        this.contentLayout.add(this.resultsRegion, {
            expand: true, x_fill: true, y_fill: false,
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

        // Phase 8 §6/§13: AI footer — Stop (visible while a request is active) + Reset Conversation
        this._aiFooter = new St.BoxLayout({ style_class: "quicksearch-ai-footer", vertical: false, visible: false });
        this._stopButton = new St.Button({ style_class: "quicksearch-ai-stop", can_focus: false, reactive: true, track_hover: true, label: _("\u23f9 Stop") });
        this._resetButton = new St.Button({ style_class: "quicksearch-ai-reset", can_focus: false, reactive: true, track_hover: true, label: _("\u21ba Reset") });
        this._aiFooter.add(this._stopButton);
        this._aiFooter.add(this._resetButton);
        this.contentLayout.add(this._aiFooter);
        try {
            this._stopButton.connect("clicked", () => {
                try { this._applet._stopAI(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
            this._resetButton.connect("clicked", () => {
                try { this._applet._resetConversation(); } catch (e) {}
                return Clutter.EVENT_STOP;
            });
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

    _startCaretBlink() {
        this._stopCaretBlink();
        this._caretVisible = true;
        try { this._entry.clutter_text.set_cursor_visible(true); } catch (e) {}
        this._caretBlinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 530, () => {
            this._caretVisible = !this._caretVisible;
            try { this._entry.clutter_text.set_cursor_visible(this._caretVisible); } catch (e) {}
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopCaretBlink() {
        if (this._caretBlinkId) {
            try { GLib.source_remove(this._caretBlinkId); } catch (e) {}
            this._caretBlinkId = 0;
        }
        try { this._entry.clutter_text.set_cursor_visible(true); } catch (e) {}
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

        // ---- AI Search mode state (Phase AI-4/AI-5) ----
        // Spec AI-4 §4.2: explicit _searchMode = 'normal' | 'ai' (alias to _mode='search'|'ai' for compat)
        // _mode kept as legacy alias; _searchMode is canonical per spec.
        this._mode = 'search';
        this._aiLoading = false;
        this._aiStreaming = false;
        this._aiGen = 0;
        this._aiEngine = null;
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
                searchEngine: searchEngine,
                searxngUrl: searxngUrl,
                webSearchApiKey: webSearchApiKey,
                enableGrounding: true
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
        try { if (ov._aiFooter) ov._aiFooter.visible = isAi; } catch (e) {}
        try { this._syncAIFooter(); } catch (e) {}
    }

    _toggleMode() {
        const toAi = this._mode !== 'ai';
        if (toAi) {
            if (this._engine) try { this._engine.cancel(); } catch (e) {}
            this._clearNormalResultsForModeSwitch();
            this._clearAIState();
            this._mode = 'ai';
            this._aiGen++;
            this._aiLoading = false;
            this._syncModeUI();
            this._renderAIState();
            try {
                if (this._overlay && this._overlay._entry) {
                    if (global.stage && typeof global.stage.set_key_focus === 'function') global.stage.set_key_focus(this._overlay._entry);
                    if (this._overlay._startCaretBlink) this._overlay._startCaretBlink();
                }
            } catch (e) {}
        } else {
            if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
            this._aiGen++;
            this._aiLoading = false;
            this._aiStreaming = false;
            if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
            this._mode = 'search';
            this._syncModeUI();
            // clear AI visuals
            try { this._clearAIStateVisualOnly(); } catch (e) { this._clearAIState(); }
            // restore normal panel empty, then re-run query if text present
            this.renderResults([]);
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
            } else {
                this._autoRows = [];
                this._mainRows = [];
                this._rows = [];
                this._selIdx = -1;
            }
        } catch (e) {}
    }

    _clearAIState() {
        // Phase 8: cancel the active request but preserve conversation history.
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
    }

    _clearAIStateVisualOnly() {
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        const ov = this._overlay;
        if (!ov || !ov.resultsBox) return;
        try { while (ov.resultsBox.get_n_children() > 0) ov.resultsBox.remove_child(ov.resultsBox.get_child_at_index(0)); } catch (e) {}
        this._mainRows = [];
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

    _syncAIFooter() {
        const ov = this._overlay;
        if (!ov || !ov._stopButton) return;
        const active = !!this._aiLoading || !!this._aiStreaming ||
            (convMod && this._conversation ? !!convMod.hasActive(this._conversation) : false);
        try { ov._stopButton.visible = this._mode === 'ai' && active; } catch (e) {}
        try { if (ov._resetButton) ov._resetButton.visible = this._mode === 'ai'; } catch (e) {}
    }

    _renderAIState() {
        const ov = this._overlay;
        if (!ov || !ov.resultsBox) return;
        try { if (ov._autoScroll) ov._autoScroll.visible = false; } catch (e) {}
        this._autoRows = [];
        try { while (ov.resultsBox.get_n_children() > 0) ov.resultsBox.remove_child(ov.resultsBox.get_child_at_index(0)); } catch (e) {}
        this._mainRows = [];
        this._rows = [];
        this._selIdx = -1;
        this._sortedResults = [];

        // Phase 8 §1/§2: render the full conversation from the message model — never
        // just the latest answer. Each assistant message owns its content + sources (§10)
        // and its status (streaming/complete/cancelled/error) (§5/§8/§9).
        const messages = (convMod && this._conversation) ? convMod.getMessages(this._conversation) : [];
        const diagOn = !!this.ai_debug_mode;

        for (const msg of messages) {
            if (!msg) continue;
            if (msg.role === 'user') {
                try {
                    const lbl = new St.Label({ text: _("You") + ": " + String(msg.content || ''), style_class: "quicksearch-ai-user" });
                    try { lbl.get_clutter_text().set_line_wrap(true); } catch (e) {}
                    ov.resultsBox.add_child(lbl);
                } catch (e) {}
            } else if (msg.role === 'assistant') {
                if (msg.status === 'streaming') {
                    if (msg.content) {
                        try {
                            const lbl = new St.Label({ text: String(msg.content), style_class: "quicksearch-ai-answer" });
                            try {
                                const ct = lbl.get_clutter_text();
                                ct.set_line_wrap(true);
                                if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                            } catch (e) {}
                            ov.resultsBox.add_child(lbl);
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
                        const lbl = new St.Label({ text: String(msg.content || ''), style_class: "quicksearch-ai-answer" });
                        try {
                            const ct = lbl.get_clutter_text();
                            ct.set_line_wrap(true);
                            if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                        } catch (e) {}
                        ov.resultsBox.add_child(lbl);
                    } catch (e) {}
                    if (Array.isArray(msg.sources) && msg.sources.length > 0) {
                        this._renderSourcesForMessage(ov, msg.sources);
                    }
                } else if (msg.status === 'cancelled') {
                    // §8: partial content remains visible, status shown, request inactive
                    if (msg.content) {
                        try {
                            const lbl = new St.Label({ text: String(msg.content), style_class: "quicksearch-ai-answer" });
                            try {
                                const ct = lbl.get_clutter_text();
                                ct.set_line_wrap(true);
                                if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                            } catch (e) {}
                            ov.resultsBox.add_child(lbl);
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
                            const lbl = new St.Label({ text: String(msg.content), style_class: "quicksearch-ai-answer" });
                            try {
                                const ct = lbl.get_clutter_text();
                                ct.set_line_wrap(true);
                                if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.NONE);
                            } catch (e) {}
                            ov.resultsBox.add_child(lbl);
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
    }

    _renderSourcesForMessage(ov, sources) {
        // Phase 8 §10: sources are rendered under the assistant message that produced them.
        if (!ov || !Array.isArray(sources) || sources.length === 0) return;
        try {
            const srcLabel = new St.Label({ text: _("Sources"), style_class: "quicksearch-ai-sources-label" });
            ov.resultsBox.add_child(srcLabel);
        } catch (e) {}
        for (const src of sources) {
            if (!src || typeof src.url !== 'string' || !src.url) continue;
            const srcTitle = typeof src.title === 'string' && src.title.trim() ? src.title.trim() : (src.domain || src.url);
            const srcDomain = typeof src.domain === 'string' && src.domain.trim() ? src.domain : '';
            const displayText = srcDomain ? srcTitle + ' \u2014 ' + srcDomain : srcTitle;
            try {
                const srcRow = new St.Button({ style_class: "quicksearch-ai-source-row", reactive: true, track_hover: true });
                const srcRowLabel = new St.Label({ text: displayText, style_class: "quicksearch-ai-source-title" });
                try {
                    const ct = srcRowLabel.get_clutter_text();
                    ct.set_line_wrap(false);
                    if (typeof ct.set_ellipsize === 'function') ct.set_ellipsize(Pango.EllipsizeMode.END);
                } catch (e) {}
                srcRow.set_child(srcRowLabel);
                const url = src.url;
                srcRow.connect("clicked", () => {
                    try {
                        const trimmed = String(url || "").trim();
                        if (!/^https?:\/\/.+/i.test(trimmed)) return;
                        try {
                            const parsed = new URL(trimmed);
                            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
                        } catch (e) { return; }
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
                });
                ov.resultsBox.add_child(srcRow);
            } catch (e) {}
        }
    }

    _submitAIQuery(raw) {
        const q = String(raw || "").trim();
        if (!q) return;
        if (!convMod || !this._conversation) { this._aiLoading = false; return; }

        const conv = this._conversation;
        // Phase 8 §12 rapid-send contract: cancel the active request (partial preserved as
        // 'cancelled'), append the new user message, open a fresh streaming assistant message.
        const settled = convMod.rapidSend(conv, q);
        const assistantId = settled ? settled.assistantId : null;
        this._aiGen++;
        const myGen = this._aiGen;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiLoading = true;
        this._aiStreaming = false;
        this._renderAIState();
        if (!this._aiEngine) this._createAiEngine();
        if (!this._aiEngine) {
            if (myGen !== this._aiGen || this._mode !== 'ai') return;
            this._aiLoading = false;
            if (assistantId != null) convMod.failAssistant(conv, assistantId, { code: 'provider_error' });
            this._renderAIState();
            return;
        }

        // Phase 8 §3/§4: bounded prior history (excludes the current user message — the
        // engine always sends it as the live query).
        const history = convMod.getHistory(conv, 10);
        const self = this;
        function _check() { return myGen !== self._aiGen || self._mode !== 'ai'; }
        function _render() { if (!_check()) self._renderAIState(); }

        // Try streaming path first (§5: chunks append to the same assistant message)
        if (typeof this._aiEngine.searchStream === 'function') {
            try {
                this._aiEngine.searchStream(q, null, {
                    onStart: function() {
                        if (_check() || assistantId == null) return;
                        self._aiLoading = false;
                        self._aiStreaming = true;
                        _render();
                    },
                    onDelta: function(chunk, fullText) {
                        if (_check() || assistantId == null) return;
                        self._aiLoading = false;
                        self._aiStreaming = true;
                        convMod.updateAssistant(conv, assistantId, fullText || '');
                        _render();
                    },
                    onComplete: function(data) {
                        if (_check() || assistantId == null) return;
                        self._aiLoading = false;
                        self._aiStreaming = false;
                        const text = data && typeof data.text === 'string' ? data.text : String((data && data.text) || '');
                        const sources = Array.isArray(data && data.sources) ? data.sources : [];
                        convMod.completeAssistant(conv, assistantId, text, sources);
                        _render();
                    },
                    onError: function(err) {
                        if (_check() || assistantId == null) return;
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
                if (assistantId != null) convMod.failAssistant(conv, assistantId, { code: 'provider_error', message: e && e.message });
                _render();
            }
            return;
        }

        // Fallback: non-streaming path
        const cbs = {
            onAnswer: (data) => {
                if (_check() || assistantId == null) return;
                self._aiLoading = false;
                self._aiStreaming = false;
                convMod.completeAssistant(conv, assistantId,
                    data && typeof data.text === 'string' ? data.text : String((data && data.text) || ''),
                    Array.isArray(data && data.sources) ? data.sources : []);
                _render();
            },
            onError: (err) => {
                if (_check() || assistantId == null) return;
                const code = err && err.code ? err.code : 'provider_error';
                self._aiLoading = false;
                self._aiStreaming = false;
                if (code === 'cancelled') convMod.cancelAssistant(conv, assistantId);
                else convMod.failAssistant(conv, assistantId, err || { code });
                _render();
            },
            onDone: (err, data) => {
                if (_check() || assistantId == null) return;
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
                    convMod.completeAssistant(conv, assistantId, data.text || '', Array.isArray(data.sources) ? data.sources : []);
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
            if (assistantId != null) convMod.failAssistant(conv, assistantId, { code: 'provider_error', message: e && e.message });
            _render();
        }
    }

    // Phase 8 §6/§7: user-visible Stop — calls the existing internal cancellation lifecycle
    // (engine.cancel() invalidates late callbacks; conversation marks the message 'cancelled').
    _stopAI() {
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        try { this._renderAIState(); } catch (e) {}
    }

    // Phase 8 §13: deterministic conversation reset — cancel active, clear model + UI.
    _resetConversation() {
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.reset(this._conversation); } catch (e) {} }
        try { this._renderAIState(); } catch (e) {}
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
        // across open/close — only the Reset button clears it (§13).
        this._mode = 'search';
        this._aiLoading = false;
        this._aiStreaming = false;
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._overlay.open(global.get_current_time());
        this._overlay.dialogLayout.set_height(global.screen_height - 2);
        global.stage.set_key_focus(this._overlay._entry);
        this._overlay._startCaretBlink();
        this._overlay.setText("");
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
        try { if (this._contextMenu) this._contextMenu.hide(); } catch (e) {}
        if (this._engine) this._engine.cancel();
        if (this._aiEngine) try { this._aiEngine.cancel(); } catch (e) {}
        this._aiGen++;
        this._aiLoading = false;
        this._aiStreaming = false;
        if (convMod && this._conversation) { try { convMod.cancelActive(this._conversation); } catch (e) {} }
        this._cancelPopupHide();
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        if (this._overlay) {
            try { this._overlay._stopCaretBlink(); } catch (e) {}
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

    _syncRegionGeometry() {
        const ov = this._overlay;
        if (!ov || !ov.resultsRegion) return;
        const pw = Math.round(ov._entryRow.get_transformed_size()[0]) || 0;
        if (pw > 0) this._lastPanelWidth = pw;
        const w = pw || this._lastPanelWidth || 690;
        const pillTf = ov._entryRow.get_transformed_position();
        const pillBottom = (pillTf[1] || 146) + (ov._entryRow.get_transformed_size()[1] || 54);
        const roomCap = Math.max(320, global.screen_height - pillBottom - 6 - 12);
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
            const mainH = Math.min(natH, 664, roomCap);
            ov._scroll.set_position(0, 0);
            ov._scroll.set_size(w, mainH);
            h = mainH;
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
            ov._autoScroll.set_position(0, 0);
            ov._autoScroll.set_size(w, autoH);
            h = Math.max(h, autoH);
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
            if (this._contextMenu && this._contextMenu.isVisible()) { this._contextMenu.hide(); return Clutter.EVENT_STOP; }
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (this._mode === 'ai') {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                try { this._submitAIQuery(this._overlay ? this._overlay.getText() : ""); } catch (e) {}
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

        const mainRows = [];
        for (let s = 0; s < SECTION_ORDER.length; s++) {
            const type = SECTION_ORDER[s][0];
            const header = SECTION_ORDER[s][1];
            const group = results.filter(r => r.type === type);
            if (!group.length) continue;
            if (header) mainRows.push({ header: header });
            for (const r of group) mainRows.push({ result: r });
        }
        this._renderMainRows(mainRows);
    }

    _renderMainRows(flat) {
        const box = this._overlay.resultsBox;
        while (box.get_n_children() > 0) box.remove_child(box.get_child_at_index(0));
        this._mainRows = [];
        for (let i = 0; i < flat.length; i++) {
            const item = flat[i];
            if (item.header) {
                box.add_child(new St.Label({
                    text: item.header,
                    style_class: "quicksearch-section-header"
                }));
                continue;
            }
            const row = this._buildRow(item);
            this._mainRows.push(row);
            box.add_child(row.button);
        }
        this._overlay._scroll.visible = flat.length > 0;
        this._syncRegionGeometry();
        this._syncSelection();
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

        const button = new St.Button({
            style_class: "quicksearch-row",
            x_align: St.Align.START,
            child: content
        });

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
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        this._cancelPopupHide();
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
