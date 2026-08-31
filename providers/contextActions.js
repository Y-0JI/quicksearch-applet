// Pure helper: context menu actions by result.type. DI via env — no Gio import here.
// Returns [{id,label,iconName,enabled,run}] — strict branch by type, no title sniffing.
function getContextActions(result, env) {
    env = env || {};
    const out = [];
    if (!result || typeof result.type !== 'string') return out;

    const push = (a) => { if (a) out.push(a); };

    if (result.type === 'app') {
        const appId = result.appId || '';
        if (!appId) return out;

        let isFav = false; try { isFav = typeof env.isFavorite === 'function' ? !!env.isFavorite(appId) : false; } catch (e) {}
        const canUninstall = !!env.canUninstall;
        let desktopDir = null; try { desktopDir = typeof env.getUserDesktopDir === 'function' ? env.getUserDesktopDir() : null; } catch (e) {}
        let filename = null; try { filename = typeof env.getAppFilename === 'function' ? env.getAppFilename(appId) : null; } catch (e) {}

        push({
            id: 'add_to_panel',
            label: 'Add to panel',
            iconName: 'xsi-list-add',
            enabled: true,
            run: () => {
                try {
                    if (typeof env.ensurePanelLauncher === 'function' && typeof env.acceptNewLauncher === 'function') {
                        env.ensurePanelLauncher();
                        if (typeof env.acceptNewLauncherWithRetry === 'function') env.acceptNewLauncherWithRetry(appId);
                        else env.acceptNewLauncher(appId);
                    } else if (typeof env.acceptNewLauncher === 'function') {
                        env.acceptNewLauncher(appId);
                    }
                } catch (e) {}
            }
        });

        if (desktopDir && filename) {
            push({
                id: 'add_to_desktop',
                label: 'Add to desktop',
                iconName: 'xsi-computer',
                enabled: true,
                run: () => {
                    try { if (typeof env.copyToDesktop === 'function') env.copyToDesktop(filename, desktopDir); } catch (e) {}
                }
            });
        }

        if (isFav) {
            push({
                id: 'remove_from_favorites',
                label: 'Remove from favorites',
                iconName: 'xsi-starred',
                enabled: true,
                run: () => { try { if (typeof env.removeFavorite === 'function') env.removeFavorite(appId); } catch (e) {} }
            });
        } else {
            push({
                id: 'add_to_favorites',
                label: 'Add to favorites',
                iconName: 'xsi-non-starred',
                enabled: true,
                run: () => { try { if (typeof env.addFavorite === 'function') env.addFavorite(appId); } catch (e) {} }
            });
        }

        if (canUninstall && filename) {
            push({
                id: 'uninstall',
                label: 'Uninstall',
                iconName: 'xsi-edit-delete',
                enabled: true,
                run: () => {
                    try { if (typeof env.uninstallApp === 'function') env.uninstallApp(filename); } catch (e) {}
                }
            });
        }

        return out;
    }

    if (result.type === 'file') {
        const p = result.path || '';
        if (!p) return out;

        let launcherId = null;
        try {
            if (typeof env.fileLauncherIdForPath === 'function') launcherId = env.fileLauncherIdForPath(p);
            else if (typeof env.getFileLauncherId === 'function') launcherId = env.getFileLauncherId(p);
        } catch (e) {}

        let isFileFav = false;
        try {
            if (launcherId && typeof env.isFavorite === 'function') isFileFav = !!env.isFavorite(launcherId);
        } catch (e) {}

        push({
            id: 'open_location',
            label: 'Open file location',
            iconName: 'folder-symbolic',
            enabled: true,
            run: () => {
                try { if (typeof env.openFileLocation === 'function') return env.openFileLocation(p); } catch (e) {}
                return false;
            }
        });

        // Add to panel — prefer persistent launcher, fallback to direct addFileToPanel (compat for tests)
        if (env.filePanelSupported !== false) {
            const hasDirectPanel = typeof env.addFileToPanel === 'function';
            const hasLauncherPanel = (typeof env.ensureFileLauncher === 'function' || typeof env.fileLauncherIdForPath === 'function')
                && (typeof env.acceptNewLauncher === 'function' || typeof env.acceptNewLauncherWithRetry === 'function');
            if (hasDirectPanel && !hasLauncherPanel) {
                push({
                    id: 'add_to_panel',
                    label: 'Add to panel',
                    iconName: 'xsi-list-add',
                    enabled: true,
                    run: () => { try { env.addFileToPanel(p); } catch (e) {} }
                });
            } else if (hasLauncherPanel || hasDirectPanel) {
                push({
                    id: 'add_to_panel',
                    label: 'Add to panel',
                    iconName: 'xsi-list-add',
                    enabled: true,
                    run: () => {
                        try {
                            if (hasDirectPanel && !hasLauncherPanel) { env.addFileToPanel(p); return; }
                            let id = launcherId;
                            if (typeof env.ensureFileLauncher === 'function') id = env.ensureFileLauncher(p) || id;
                            if (!id) return;
                            if (typeof env.ensurePanelLauncher === 'function') env.ensurePanelLauncher();
                            if (typeof env.acceptNewLauncherWithRetry === 'function') env.acceptNewLauncherWithRetry(id);
                            else if (typeof env.acceptNewLauncher === 'function') env.acceptNewLauncher(id);
                        } catch (e) {}
                    }
                });
            }
        }

        let desktopDir2 = null; try { desktopDir2 = typeof env.getUserDesktopDir === 'function' ? env.getUserDesktopDir() : null; } catch (e) {}
        if (desktopDir2 && (typeof env.addFileToDesktop === 'function' || typeof env.ensureFileLauncher === 'function')) {
            push({
                id: 'add_to_desktop',
                label: 'Add to desktop',
                iconName: 'xsi-computer',
                enabled: true,
                run: () => {
                    try { if (typeof env.addFileToDesktop === 'function') env.addFileToDesktop(p, desktopDir2); } catch (e) {}
                }
            });
        }

        // Add to favorites — persistent launcher with toggle; fallback direct addFileToFavorites
        if (env.fileFavoritesSupported !== false) {
            const hasDirectFav = typeof env.addFileToFavorites === 'function';
            const hasLauncherFav = launcherId && (typeof env.addFavorite === 'function' || typeof env.removeFavorite === 'function');
            if (hasDirectFav && !hasLauncherFav) {
                push({
                    id: 'add_to_favorites',
                    label: 'Add to favorites',
                    iconName: 'xsi-starred',
                    enabled: true,
                    run: () => { try { env.addFileToFavorites(p); } catch (e) {} }
                });
            } else if (hasLauncherFav || (hasDirectFav && launcherId)) {
                if (isFileFav) {
                    push({
                        id: 'remove_from_favorites',
                        label: 'Remove from favorites',
                        iconName: 'xsi-starred',
                        enabled: true,
                        run: () => {
                            try {
                                if (typeof env.ensureFileLauncher === 'function') env.ensureFileLauncher(p);
                                if (typeof env.removeFavorite === 'function') env.removeFavorite(launcherId);
                                else if (typeof env.removeFileFavorite === 'function') env.removeFileFavorite(p);
                            } catch (e) {}
                        }
                    });
                } else {
                    push({
                        id: 'add_to_favorites',
                        label: 'Add to favorites',
                        iconName: 'xsi-non-starred',
                        enabled: true,
                        run: () => {
                            try {
                                if (typeof env.ensureFileLauncher === 'function') env.ensureFileLauncher(p);
                                if (typeof env.addFavorite === 'function') env.addFavorite(launcherId);
                                else if (typeof env.addFileToFavorites === 'function') env.addFileToFavorites(p);
                            } catch (e) {}
                        }
                    });
                }
            }
        }

        return out;
    }

    // web / url / calc / history / suggestion / unknown → no context menu
    return out;
}

module.exports = { getContextActions };
