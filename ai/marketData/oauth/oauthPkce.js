// ai/marketData/oauth/oauthPkce.js — standards PKCE (S256) + state. No I/O.
// Order: node:crypto → GJS GLib.Checksum (injected via setGjs) → WebCrypto.
// Math.random is the last-resort entropy fallback (never for S256 digest).
let _nodeCrypto = null;
try { _nodeCrypto = require('node:crypto'); } catch (e) {}
let _GLib = null;
function setGjs(GLib) { _GLib = GLib || null; }
function _gjs() {
    if (_GLib) return _GLib;
    try {
        if (typeof imports !== 'undefined' && imports.gi && imports.gi.GLib) return imports.gi.GLib;
    } catch (e) {}
    return null;
}
function _randomBytes(n) {
    if (_nodeCrypto && typeof _nodeCrypto.randomBytes === 'function') {
        return _nodeCrypto.randomBytes(n);
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
}
function _b64url(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const GLib = _gjs();
    if (GLib && typeof GLib.base64_encode === 'function') {
        try {
            const b64 = GLib.base64_encode(arr);
            if (typeof b64 === 'string' && b64) {
                return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
            }
        } catch (e) {}
    }
    let bin = '';
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    let b64 = '';
    try {
        b64 = (typeof Buffer !== 'undefined') ? Buffer.from(bin, 'binary').toString('base64') : btoa(bin);
    } catch (e) { b64 = ''; }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function newCodeVerifier() {
    return _b64url(_randomBytes(32));
}
function _sha256bytes(text) {
    if (_nodeCrypto && typeof _nodeCrypto.createHash === 'function') {
        return new Uint8Array(_nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest());
    }
    const GLib = _gjs();
    if (GLib && GLib.ChecksumType && typeof GLib.compute_checksum_for_string === 'function') {
        try {
            const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, String(text), -1);
            const out = new Uint8Array(hex.length / 2);
            for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
            return out;
        } catch (e) { return null; }
    }
    return null;
}
async function codeChallengeS256(verifier) {
    const digest = _sha256bytes(verifier);
    if (digest) return _b64url(digest);
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
        const data = new TextEncoder().encode(String(verifier));
        const out = await crypto.subtle.digest('SHA-256', data);
        return _b64url(new Uint8Array(out));
    }
    throw new Error('PKCE S256 unavailable in this runtime');
}
function newState() {
    return _b64url(_randomBytes(16));
}
module.exports = { newCodeVerifier, codeChallengeS256, newState, setGjs };
