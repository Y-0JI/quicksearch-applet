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

const resultMod = require('./result.js');
const utilsMod = require('./utils.js');
const appProviderMod = require('./providers/appProvider.js');
const fileProviderMod = require('./providers/fileProvider.js');
const webProviderMod = require('./providers/webProvider.js');
const urlProviderMod = require('./providers/urlProvider.js');
const calculatorProviderMod = require('./providers/calculatorProvider.js');
const aiProviderMod = require('./providers/aiProvider.js');
const searchEngineMod = require('./searchEngine.js');
const aiManagerMod = require('./providers/aiManager.js');
const conversationMod = require('./providers/conversationManager.js');
const toolRegistryMod = require('./providers/toolRegistry.js');
const toolsMod = require('./providers/tools/index.js');
const agentManagerMod = require('./providers/agentManager.js');
const screenCaptureMod = require('./providers/screenCapture.js');
const computerControlMod = require('./providers/computerControl.js');
const permissionPolicyMod = require('./providers/permissionPolicy.js');

const UUID = "quicksearch@yoji";

// live handle for Looking Glass / dbus Eval testing

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
            hint_text: _("Search..."),
            can_focus: true,
            track_hover: true,
            style_class: "quicksearch-entry"
        });

        // mode toggle: SEARCH (default) / ASK AI — single overlay, UI state only
        this._searchModeBtn = this._makeModeBtn("system-search", _("Search"), "search");
        this._aiModeBtn = this._makeModeBtn("starred", _("Ask AI"), "ai");
        const entryRow = new St.BoxLayout({ style_class: "quicksearch-entry-row" });
        this._entryRow = entryRow;
        entryRow.add(this._entry, { expand: true });
        entryRow.add(this._searchModeBtn);
        entryRow.add(this._aiModeBtn);
        // Phase 2.5 floating layout: neutralize inherited chrome paddings;
        // gap between searchbox pill and results panel comes from CSS margin
        this.contentLayout.add_style_class_name("quicksearch-content");
        this.contentLayout.add(entryRow);

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this._scroll = new St.ScrollView({
            style_class: "quicksearch-results",
            x_fill: false, y_fill: false,
            y_align: St.Align.START
        });
        this._scroll.add_actor(this.resultsBox);
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        // floating autocomplete layer: same overlay, custom region where the
        // layer's size is EXCLUDED from layout (only main results drive the
        // region height) and the layer is allocated at the region's top,
        // painting in front of the main results.
        // plain container WITHOUT a layout manager: children are positioned
        // manually in _syncRegionGeometry so the autocomplete layer can float
        // above the main results without affecting their layout
        this.resultsRegion = new St.Widget({ x_expand: true });
        this.contentLayout.add(this.resultsRegion, {
            expand: true, x_fill: true, y_fill: false,
            x_align: St.Align.MIDDLE, y_align: St.Align.START
        });
        this.resultsRegion.add_actor(this._scroll); // child 0: main results

        this.autoCompleteBox = new St.BoxLayout({ vertical: true });
        // autocomplete is capped by buildLocalRows caps -> never scrollable;
        // main results remain the only scrolling area. clip_to_allocation
        // guarantees nothing paints outside the popup border.
        this._autoScroll = new St.BoxLayout({
            vertical: true,
            style_class: "quicksearch-results quicksearch-autocomplete",
            clip_to_allocation: true,
            visible: false
        });
        this._autoScroll.add_actor(this.autoCompleteBox);
        this.resultsRegion.add_actor(this._autoScroll);

        // Phase 4.6: dedicated follow-up input BELOW the conversation panel.
        // Lives inside resultsRegion (positioned manually in
        // _syncRegionGeometry) so it sits flush against the panel bottom,
        // shares the panel's actual width, never scrolls with history, and
        // never triggers the SearchEngine.
        this.followUpRow = new St.BoxLayout({
            style_class: "quicksearch-followup-row",
            visible: false
        });
        this.followUpEntry = new St.Entry({
            hint_text: _("Tanyakan sesuatu..."),
            can_focus: true,
            style_class: "quicksearch-followup"
        });
        this.followUpEntry.clutter_text.connect("text-changed", () => {
            // intentionally no-op: follow-up input never runs local search
        });
        this.followUpEntry.clutter_text.connect("key-press-event", (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) { this._applet.close(); return Clutter.EVENT_STOP; }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                this._applet._submitAIFromFollowUp();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.followUpEntry.x_expand = true;
        const sendIcon = new St.Icon({ icon_name: "go-up-symbolic", icon_size: 14 });
        this.followUpEntry.set_secondary_icon(sendIcon);
        this.followUpEntry.connect("secondary-icon-clicked",
            () => this._applet._submitAIFromFollowUp());
        this.followUpRow.add(this.followUpEntry);
        this.resultsRegion.add_actor(this.followUpRow); // child 2: below panel, on top

        // combined hover region for the autocomplete popup: entry + popup act
        // as one area — moving between them keeps the popup, leaving both
        // hides it (debounced so the gap between surfaces cannot flicker it).
        // reactive:true is required for crossing (enter/leave) events.
        this._entryRow.reactive = true;
        this._autoScroll.reactive = true;
        for (const [actor, key] of [
            [this._entryRow, "_ptrInEntry"],
            [this._autoScroll, "_ptrInPopup"]
        ]) {
            actor.connect("enter-event", () => this._applet._notePointer(key, true));
            actor.connect("leave-event", () => this._applet._notePointer(key, false));
        }

        this._entry.clutter_text.connect("text-changed", (actor) => {
            this._applet.onTextChanged(actor.get_text());
        });

        this._entry.clutter_text.connect("key-press-event", (actor, event) => {
            return this._applet.onKeyPress(event);
        });

        // Click outside closes the overlay. Empirically (XTEST-verified):
        // outside clicks are delivered to the lightbox shade (which covers
        // the screen above everything), inside clicks reach the dialog
        // actors directly — so the lightbox handler IS the outside detector.
        // Fallback (no lightbox, e.g. OSK mode): coords check on the bin.
        if (this._lightbox && this._lightbox.actor) {
            this._outsideClickId = this._lightbox.actor.connect("button-press-event", () => {
                this._applet.close();
                return Clutter.EVENT_STOP;
            });
        } else {
            this._outsideClickId = this._backgroundBin.connect("button-press-event", (actor, event) => {
                const [gx, gy] = event.get_coords();
                if (!this._isInsideDialog(gx, gy)) {
                    this._applet.close();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    _makeModeBtn(icon, accessibleName, mode) {
        const btn = new St.Button({
            style_class: "quicksearch-mode-btn",
            child: new St.Icon({ icon_name: icon, icon_size: 16 }),
            accessible_name: accessibleName,
            can_focus: false
        });
        btn.connect("clicked", () => this._applet.setMode(mode));
        return btn;
    }

    // reflect mode in UI only: hint text + active button highlight
    setModeUi(mode) {
        this._entry.hint_text = mode === "ai" ? _("Ask anything...") : _("Search...");
        const active = " quicksearch-mode-active";
        this._searchModeBtn.style_class = "quicksearch-mode-btn" + (mode === "search" ? active : "");
        this._aiModeBtn.style_class = "quicksearch-mode-btn" + (mode === "ai" ? active : "");
    }

    _isInsideDialog(gx, gy) {
        // Clutter here has no get_transformed_allocation(); use position+size
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

class QuickSearchApplet extends Applet.IconApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.set_applet_icon_name("system-search");
        this.set_applet_tooltip(_("Quick Search"));

        this._overlay = null;
        this._hotkeyName = UUID + "-open";
        this._hotkeyBound = null;
        this._mode = "search"; // SEARCH | AI — Phase 1: UI state only
        this._aiSeq = 0;
        // AIManager is the ONLY AI entry point; the applet knows nothing
        // about concrete providers (Phase 4)
        // Phase 4.5: in-memory conversation (session-only, NOT reset by open())
        this._aiChat = [];   // UI entries: {who:'you'|'ai', text, pending?, isError?}
        this._conversation = conversationMod.createConversationManager({ maxTurns: 8 });
        this._aiManager = aiManagerMod.createAIManager({
            createProviderEngine: (cfg) => aiProviderMod.createAIProvider(cfg),
            registry: aiProviderMod.REGISTRY,
            getProviderId: () => String(this.settings.getValue("ai-provider") || ""),
            getConfig: () => ({
                apiKey: this.settings.getValue("ai-api-key"),
                model: this.settings.getValue("ai-model"),
                endpoint: this.settings.getValue("ai-endpoint"),
                maxTokens: this.settings.getValue("ai-max-tokens")
            })
        });
        this._autoRows = [];
        this._mainRows = [];
        // hover state for the combined entry+popup region
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        this._popupHideId = 0;
        this._lastPanelWidth = 0;

        // ---- settings ----
        this.settings = new Settings.AppletSettings(this, UUID, instance_id);
        this.open_shortcut = "<Super>f";
        this.enable_web = true;
        this.enable_files = true;
        this.ai_vision_supported = false; // Phase 10: opt-in, privacy-safe default
        this.ai_agent_enabled = true;     // Phase 12: agent loop on by default
        this.ai_computer_control = false; // Phase 12: pointer/keyboard opt-in
        this.search_engine = "ddgo";
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
            // two-way binding may hand us the raw value: normalize explicitly,
            // then rebuild so providers pick up the new engine + label
            this.search_engine = v;
            this._applySearchEngineSetting();
            this._rebuildEngine();
        });
        this.settings.bind("file-locations", "file_locations", () => this._rebuildEngine());
        this.settings.bind("max-apps", "max_apps", () => this._rebuildEngine());
        this.settings.bind("max-files", "max_files", () => this._rebuildEngine());
        this.settings.bind("max-web", "max_web", () => this._rebuildEngine());
        this.settings.bind("debounce-ms", "debounce_ms", () => this._rebuildEngine());
        this.settings.bind("show-recent", "show_recent");
        this.settings.bind("recent-queries", "recent_queries_json");
        this.settings.bind("ai-vision-supported", "ai_vision_supported"); // Phase 10
        this.settings.bind("ai-agent-enabled", "ai_agent_enabled");       // Phase 12
        this.settings.bind("ai-computer-control", "ai_computer_control"); // Phase 12

        this._applySearchEngineSetting(); // normalize stored/legacy values once

        // one-time migration: old default <Super>space conflicts with the
        // system input-source switcher (next-input-source). Only touches
        // users who never customized the shortcut.
        if (this.open_shortcut === "<Super>space") {
            this.open_shortcut = "<Super>f"; // bound prop -> auto-persists
        }

        // ---- recents (persisted as JSON string) ----
        try { this._recent = JSON.parse(this.recent_queries_json || "[]") || []; }
        catch (e) { this._recent = []; }

        this._rows = [];
        this._selIdx = -1;
        this._current = [];

        this._createEngine();
        this._bindHotkey();
    }

    _createEngine() {
        if (this._engine) {
            try { this._engine.destroy(); } catch (e) {}
            this._engine = null;
        }
        if (this._toolRegistry) {
            try { this._toolRegistry.destroy(); } catch (e) {}
            this._toolRegistry = null;
        }
        if (this._agent) {
            try { this._agent.destroy(); } catch (e) {}
            this._agent = null;
        }

        this._applySearchEngineSetting(); // defense in depth
        const engineChoice = FALLBACK_URLS[this.search_engine] ? this.search_engine : "ddgo";
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
                fallbackUrlFor: FALLBACK_URLS[engineChoice],
                useInstantAnswers: engineChoice === "ddgo"
            })) : null
        };

        this._appProvider = providers.appProvider; // local suggestion source (Phase 2)

        // Phase 8: tool foundation. Not consulted by any flow yet (Phase 9 wires
        // the agent loop); constructed here so tools share the LIVE provider
        // instances and are rebuilt together with the engine.
        this._toolRegistry = toolRegistryMod.createToolRegistry();
        for (const t of toolsMod.createDefaultTools({
            fileProvider: providers.fileProvider,
            webProvider: providers.webProvider,
            appProvider: providers.appProvider,
            detectUrl: urlProviderMod.detectUrl,
            tryCalculate: calculatorProviderMod.tryCalculate,
            openPath: fileProviderMod.openPath,
            screenCapture: screenCaptureMod.createScreenCapture(), // Phase 10
            // Phase 11: live screen bounds so click validation is exact;
            // fail-closed [0,0] until the stage reports real dimensions
            getScreenBounds: () => {
                try {
                    const w = global.screen_width || global.display.get_width();
                    const h = global.screen_height || global.display.get_height();
                    return [w, h];
                } catch (e) { return [0, 0]; }
            },
            computerControl: computerControlMod.createComputerControl(),
            // Phase 12 hotfix: loader-safe injection (zena strips '../' paths)
            LIMITS: toolRegistryMod.LIMITS,
            validators: {
                validatePoint: computerControlMod.validatePoint,
                validateKey: computerControlMod.validateKey,
                sanitizeText: computerControlMod.sanitizeText,
                validateScroll: computerControlMod.validateScroll
            }
        })) this._toolRegistry.register(t);
        try { global.log("[quicksearch@yoji] tool registry ready: " +
                         this._toolRegistry.list().map(t => t.id).join(", ")); } catch (e) {}

        // Phase 9: agent loop. ASK AI now flows ConversationManager ->
        // AgentManager -> AIManager; the agent reuses the LIVE registry so
        // tools always match the active engine. UI stays a thin renderer.
        this._agent = agentManagerMod.createAgentManager({
            aiAsk: (q, ctx, cb) => this._aiManager.ask(q, ctx, cb),
            registry: this._toolRegistry,
            hasVision: () => !!this.ai_vision_supported, // Phase 10
            limits: toolRegistryMod.LIMITS, // Phase 12 hotfix: loader-safe inject
            // Phase 12: single permission entry point for every tool call
            policy: permissionPolicyMod.createPermissionPolicy({
                isAgentEnabled: () => !!this.ai_agent_enabled,
                isComputerControlAllowed: () => !!this.ai_computer_control
            }),
            requestConfirmation: (req, cb) => this._confirmTool(req, cb)
        });

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
    }

    _rebuildEngine() {
        this._createEngine();
    }

    // BUG2: accept ids and legacy labels; log clearly, default only as needed
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
        return { ddgo: "DuckDuckGo", google: "Google", bing: "Bing" }[id] || "DuckDuckGo";
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
        // Phase 2.5: fixed invisible frame -> vertical centering never shifts,
        // searchbox pill stays put while the floating results panel grows below
        this._overlay.open(global.get_current_time());
        this._overlay.dialogLayout.set_height(global.screen_height - 2);
        global.stage.set_key_focus(this._overlay._entry);
        // initial state is ALWAYS empty + SEARCH mode: no stale text/results/recents
        this._overlay.setText("");
        this._aiSeq++;
        this._mode = "search";
        this._overlay.setModeUi(this._mode);
        if (this._overlay.followUpRow) this._overlay.followUpRow.visible = false;
        this._showPill();
        this.renderResults([]);
    }

    // ---- mode (Phase 1: UI state only, no AI requests yet) ----

    setMode(mode) {
        if (!this._overlay || (mode !== "search" && mode !== "ai")) return;
        if (this._mode === mode) return;
        this._aiSeq++; // invalidate any pending AI response across modes
        if (this._aiManager && this._aiManager.cancel) this._aiManager.cancel(); // Phase 5
        if (this._agent && this._agent.cancel) this._agent.cancel(); // Phase 9: kill whole run
        this._closeConfirmDialog();
        this._mode = mode;
        // switching cancels active search and clears results; query text is kept
        if (this._engine) this._engine.cancel();
        this.renderResults([]);
        if (mode === "ai" && this._aiChat.length) this._renderAIChat(); // resume conversation
        this._selIdx = -1;
        this._overlay.setModeUi(mode);
        if (this._overlay.followUpRow) {
            this._overlay.followUpRow.visible =
                (mode === "ai" && this._aiChat.length > 0);
        }
        if (mode === "ai" && this._aiChat.length > 0) this._hidePillAnimated();
        else this._showPill();
        global.stage.set_key_focus(this._overlay._entry);
    }

    close() {
        if (this._engine) this._engine.cancel();
        if (this._aiManager && this._aiManager.cancel) this._aiManager.cancel(); // Phase 5
        if (this._agent && this._agent.cancel) this._agent.cancel(); // Phase 9: kill whole run
        this._closeConfirmDialog();
        this._aiSeq++;
        this._cancelPopupHide();
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        // sweep pending Thinking bubbles so reopen never shows a stuck state
        for (const e of this._aiChat) {
            if (e.pending) { e.text = _("— dibatalkan —"); e.pending = false; }
        }
        if (this._overlay) this._overlay.close(global.get_current_time());
    }

    // ---- input flow ----

    onTextChanged(text) {
        this._selIdx = -1;
        if (this._mode === "ai") {
            // ASK AI: typing never runs the SearchEngine or local providers;
            // the AI request happens only on Enter (_submitAI)
            this._engine.cancel();
            this._renderAutocomplete([]);
            if (!text.trim()) this.renderResults([]); // reset panel when cleared
            return;
        }
        // floating autocomplete layer: computed per keystroke, rendered in
        // its own container in front of main results (never concatenated)
        this._renderAutocomplete(this._buildLocals(text));
        if (!text.trim()) {
            // empty query: strictly no results and no auto-rendered recents
            this._engine.cancel();
            this.renderResults([]);
            return;
        }
        // combobox setValue may not fire the bind callback on this Cinnamon
        // build: detect engine change lazily right before querying
        if (this._applySearchEngineSetting() !== this._engineForId) {
            this._rebuildEngine();
        }
        this._engine.query(text, (results) => this.renderResults(results));
    }

    // explicit geometry: the framework ignores custom preferred-size vfuncs,
    // so drive the region size directly (width = searchbox pill, height =
    // whichever layers are visible); children are placed explicitly.
    _syncRegionGeometry() {
        const ov = this._overlay;
        if (!ov || !ov.resultsRegion) return;
        // width follows the actual searchbox pill; when the pill is hidden
        // (AI conversation mode) reuse the last measured width so the panel,
        // autocomplete popup and follow-up input all stay the same responsive
        // size instead of a hard-coded one.
        const pw = Math.round(ov._entryRow.get_transformed_size()[0]) || 0;
        if (pw > 0) this._lastPanelWidth = pw;
        const w = pw || this._lastPanelWidth || 690;
        // physical fit: everything (panel + attached follow-up) stays on screen
        const pillTf = ov._entryRow.get_transformed_position();
        const pillBottom = (pillTf[1] || 146) + (ov._entryRow.get_transformed_size()[1] || 54);
        const fuVisible = !!(ov.followUpRow && ov.followUpRow.visible && ov._scroll.visible);
        let fuH = 0;
        if (fuVisible) {
            ov.followUpRow.set_width(w); // responsive: follows actual panel width
            try {
                const [, fnat] = ov.followUpRow.get_preferred_height(w);
                fuH = Number(fnat) || 0;
            } catch (e) { fuH = 0; }
            if (fuH <= 0) fuH = 44;
        }
        const roomCap = Math.max(320, global.screen_height - pillBottom - 6 - fuH - 12);
        let h = 0;
        if (ov._scroll.visible) {
            // reliable source: measure the CONTENT (resultsBox) directly.
            // St.ScrollView's own preferred height can report a stale minimal
            // value right after rows are refilled, shrinking the panel to a
            // sliver under the autocomplete layer.
            let natH = 0;
            try {
                const [ , contentNat] = ov.resultsBox.get_preferred_height(w);
                natH = Number(contentNat) || 0;
            } catch (e) { natH = 0; }
            if (natH <= 0) {
                const [, fb] = ov._scroll.get_preferred_height(w);
                natH = Number(fb) || 0;
            }
            natH += 16; // panel padding + border allowance
            const mainH = Math.min(natH, 664, roomCap);
            ov._scroll.set_position(0, 0);
            ov._scroll.set_size(w, mainH);
            h = mainH;
            // follow-up sits flush against the conversation panel bottom,
            // outside the ScrollView so it never scrolls with history
            if (fuVisible) {
                ov.followUpRow.set_position(0, mainH + 6);
                h = mainH + 6 + fuH;
            }
        }
        if (ov._autoScroll.visible) {
            // measure the actual rows container: the scroll widget's own
            // preferred height can go stale when rows are rebuilt
            let natH = 0;
            try {
                const [ , cNat] = ov.autoCompleteBox.get_preferred_height(w);
                natH = Number(cNat) || 0;
            } catch (e) { natH = 0; }
            if (natH <= 0) {
                const [, fb] = ov._autoScroll.get_preferred_height(w);
                natH = Number(fb) || 0;
            }
            natH += 16; // panel padding + border allowance
            // no fixed px cap here: the clamp went stale when row sizes
            // changed and clipped rows outside the popup; roomCap alone
            // keeps the popup fully on screen
            const autoH = Math.min(natH, roomCap);
            ov._autoScroll.set_position(0, 0);
            ov._autoScroll.set_size(w, autoH);
            h = Math.max(h, autoH);
            ov._autoScroll.raise_top();
        }
        ov.resultsRegion.set_size(w, h);
    }

    // ---- clickable links in AI answers (untrusted -> scheme-whitelisted) ----
    _openExternalUrl(url) {
        try {
            Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
        } catch (e) { /* never crash */ }
    }

    // ---- autocomplete popup hover lifecycle ----
    // entry + popup form one combined hover region: the popup only hides when
    // the pointer leaves BOTH; moving between them never closes it (debounce
    // covers the small gap between the two surfaces).
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
                this._syncRegionGeometry(); // reclaim the popup's region space
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- Phase 4.6: main pill hide/show (animated, non-blocking) ----
    _hidePillAnimated() {
        const row = this._overlay ? this._overlay._entryRow : null;
        if (!row || !row.visible) return;
        try {
            row.ease({
                opacity: 0, translation_y: -18,
                duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => { row.hide(); row.opacity = 255; row.translation_y = 0; }
            });
        } catch (e) { row.hide(); }
    }

    _showPill() {
        const row = this._overlay ? this._overlay._entryRow : null;
        if (!row) return;
        row.show();
        row.opacity = 255;
        row.translation_y = 0;
    }

    _newConversation() {
        this._aiSeq++; // drop pending AI callbacks
        if (this._agent && this._agent.cancel) this._agent.cancel(); // Phase 12
        this._closeConfirmDialog();
        this._conversation.clear();
        this._aiChat = [];
        this._showPill();
        const fu = this._overlay ? this._overlay.followUpRow : null;
        if (fu) fu.visible = false;
        // full reset to the initial state: empty entry, no panel below
        this._overlay.setText("");
        this.renderResults([]);
        global.stage.set_key_focus(this._overlay._entry);
    }

    // ---- Phase 4/4.5: ASK AI conversational inline panel ----

    _submitAI(questionOverride) {
        const question = String(questionOverride != null ? questionOverride
            : (this._overlay ? this._overlay.getText() : "")).trim();
        if (!question) return;
        const token = ++this._aiSeq;
        // Phase 5: abort the previous in-flight request for real
        if (this._aiManager && this._aiManager.cancel) this._aiManager.cancel();
        if (this._agent && this._agent.cancel) this._agent.cancel(); // Phase 9
this._closeConfirmDialog();
                // a newer submit supersedes older pending ones (single-flight):
        // mark stale Thinking bubbles instead of leaving them stuck
        for (const e of this._aiChat) {
            if (e.pending) { e.text = _("— dibatalkan —"); e.pending = false; }
        }

        // UI: append the user bubble + a pending AI bubble (Thinking is a
        // UI-only loading state, never conversation history)
        const firstQuestion = this._aiChat.length === 0;
        this._aiChat.push({ who: "you", text: question });
        const pend = { who: "ai", text: _("Thinking..."), pending: true, token: token };
        this._aiChat.push(pend);
        if (firstQuestion) this._hidePillAnimated(); // pill gives way to the panel
        this._renderAIChat();

        // Phase 9/12: ASK AI is agent-capable; "Enable AI Agent" OFF falls
        // back to the plain one-shot AI path (pre-Phase-9 behavior).
        const askFn = this.ai_agent_enabled
            ? (q, ctx, cb) => this._agent.run(q, ctx, cb)
            : (q, ctx, cb) => this._aiManager.ask(q, ctx, cb);
        this._conversation.send(question, askFn, (err, res) => {
            if (token !== this._aiSeq) return; // stale response, drop it
            if (err) {
                // guardrail: rollback the failed user bubble from the UI;
                // ConversationManager already rolled back its history
                const lastYou = [...this._aiChat].reverse().findIndex(e => e.who === "you");
                if (lastYou !== -1) this._aiChat.splice(this._aiChat.length - 1 - lastYou, 1);
                pend.text = this._aiErrorText(err.error || "", err.detail || "");
                pend.pending = false;
                pend.isError = true;
            } else {
                pend.text = (res && res.answer) ? res.answer : _("(empty response)");
                pend.pending = false;
            }
            this._renderAIChat();
        });
    }

    _submitAIFromFollowUp() {
        const fu = this._overlay ? this._overlay.followUpEntry : null;
        if (!fu) return;
        const q = String(fu.get_text() || "").trim();
        if (!q) return;
        fu.set_text("");
        this._submitAI(q);
    }

    _renderAIChat() {
        const box = this._overlay.resultsBox;
        while (box.get_n_children() > 0) box.remove_child(box.get_child_at_index(0));
        this._mainRows = [];
        this._autoRows = [];
        this._rows = [];
        this._selIdx = -1;
        if (this._overlay._autoScroll) this._overlay._autoScroll.visible = false;
        this._overlay._scroll.visible = true;

        // header: AI + New Conversation (+) action
        const head = new St.BoxLayout({ vertical: false });
        head.add_child(new St.Label({
            text: _("AI"),
            style_class: "quicksearch-section-header"
        }));
        head.add_child(new St.Label({ text: "" })); // spacer via expand below
        if (this._aiChat.length > 0) {
            const plus = new St.Button({
                style_class: "quicksearch-newchat-btn",
                child: new St.Icon({ icon_name: "list-add-symbolic", icon_size: 14 }),
                can_focus: false
            });
            plus.set_x_align(Clutter.ActorAlign.END);
            plus.set_x_expand(true);
            plus.connect("clicked", () => this._newConversation());
            head.add_child(plus);
        }
        head.set_x_expand(true);
        box.add_child(head);

        // follow-up input appears below the panel once a conversation started
        const fu = this._overlay.followUpRow;
        if (fu) fu.visible = this._aiChat.length > 0;

        if (this._aiChat.length === 0) {
            box.add_child(new St.Label({
                text: _("Tanya apa saja. Tekan Enter untuk mengirim."),
                style_class: "quicksearch-desc"
            }));
        }
        for (const e of this._aiChat) {
            const who = e.who === "you" ? _("Anda") : _("AI");
            box.add_child(new St.Label({
                text: who,
                style_class: "quicksearch-chat-header " +
                    (e.who === "you" ? "quicksearch-chat-you" : "quicksearch-chat-ai")
            }));
            // plain text bubble: user input and transient states carry no links
            if (e.who !== "ai" || e.pending) {
                const lbl = new St.Label({
                    text: String(e.text),
                    style_class: "quicksearch-ai-text" + (e.isError ? " quicksearch-ai-error" : "")
                });
                lbl.get_clutter_text().set_line_wrap(true);
                box.add_child(lbl);
                continue;
            }
            box.add_child(this._buildAITextFlow(e.text, e.isError));
        }
        this._syncRegionGeometry();
    }

    // AI answers render as one inline flow: text runs interleaved with
    // clickable URL buttons at their original positions (text -> URL -> text).
    // No duplicate link list is appended after the response.
    _buildAITextFlow(text, isError) {
        const flow = new St.BoxLayout({
            vertical: true,
            style_class: "quicksearch-ai-text" + (isError ? " quicksearch-ai-error" : "")
        });
        let line = null;
        const newLine = () => {
            line = new St.BoxLayout({ vertical: false, style_class: "quicksearch-ai-line" });
            flow.add_child(line);
        };
        const addRun = (txt) => {
            const lbl = new St.Label({
                text: txt,
                style_class: "quicksearch-ai-run" + (isError ? " quicksearch-ai-error" : "")
            });
            lbl.get_clutter_text().set_line_wrap(true);
            line.add_child(lbl);
        };
        newLine();
        for (const seg of utilsMod.splitTextAndUrls(text)) {
            if (seg.type === "text") {
                const parts = String(seg.value).split("\n");
                for (let i = 0; i < parts.length; i++) {
                    if (i > 0) {
                        newLine();
                        if (!parts[i]) addRun(" "); // blank line stays visible
                    }
                    if (parts[i]) addRun(parts[i]);
                }
            } else {
                const url = seg.value;
                const link = new St.Button({
                    label: url,
                    style_class: "quicksearch-link-btn"
                });
                const cl = link.get_child();
                if (cl && cl.get_clutter_text) cl.get_clutter_text().set_line_wrap(true);
                link.set_y_align(Clutter.ActorAlign.CENTER);
                link.connect("clicked", () => this._openExternalUrl(url)); // http/https only
                line.add_child(link);
            }
        }
        return flow;
    }

    // Phase 12: human-in-the-loop for confirm-class tool calls. The agent
    // pauses; nothing executes until a button is pressed. Closing the overlay
    // / switching mode cancels the run, and the pending dialog closes with it
    // (stale approvals are dropped by the agent's generation guard).
    _confirmTool(req, cb) {
        try {
            const argsPreview = (() => {
                try { return JSON.stringify(req.args || {}).slice(0, 160); }
                catch (e) { return ""; }
            })();
            const risk = String(req.risk || "").toUpperCase();
            const title = _("Agent meminta izin") + " [" + risk + "]";
            const body = req.tool + (argsPreview ? "\n" + argsPreview : "");

            this._closeConfirmDialog(); // one dialog at a time
            const dlg = new ModalDialog.ModalDialog({ destroyOnClose: false });
            this._confirmDialog = dlg;

            const label = new St.Label({ text: title + "\n\n" + body });
            dlg.contentLayout.add(label);

            const denyBtn = new St.Button({
                label: _("Batal"),
                style_class: "dialog-button",
                can_focus: true
            });
            denyBtn.connect("clicked", () => {
                this._closeConfirmDialog();
                cb(false);
            });
            const allowBtn = new St.Button({
                label: _("Izinkan"),
                style_class: "dialog-button",
                can_focus: true
            });
            allowBtn.connect("clicked", () => {
                this._closeConfirmDialog();
                cb(true);
            });
            dlg.setButtons([denyBtn, allowBtn]);
            dlg.open(global.get_current_time());
        } catch (e) {
            // dialog unavailable -> fail-closed, never auto-approve
            cb(false);
        }
    }

    _closeConfirmDialog() {
        if (this._confirmDialog) {
            try { this._confirmDialog.destroy(); } catch (e) {}
            this._confirmDialog = null;
        }
    }

    _aiErrorText(code, detail) {
        code = String(code || "");
        let base;
        if (code.indexOf("http-5") === 0) {
            base = _("Server AI bermasalah. Coba lagi nanti."); // 5xx (Phase 5)
        } else {
            switch (code) {
                case "no-api-key": base = _("AI API key belum diatur."); break;
                case "http-401": base = _("API key tidak valid."); break;
                case "http-429": base = _("Request AI terlalu banyak. Coba lagi nanti."); break;
                case "timeout":
                case "network": base = _("AI tidak dapat dihubungi."); break;
                case "bad-response": base = _("Response AI tidak valid."); break;
                case "max-steps": base = _("Agent mencapai batas langkah."); break; // Phase 9
                case "permission-denied": base = _("Aksi dibatalkan karena izin ditolak."); break; // Phase 12
                default: base = _("Terjadi kesalahan pada AI.");
            }
        }
        // provider/router messages (e.g. from 9Router) are informative —
        // show them alongside the friendly line instead of hiding them
        if (detail) return base + "\n" + String(detail).slice(0, 240);
        return base;
    }

    // Phase 2: instant local rows (history + suggestions) for the typed query.
    // Never rendered on empty query — empty state stays strict searchbox-only.
    _buildLocals(text) {
        if (this._mode !== "search" || !text.trim()) return [];
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

    // renders the floating autocomplete layer; hidden when no local rows
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
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_KP_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            this.setMode(this._mode === "search" ? "ai" : "search");
            return Clutter.EVENT_STOP;
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
            if (this._mode === "ai") {
                this._submitAI(); // ASK AI: Enter submits to the provider only
                return Clutter.EVENT_STOP;
            }
            if (this._selIdx >= 0 && this._rows[this._selIdx]) {
                this.activateRow(this._rows[this._selIdx]);
                return Clutter.EVENT_STOP;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (!this._rows.length) return;
        let idx = this._selIdx < 0 ? 0 : this._selIdx + delta;
        idx = Math.max(0, Math.min(idx, this._rows.length - 1)); // clamp at ends
        this.setSelection(idx);
        // crossing out of the autocomplete range hides the layer; moving back
        // into it shows it again
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
            // only the main results area scrolls; keep the selected row visible
            const scroll = this._overlay._scroll;
            if (!scroll.visible) return;
            const vbar = scroll.get_vscroll_bar();
            const adj = vbar.get_adjustment();
            const [sx, sy] = scroll.get_transformed_position();
            const [bx, by] = button.get_transformed_position();
            const rowTop = by - sy + adj.value;      // content-space position
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
            // local row activated: apply query, then drop the autocomplete
            // layer immediately so main results take over
            this._overlay.setText(r.query);
            this.onTextChanged(r.query);
            const auto = this._overlay._autoScroll;
            if (auto) {
                auto.visible = false;
                this._selIdx = Math.min(this._autoRows.length,
                                        Math.max(0, this._mainRows.length - 1));
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

    // ---- rendering (spec §16 sections; provider data only -> UI here) ----


    renderResults(results) {
        this._current = results;

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
        // compact empty state: no reserved space under the searchbox
        this._overlay._scroll.visible = flat.length > 0;
        this._syncRegionGeometry();
        this._syncSelection();
    }

    // selection spans both layers: autocomplete rows first, then main rows
    _syncSelection() {
        const hidden = this._overlay && !this._overlay._autoScroll.visible;
        const startAt = hidden ? Math.min(this._autoRows.length,
                                          Math.max(0, this._rows ? this._autoRows.length : 0)) : 0;
        this._rows = this._autoRows.concat(this._mainRows);
        this._selIdx = -1;
        if (this._rows.length) {
            this.setSelection(Math.min(startAt, this._rows.length - 1));
        }
    }

    _buildRow(item) {
        const isRecent = item.type === "recent";
        const r = isRecent ? item : item.result;

        const icon = new St.Icon({
            icon_size: 24,
            x_align: Clutter.ActorAlign.START
        });
        if (typeof r.icon === "string") icon.icon_name = r.icon;
        else if (r.icon) icon.gicon = r.icon;
        else icon.icon_name = "system-search";

        const titleLbl = new St.Label({ text: String(r.title || ""), style_class: "quicksearch-title" });
        titleLbl.get_clutter_text().set_line_wrap(false);
        // single-line rows must never overflow the popup: ellipsize instead
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
        return row;
    }

    // ---- lifecycle cleanup (spec 24-B) ----

    destroySettings() {
        try { this.settings.finalize(); } catch (e) {}
    }

    on_applet_removed_from_panel(reload) {
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        this._cancelPopupHide();
        if (this._engine) {
            this._engine.destroy();
            this._engine = null;
        }
        this.close();
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this.destroySettings();
        this._rows = [];
        this._current = [];
        this._recent = [];
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new QuickSearchApplet(orientation, panel_height, instance_id);
}

module.exports = { main };
