const Applet = require('ui.applet');
const Main = require('ui.main');
const ModalDialog = require('ui.modalDialog');
const Settings = require('ui.settings');
const St = require('gi.St');
const Clutter = require('gi.Clutter');
const GObject = require('gi.GObject');

const resultMod = require('./result.js');
const utilsMod = require('./utils.js');
const appProviderMod = require('./providers/appProvider.js');
const fileProviderMod = require('./providers/fileProvider.js');
const webProviderMod = require('./providers/webProvider.js');
const searchEngineMod = require('./searchEngine.js');

const UUID = "quicksearch@yoji";

// live handle for Looking Glass / dbus Eval testing
var debug = { instance: null };

const DEFAULT_LIMITS = { app: 5, file: 15, web: 5 };
const DEBOUNCE_MS = 150;
const RECENT_MAX = 15;

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
        this.contentLayout.add(this._entry);

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this._scroll = new St.ScrollView({
            style_class: "quicksearch-results",
            x_fill: false, y_fill: false,
            y_align: St.Align.START
        });
        this._scroll.add_actor(this.resultsBox);
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.contentLayout.add(this._scroll);

        this._entry.clutter_text.connect("text-changed", (actor) => {
            this._applet.onTextChanged(actor.get_text());
        });

        this._entry.clutter_text.connect("key-press-event", (actor, event) => {
            return this._applet.onKeyPress(event);
        });
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

        // ---- engine assembly (helpers injected; see zena loader note) ----
        const helperDeps = {
            makeResult: resultMod.makeResult,
            scoreResult: resultMod.scoreResult,
            pickFileBackend: utilsMod.pickFileBackend,
            sanitizeGlob: utilsMod.sanitizeGlob,
            limits: DEFAULT_LIMITS
        };
        const providers = {
            appProvider: appProviderMod.createAppProvider(helperDeps),
            fileProvider: fileProviderMod.createFileProvider(helperDeps),
            webProvider: webProviderMod.createWebProvider(helperDeps)
        };
        this._engine = searchEngineMod.createSearchEngine(Object.assign({
            makeResult: resultMod.makeResult,
            scoreResult: resultMod.scoreResult,
            classifyQuery: resultMod.classifyQuery,
            processResults: resultMod.processResults,
            detectUrl: require('./providers/urlProvider.js').detectUrl,
            tryCalculate: require('./providers/calculatorProvider.js').tryCalculate,
            debounceMs: DEBOUNCE_MS,
            enabled: { files: true, web: true } // settings-driven in Task 8
        }, providers));

        this._rows = [];
        this._selIdx = -1;
        this._current = [];
        this._recent = [];

        Main.keybindingManager.addHotKey(this._hotkeyName, "<Super>space", () => this.toggle());
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
        global.stage.set_key_focus(this._overlay._entry);
        const text = this._overlay.getText();
        if (!text.trim()) this.renderResults([]); // shows recents if any
    }

    close() {
        if (this._engine) this._engine.cancel();
        if (this._overlay) this._overlay.close(global.get_current_time());
    }

    // ---- input flow ----

    onTextChanged(text) {
        this._selIdx = -1;
        if (!text.trim() && this._recent.length) {
            this._engine.cancel();
            this.renderRecents();
            return;
        }
        this._engine.query(text, (results) => this.renderResults(results));
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
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(delta) {
        if (!this._rows.length) return;
        let idx = this._selIdx + delta;
        if (idx < 0) idx = this._rows.length - 1;
        if (idx >= this._rows.length) idx = 0;
        this.setSelection(idx);
    }

    setSelection(idx) {
        if (this._selIdx >= 0 && this._rows[this._selIdx]) {
            this._rows[this._selIdx].button.remove_style_class_name("quicksearch-row-selected");
        }
        this._selIdx = idx;
        const row = this._rows[idx];
        if (row) {
            row.button.add_style_class_name("quicksearch-row-selected");
            try {
                row.button.get_allocation_box(); // ensure mapped before scroll
                this._overlay.resultsBox.get_stage().set_key_focus(this._overlay._entry.clutter_text);
            } catch (e) {}
            this._scrollToRow(row.button);
        }
    }

    _scrollToRow(button) {
        try {
            const scroll = this._overlay._scroll;
            const vbar = scroll.get_vscroll_bar();
            const box = button.get_allocation_box();
            const y = box.y1 + this._overlay.resultsBox.get_allocation_box().y1;
            const adj = vbar.get_adjustment();
            const pos = y - adj.get_page_size() / 2;
            adj.set_value(Math.max(0, Math.min(pos, adj.get_upper())));
        } catch (e) {}
    }

    activateRow(row) {
        const r = row.result;
        if (r && r.query !== undefined) {
            // recent-search row: refill and search
            this._overlay.setText(r.query);
            this.onTextChanged(r.query);
            return;
        }
        if (r && r.action) {
            try { r.action(); } catch (e) {
                Main.notifyError(_("Quick Search"), _("Action failed"));
            }
            this._pushRecent(r.sourceQuery || this._overlay.getText());
            this.close();
        }
    }

    _pushRecent(q) {
        q = String(q || "").trim();
        if (!q) return;
        this._recent = [q].concat(this._recent.filter(x => x !== q)).slice(0, RECENT_MAX);
    }

    // ---- rendering (spec §16 sections; provider data only -> UI here) ----

    renderRecents() {
        const rows = this._recent.map(q => ({
            type: "recent",
            title: q,
            description: _("Recent"),
            icon: "document-open-recent",
            query: q
        }));
        this._renderRows(rows);
    }

    renderResults(results) {
        this._current = results;

        const SECTION_ORDER = [
            ["calc", null],
            ["url", null],
            ["app", _("APPLICATIONS")],
            ["file", _("FILES")],
            ["web", _("WEB")]
        ];

        const flat = [];
        for (const [type, header] of SECTION_ORDER) {
            const group = results.filter(r => r.type === type);
            if (!group.length) continue;
            if (header) flat.push({ header: header });
            for (const r of group) flat.push({ result: r });
        }
        this._renderRows(flat);
    }

    _renderRows(flat) {
        const box = this._overlay.resultsBox;
        while (box.get_n_children() > 0) box.remove_child(box.get_child_at_index(0));
        this._rows = [];
        this._selIdx = -1;

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
            this._rows.push(row);
            box.add_child(row.button);
        }

        if (!flat.length) {
            // nothing at all: silent empty state (spec: quick & clean)
        }
        if (this._rows.length) this.setSelection(0); // Enter activates top hit immediately
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
        const descText = isRecent ? _("Recent") : String(r.description || "");
        const descLbl = new St.Label({ text: descText, style_class: "quicksearch-desc" });
        descLbl.get_clutter_text().set_line_wrap(false);

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

    on_applet_removed_from_panel(reload) {
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        if (this._engine) {
            this._engine.destroy();
            this._engine = null;
        }
        this.close();
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._rows = [];
        this._current = [];
        this._recent = [];
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    debug.instance = new QuickSearchApplet(orientation, panel_height, instance_id);
    return debug.instance;
}

module.exports = { QuickSearchApplet, QuickSearchOverlay, main, debug };
