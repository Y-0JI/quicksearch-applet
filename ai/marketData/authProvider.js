// ai/marketData/authProvider.js — authentication abstraction (Phase 1: stub only).
// Transport never knows storage. Real OAuth waits for DCR + Secret verification.
function createAuthStub() {
    function getAccessToken() { return Promise.resolve(null); }
    function getAuthStatus() { return 'missing'; }
    function beginAuthorization() {
        return Promise.resolve({ code: 'auth_unavailable', message: 'TradingView OAuth browser flow not yet wired (DCR unverified)' });
    }
    function refreshAccessToken() {
        return Promise.resolve({ code: 'auth_unavailable', message: 'TradingView OAuth refresh not yet wired (DCR unverified)' });
    }
    return { getAccessToken, getAuthStatus, beginAuthorization, refreshAccessToken };
}

module.exports = { createAuthStub };
