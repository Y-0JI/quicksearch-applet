// URL detection: strict, no spaces allowed. Pure module (CJS both sides).

// domain.tld[/path][?query][#hash] — TLD >= 2 letters, or localhost[:port], or IPv4[:port]
const BARE_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:[\/?#]\S*)?$|^localhost(?::\d{2,5})?(?:[\/?#]\S*)?$|^(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?:[\/?#]\S*)?$/i;
const SCHEME_RE = /^https?:\/\/\S+$/i;

// common file extensions colliding with fake one-word domains ("document.pdf")
const FILE_EXT_RE = /\.(txt|pdf|docx?|xlsx?|pptx?|odt|ods|odp|jpe?g|png|gif|webp|svg|zip|rar|7z|tar|gz|xz|bz2|mp3|mp4|mkv|avi|mov|wav|flac|iso|deb|rpm|exe|dmg|py|js|ts|css|json|xml|csv|md)$/i;

function detectUrl(rawQuery) {
    const query = String(rawQuery).trim();
    if (!query || /\s/.test(query)) return null;

    if (SCHEME_RE.test(query)) return query;
    // single dot + file extension => filename, not a domain
    const dots = (query.match(/\./g) || []).length;
    if (dots <= 1 && FILE_EXT_RE.test(query)) return null;
    if (BARE_RE.test(query)) return 'https://' + query;
    return null;
}

module.exports = { detectUrl };
