const Applet = require('ui.applet');
const Main = require('ui.main');
const ModalDialog = require('ui.modalDialog');
const Settings = require('ui.settings');
const St = require('gi.St');
const Clutter = require('gi.Clutter');
const GObject = require('gi.GObject');

const UUID = "quicksearch@yoji";

// live handle for Looking Glass / dbus Eval testing
var debug = { instance: null };

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

        this.resultsBox = new St.BoxLayout({
            vertical: true,
            style_class: "quicksearch-results"
        });
        this.contentLayout.add(this.resultsBox);

        this._entry.clutter_text.connect("text-changed", (actor) => {
            this._applet.onTextChanged(actor.get_text());
        });

        this._entry.clutter_text.connect("key-press-event", (actor, event) => {
            return this._applet.onKeyPress(event);
        });
    }

    getText() {
        return this._entry.get_text();
    }

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
        this._engine = null; // wired in Task 7
        this._hotkeyName = UUID + "-open";

        Main.keybindingManager.addHotKey(this._hotkeyName, "<Super>space", () => this.toggle());
    }

    on_applet_clicked() {
        this.toggle();
    }

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
    }

    close() {
        if (this._engine) this._engine.cancel();
        if (this._overlay) this._overlay.close(global.get_current_time());
    }

    onTextChanged(text) {
        if (this._engine) this._engine.query(text);
    }

    onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        // arrow/Enter navigation wired in Task 7
        return Clutter.EVENT_PROPAGATE;
    }

    on_applet_removed_from_panel(reload) {
        Main.keybindingManager.removeHotKey(this._hotkeyName);
        this.close();
        if (this._engine) {
            this._engine.destroy();
            this._engine = null;
        }
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    debug.instance = new QuickSearchApplet(orientation, panel_height, instance_id);
    return debug.instance;
}

module.exports = { QuickSearchApplet, QuickSearchOverlay, main, debug };
