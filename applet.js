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
const searchEngineMod = require('./searchEngine.js');

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
        });
        this.settings.bind("file-locations", "file_locations", () => this._rebuildEngine());
        this.settings.bind("max-apps", "max_apps", () => this._rebuildEngine());
        this.settings.bind("max-files", "max_files", () => this._rebuildEngine());
        this.settings.bind("max-web", "max_web", () => this._rebuildEngine());
        this.settings.bind("debounce-ms", "debounce_ms", () => this._rebuildEngine());
        this.settings.bind("show-recent", "show_recent");
        this.settings.bind("recent-queries", "recent_queries_json");
        this.settings.bind("web-search-api-key", "web_search_api_key");
        this.settings.bind("searxng-url", "searxng_url", () => this._rebuildEngine());

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

        this._createEngine();
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
        this._overlay.open(global.get_current_time());
        this._overlay.dialogLayout.set_height(global.screen_height - 2);
        global.stage.set_key_focus(this._overlay._entry);
        this._overlay._startCaretBlink();
        this._overlay.setText("");
        this.renderResults([]);
    }

    close() {
        if (this._engine) this._engine.cancel();
        this._cancelPopupHide();
        this._ptrInEntry = false;
        this._ptrInPopup = false;
        if (this._overlay) {
            try { this._overlay._stopCaretBlink(); } catch (e) {}
            this._overlay.close(global.get_current_time());
        }
    }

    // ---- input flow ----

    onTextChanged(text) {
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
            this.close();
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
            x_align: Clutter.ActorAlign.START
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
        return row;
    }

    // ---- lifecycle cleanup ----

    destroySettings() {
        try { this.settings.finalize(); } catch (e) {}
    }

    on_applet_removed_from_panel(reload) {
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
