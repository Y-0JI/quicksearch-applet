// ai/marketData/oauth/oauthSecretBackend.js — GJS Secret (libsecret) backend.
// Wraps gi.repository.Secret async callback API into {save,load,clear}.
// No plaintext fallback: missing API fails closed with storage_unavailable.
function _err(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
function createGjsSecretBackend(opts) {
    opts = opts || {};
    const Secret = opts.Secret || null;
    const service = String(opts.service || 'quicksearch-tradingview');
    const account = String(opts.account || 'default');
    if (!Secret || typeof Secret.password_store !== 'function' || typeof Secret.password_lookup !== 'function') {
        throw _err('storage_unavailable', 'GJS Secret API unavailable');
    }
    let schema = null;
    try {
        const flags = (Secret.SchemaFlags && Secret.SchemaFlags.NONE != null) ? Secret.SchemaFlags.NONE : 0;
        // NOTE: enum value 0 is valid — use != null, never || (0 is falsy).
        const attrType = (Secret.SchemaAttributeType && Secret.SchemaAttributeType.STRING != null)
            ? Secret.SchemaAttributeType.STRING : 0;
        schema = Secret.Schema.new('org.cinnamon.quicksearch.tradingview', flags, { service: attrType, account: attrType });
    } catch (e) {
        throw _err('storage_unavailable', 'Secret schema unavailable');
    }
    const attrs = () => ({ service, account });
    function _collection() {
        try {
            if (typeof Secret.COLLECTION_DEFAULT !== 'undefined') return Secret.COLLECTION_DEFAULT;
        } catch (e) {}
        return null;
    }
    async function save(rec) {
        rec = rec || {};
        const payload = JSON.stringify({
            accessToken: rec.accessToken || null,
            refreshToken: rec.refreshToken || null,
            expiresAt: rec.expiresAt != null ? rec.expiresAt : null,
            clientId: rec.clientId || null
        });
        await new Promise((resolve, reject) => {
            try {
                Secret.password_store(schema, attrs(), _collection(), 'QuickSearch TradingView OAuth', payload, null, (src, res) => {
                    try {
                        if (typeof Secret.password_store_finish === 'function') Secret.password_store_finish(res);
                        resolve();
                    } catch (e) { reject(_err('storage_unavailable', 'Secret save failed')); }
                });
            } catch (e) { reject(_err('storage_unavailable', 'Secret save failed')); }
        });
    }
    async function load() {
        const text = await new Promise((resolve, reject) => {
            try {
                Secret.password_lookup(schema, attrs(), null, (src, res) => {
                    try {
                        const v = (typeof Secret.password_lookup_finish === 'function') ? Secret.password_lookup_finish(res) : null;
                        resolve(v);
                    } catch (e) { resolve(null); }
                });
            } catch (e) { reject(_err('storage_unavailable', 'Secret load failed')); }
        });
        if (text == null) return null;
        try {
            const obj = JSON.parse(String(text));
            if (!obj || typeof obj !== 'object') return null;
            return {
                accessToken: obj.accessToken || null,
                refreshToken: obj.refreshToken || null,
                expiresAt: obj.expiresAt != null ? obj.expiresAt : null,
                clientId: obj.clientId || null
            };
        } catch (e) { return null; }
    }
    async function clear() {
        await new Promise((resolve) => {
            try {
                if (typeof Secret.password_clear !== 'function') return resolve();
                Secret.password_clear(schema, attrs(), null, (src, res) => {
                    try { if (typeof Secret.password_clear_finish === 'function') Secret.password_clear_finish(res); } catch (e) {}
                    resolve();
                });
            } catch (e) { resolve(); }
        });
    }
    return { save, load, clear };
}
module.exports = { createGjsSecretBackend };
