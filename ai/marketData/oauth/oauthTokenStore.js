// ai/marketData/oauth/oauthTokenStore.js — TokenStore abstraction.
// Memory store for tests; Secret store resolves at runtime (GJS verified later).
// Shape: { accessToken, refreshToken, expiresAt, clientId }. No plaintext files.
function createMemoryTokenStore() {
    let record = null;
    return {
        async save(rec) {
            rec = rec || {};
            record = {
                accessToken: rec.accessToken || null,
                refreshToken: rec.refreshToken || null,
                expiresAt: rec.expiresAt != null ? rec.expiresAt : null,
                clientId: rec.clientId || null
            };
        },
        async load() { return record ? Object.assign({}, record) : null; },
        async clear() { record = null; },
        async hasToken() { return !!(record && record.accessToken); }
    };
}
// Secret-backed store: secretBackend { save/load/clear } injected after the
// GJS Secret API is verified. Until then construction fails closed.
function createSecretTokenStore(secretBackend) {
    if (!secretBackend || typeof secretBackend.save !== 'function' || typeof secretBackend.load !== 'function') {
        throw Object.assign(new Error('Secret storage unavailable'), { code: 'storage_unavailable' });
    }
    return {
        async save(rec) { return secretBackend.save(rec); },
        async load() { return secretBackend.load(); },
        async clear() {
            if (typeof secretBackend.clear === 'function') return secretBackend.clear();
        },
        async hasToken() {
            const r = await secretBackend.load();
            return !!(r && r.accessToken);
        }
    };
}
module.exports = { createMemoryTokenStore, createSecretTokenStore };
