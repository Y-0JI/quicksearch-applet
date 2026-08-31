// Helpers for persistent per-file .desktop launchers.
// ponytail: hash 32-bit djb + 32-bit FNV (16 hex) fallback; GLib SHA256 when available.
const FILE_LAUNCHER_PREFIX = "quicksearch-file-";
const FILE_LAUNCHER_SUFFIX = ".desktop";

function _hashPathJS(path) {
    let h1 = 5381 >>> 0;
    for (let i = 0; i < path.length; i++) h1 = ((h1 * 33) ^ path.charCodeAt(i)) >>> 0;
    let h2 = 2166136261 >>> 0;
    for (let i = 0; i < path.length; i++) { h2 ^= path.charCodeAt(i); h2 = Math.imul(h2, 16777619) >>> 0; }
    const p1 = ("00000000" + h1.toString(16)).slice(-8);
    const p2 = ("00000000" + h2.toString(16)).slice(-8);
    return p1 + p2;
}

function hashForPath(path) {
    try {
        if (typeof GLib !== "undefined" && GLib && typeof GLib.compute_checksum_for_string === "function" && GLib.ChecksumType) {
            const h = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, String(path), -1);
            if (h && typeof h === "string" && h.length >= 16) return h.slice(0, 16);
        }
    } catch (e) {}
    return _hashPathJS(String(path));
}

function fileLauncherIdForPath(path) {
    const h = hashForPath(String(path));
    return FILE_LAUNCHER_PREFIX + h + FILE_LAUNCHER_SUFFIX;
}

function _basenameForPath(path) {
    const s = String(path).replace(/\/+$/, "") || "/";
    const base = s.split("/").pop() || "file";
    return base;
}

function _sanitizeName(name) {
    return String(name).replace(/\n/g, " ").replace(/\r/g, " ").trim() || "File";
}

function _escapeDesktopField(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/\n/g, " ").replace(/\r/g, " ");
}

// Desktop Entry Exec is NOT shell — do not shell_quote. URI from Gio.get_uri()
// is already percent-encoded (%20 etc) so plain `xdg-open <uri>` is correct and
// handles spaces/quotes/unicode. Shell quoting would produce literal quotes.
function buildFileLauncherContent(path, uri) {
    const p = String(path);
    const u = String(uri || p);
    const base = _basenameForPath(p);
    const name = _sanitizeName(base);
    const execLine = "xdg-open " + u;
    const lines = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=" + _escapeDesktopField(name),
        "Comment=" + _escapeDesktopField(p),
        "Exec=" + execLine,
        "Icon=text-x-generic-symbolic",
        "Terminal=false",
        "NoDisplay=false",
        "StartupNotify=false",
        "Categories=Utility;",
        "X-QuickSearch-File=true",
        "X-QuickSearch-Path=" + _escapeDesktopField(p),
        ""
    ];
    return lines.join("\n");
}

function buildDesktopLauncherContent(path, uri) {
    return buildFileLauncherContent(path, uri);
}

module.exports = {
    FILE_LAUNCHER_PREFIX,
    FILE_LAUNCHER_SUFFIX,
    hashForPath,
    fileLauncherIdForPath,
    buildFileLauncherContent,
    buildDesktopLauncherContent,
    _hashPathJS
};
