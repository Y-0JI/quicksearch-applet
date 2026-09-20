// ai/marketData/tradingViewMcpAdapter.js — session/capability setup + tools/list +
// read-only call gate + one relist retry. Pure orchestration over injected transport.
let transportMod = null;
try { transportMod = require('./tradingViewMcpTransport.js'); } catch (e) {}
try { if (!transportMod) transportMod = require('./marketData/tradingViewMcpTransport.js'); } catch (e) {}
try { if (!transportMod) transportMod = require('ai/marketData/tradingViewMcpTransport.js'); } catch (e) {}
let registryMod = null;
try { registryMod = require('./toolRegistry.js'); } catch (e) {}
try { if (!registryMod) registryMod = require('./marketData/toolRegistry.js'); } catch (e) {}
try { if (!registryMod) registryMod = require('ai/marketData/toolRegistry.js'); } catch (e) {}

function _makeError(code, message) {
    const e = new Error(String(message || code));
    e.code = code;
    return e;
}
function _extractTextContent(res) {
    try {
        if (res && Array.isArray(res.content)) {
            for (const c of res.content) {
                if (c && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
                    const t = c.text.trim();
                    if (t[0] === '{' || t[0] === '[') {
                        try { return JSON.parse(t); } catch (e) { return t; }
                    }
                    return t;
                }
            }
        }
    } catch (e) {}
    return res;
}

function createMcpAdapter(opts) {
    opts = opts || {};
    if (!transportMod || typeof transportMod.createMcpTransport !== 'function') throw new Error('McpAdapter: transport unavailable');
    if (!registryMod || typeof registryMod.createToolRegistry !== 'function') throw new Error('McpAdapter: registry unavailable');
    const authProvider = opts.authProvider || null;
    const transport = transportMod.createMcpTransport({
        httpRequest: opts.httpRequest,
        endpoint: opts.endpoint,
        supportedVersions: opts.supportedVersions,
        getAccessToken: authProvider && typeof authProvider.getAccessToken === 'function' ? () => authProvider.getAccessToken() : (typeof opts.getAccessToken === 'function' ? opts.getAccessToken : null),
        timeoutMs: opts.timeoutMs,
        initTimeoutMs: opts.initTimeoutMs,
        stateless: opts.stateless,
        requireSession: opts.requireSession
    });
    const registry = registryMod.createToolRegistry({ allowlist: opts.allowlist });
    let ready = false;

    async function refreshTools(cancellable) {
        const res = await transport.call('tools/list', {}, cancellable);
        const list = res && Array.isArray(res.tools) ? res.tools : [];
        registry.update(list);
        return registry.names();
    }
    async function setup(cancellable) {
        await transport.setup(cancellable);
        await refreshTools(cancellable);
        ready = true;
        return { version: transport.version(), tools: registry.names() };
    }
    function isCallable(name) { return registry.isCallable(name); }
    function toolNames() { return registry.names(); }

    async function _rawCall(name, args, cancellable) {
        const res = await transport.call('tools/call', { name, arguments: args || {} }, cancellable);
        return _extractTextContent(res);
    }
    async function callTool(name, args, cancellable) {
        const v = registry.validate(name, args);
        if (!v.ok) throw _makeError(v.code || 'invalid_response', v.error || 'Tool call rejected');
        try {
            return await _rawCall(name, args, cancellable);
        } catch (e) {
            if (e && (e.code === 'unsupported_tool' || /method not found/i.test(String(e.message || '')))) {
                try { await refreshTools(cancellable); } catch (e2) {}
                const v2 = registry.validate(name, args);
                if (!v2.ok) throw _makeError(v2.code || 'unsupported_tool', v2.error || 'Tool unavailable after relist');
                return _rawCall(name, args, cancellable);
            }
            throw e;
        }
    }
    // Test/back-compat path: attempt call even when the tool was absent at setup
    // (exercises the method-not-found → relist → retry path with an empty registry).
    async function callToolAllowMissing(name, args, cancellable) {
        try {
            const v = registry.validate(name, args);
            if (!v.ok && v.code !== 'unsupported_tool') throw _makeError(v.code || 'invalid_response', v.error || 'Tool call rejected');
            if (v.ok) return await _rawCall(name, args, cancellable);
        } catch (e) {
            if (!(e && (e.code === 'unsupported_tool' || /method not found/i.test(String(e.message || ''))))) throw e;
        }
        await refreshTools(cancellable);
        const v2 = registry.validate(name, args);
        if (!v2.ok) throw _makeError(v2.code || 'unsupported_tool', v2.error || 'Tool unavailable after relist');
        return _rawCall(name, args, cancellable);
    }

    return { setup, refreshTools, isCallable, toolNames, callTool, callToolAllowMissing, registry: () => registry, transport: () => transport, isReady: () => ready };
}

module.exports = { createMcpAdapter };
