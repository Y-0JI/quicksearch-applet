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

        let desktopDir2 = null; try { desktopDir2 = typeof env.getUserDesktopDir === 'function' ? env.getUserDesktopDir() : null; } catch (e) {}
        if (desktopDir2 && typeof env.addFileToDesktop === 'function') {
            push({
                id: 'add_to_desktop',
                label: 'Add to desktop',
                iconName: 'xsi-computer',
                enabled: true,
                run: () => { try { env.addFileToDesktop(p, desktopDir2); } catch (e) {} }
            });
        }

        // Add to panel for file — only if valid persistent launcher can be made (env provides impl)
        if (typeof env.addFileToPanel === 'function' && env.filePanelSupported !== false) {
            push({
                id: 'add_to_panel',
                label: 'Add to panel',
                iconName: 'xsi-list-add',
                enabled: true,
                run: () => { try { env.addFileToPanel(p); } catch (e) {} }
            });
        }

        // Add to favorites for file — via XApp.Favorites, hide if not available
        if (typeof env.addFileToFavorites === 'function' && env.fileFavoritesSupported !== false) {
            push({
                id: 'add_to_favorites',
                label: 'Add to favorites',
                iconName: 'xsi-starred',
                enabled: true,
                run: () => { try { env.addFileToFavorites(p); } catch (e) {} }
            });
        }

        return out;
    }

    // web / url / calc / history / suggestion / unknown → no context menu
    return out;
}

module.exports = { getContextActions };
