// Application search via Cinnamon AppSystem (spec §4).
// Sync in-memory index; providers produce data only (no UI).
// NOTE: zena loader mangles "../" requires -> helpers are injected, not imported.
const Gio = require('gi.Gio');
const Main = require('ui.main');
const Cinnamon = require('gi.Cinnamon');

const INTERNAL_LAUNCHER_PREFIX = "quicksearch-file-";

function _isInternalFileLauncher(id, info) {
    if (id && id.indexOf(INTERNAL_LAUNCHER_PREFIX) === 0) return true;
    if (!info) return false;
    try { if (info.has_key && info.has_key("X-QuickSearch-File")) return true; } catch (e) {}
    try { if (info.get_string && info.get_string("X-QuickSearch-File") === "true") return true; } catch (e) {}
    try { if (info.get_boolean && info.get_boolean("X-QuickSearch-File") === true) return true; } catch (e) {}
    return false;
}

function createAppProvider(helpers) {
    const makeResult = helpers.makeResult;
    const scoreResult = helpers.scoreResult;
    const limitDefault = helpers.limits && helpers.limits.app ? helpers.limits.app : 5;
    const appsys = Cinnamon.AppSystem.get_default();
    let index = null;
    let settingsApps = null;
    let installedChangedId = 0;

    function _execBase(execLine) {
        try {
            const toks = String(execLine || '').toLowerCase().trim().split(/\s+/);
            for (let i = 0; i < toks.length; i++) {
                const base = (toks[i] || '').split('/').pop();
                if (base) return base;
                if (toks[i] && toks[i].indexOf('=') === -1) { const b = String(toks[i]).split('/').pop(); if (b) return b; }
            }
        } catch (e) {}
        return '';
    }

    // Dynamic local membership: which installed apps belong to THIS machine's
    // Cinnamon System Settings. Signals are read at runtime from each desktop
    // entry — no module names listed anywhere. A different machine yields a
    // different set automatically.
    function _isSettingsEntry(info, execLine) {
        try {
            if (info && info.get_string && String(info.get_string("X-Cinnamon-Settings-Panel") || '').trim()) return true;
        } catch (e) {}
        const base = _execBase(execLine);
        if (base === 'cinnamon-settings' || base === 'cinnamon-settings-users') return true;
        return false;
    }

    function buildIndex() {
        index = [];
        settingsApps = new Set();
        const apps = appsys.get_all(false);
        for (let i = 0; i < apps.length; i++) {
            const app = apps[i];
            const id = app.get_id();
            if (!id) continue;
            const info = Gio.DesktopAppInfo.new(id);
            if (_isInternalFileLauncher(id, info)) continue;
            let execLine = '';
            try { execLine = info && info.get_string ? String(info.get_string("Exec") || '') : ''; } catch (e) {}
            if (_isSettingsEntry(info, execLine)) { try { settingsApps.add(id); } catch (e) {} }
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
                    installedChangedId = appsys.connect('installed-changed', () => { index = null; settingsApps = null; });
                } catch (e) { /* non-critical */ }
            }
        }
    }

    // Local settings registry snapshot: Set of appIds discovered on THIS
    // machine. Rebuilt with the index; invalidated on installed-changed.
    function getSettingsApps() {
        ensureIndex();
        if (!settingsApps) return new Set();
        return settingsApps;
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
        settingsApps = null;
        if (installedChangedId) {
            try { appsys.disconnect(installedChangedId); } catch (e) {}
            installedChangedId = 0;
        }
    }

    return { searchApps, getSettingsApps, destroy };
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
