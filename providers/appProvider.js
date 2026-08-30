// Application search via Cinnamon AppSystem (spec §4).
// Sync in-memory index; providers produce data only (no UI).
// NOTE: zena loader mangles "../" requires -> helpers are injected, not imported.
const Gio = require('gi.Gio');
const Main = require('ui.main');
const Cinnamon = require('gi.Cinnamon');

function createAppProvider(helpers) {
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    const limitDefault = helpers.limits && helpers.limits.app ? helpers.limits.app : 5;
    const appsys = Cinnamon.AppSystem.get_default();
    let index = null;
    let installedChangedId = 0;

    function buildIndex() {
        index = [];
        const apps = appsys.get_all(false);
        for (let i = 0; i < apps.length; i++) {
            const app = apps[i];
            const id = app.get_id();
            if (!id) continue;
            const info = Gio.DesktopAppInfo.new(id);
            index.push({
                app: app,
                appId: id,
                name: app.get_name() || '',
                description: app.get_description() || '',
                keywords: info ? (info.get_keywords() || []) : [],
                executable: info ? String(info.get_executable() || '').toLowerCase() : '',
                gicon: info ? info.get_icon() : null
            });
        }
    }

    function ensureIndex() {
        if (!index) {
            buildIndex();
            if (!installedChangedId) {
                try {
                    installedChangedId = appsys.connect('installed-changed', () => { index = null; });
                } catch (e) { /* non-critical */ }
            }
        }
    }

    function searchApps(query, limit) {
        limit = limit || limitDefault;
        ensureIndex();
        const q = String(query).toLowerCase().trim();
        if (!q || !index) return [];

        // ponytail: O(n) scan per keystroke over ~few hundred entries is fine;
        // switch to prefix map only if profiling ever says otherwise.
        const scored = [];
        for (let i = 0; i < index.length; i++) {
            const e = index[i];
            const name = e.name.toLowerCase();
            let quality = null;
            if (name === q) quality = 'app-exact';
            else if (name.indexOf(q) === 0 || _wordStarts(name, q)) quality = 'app-prefix';
            else if (name.indexOf(q) !== -1) quality = 'app-contains';
            else if (_anyMatch(e.keywords, q)) quality = 'keyword';
            else if (e.executable && e.executable.indexOf(q) === 0) quality = 'keyword';
            else if (e.description && e.description.toLowerCase().indexOf(q) !== -1) quality = 'keyword';

            if (quality) {
                scored.push(makeResult({
                    type: 'app',
                    title: e.name,
                    description: e.description,
                    icon: e.gicon,
                    appId: e.appId,
                    score: scoreResult(quality),
                    action: () => {
                        try {
                            e.app.open_new_window(-1);
                        } catch (err) {
                            Main.notifyError(_("Quick Search"), _("Failed to launch") + " " + e.name);
                        }
                    }
                }));
            }
        }
        return scored;
    }

    function destroy() {
        index = null;
        if (installedChangedId) {
            try { appsys.disconnect(installedChangedId); } catch (e) {}
            installedChangedId = 0;
        }
    }

    return { searchApps, destroy };
}

function _wordStarts(name, q) {
    const idx = name.indexOf(' ' + q);
    return idx !== -1;
}

function _anyMatch(keywords, q) {
    for (let i = 0; i < keywords.length; i++) {
        if (String(keywords[i]).toLowerCase().indexOf(q) === 0) return true;
    }
    return false;
}

module.exports = { createAppProvider };
