// Pure helpers for file provider (node-testable).

function pickFileBackend(avail) {
    if (avail.hasPlocate) return 'plocate';
    if (avail.hasLocate) return 'locate';
    if (avail.hasFind) return 'find';
    return null;
}

// strip glob metachars so user query can't alter find pattern semantics
function sanitizeGlob(query) {
    return String(query).replace(/[\\*?\[\]]/g, '');
}

module.exports = { pickFileBackend, sanitizeGlob };
