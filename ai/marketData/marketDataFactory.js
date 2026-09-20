// ai/marketData/marketDataFactory.js — composes auth + adapter + marketDataTool.
// Disabled by default (no httpRequest → null tool → engine branch inert).
// ponytail: single composer, not a framework. Extend when OAuth lands.
let adapterMod = null;
try { adapterMod = require('./tradingViewMcpAdapter.js'); } catch (e) {}
try { if (!adapterMod) adapterMod = require('./marketData/tradingViewMcpAdapter.js'); } catch (e) {}
try { if (!adapterMod) adapterMod = require('ai/marketData/tradingViewMcpAdapter.js'); } catch (e) {}
let toolMod = null;
try { toolMod = require('./marketDataTool.js'); } catch (e) {}
try { if (!toolMod) toolMod = require('./marketData/marketDataTool.js'); } catch (e) {}
try { if (!toolMod) toolMod = require('ai/marketData/marketDataTool.js'); } catch (e) {}
let authMod = null;
try { authMod = require('./authProvider.js'); } catch (e) {}
try { if (!authMod) authMod = require('./marketData/authProvider.js'); } catch (e) {}
try { if (!authMod) authMod = require('ai/marketData/authProvider.js'); } catch (e) {}
let intentMod = null;
try { intentMod = require('./financialIntent.js'); } catch (e) {}
try { if (!intentMod) intentMod = require('./marketData/financialIntent.js'); } catch (e) {}
try { if (!intentMod) intentMod = require('ai/marketData/financialIntent.js'); } catch (e) {}
let plannerMod = null;
try { plannerMod = require('./minCallPlanner.js'); } catch (e) {}
try { if (!plannerMod) plannerMod = require('./marketData/minCallPlanner.js'); } catch (e) {}
try { if (!plannerMod) plannerMod = require('ai/marketData/minCallPlanner.js'); } catch (e) {}

function _mergeLabelled(kind, parts) {
    const symbols = [];
    const rows = [];
    for (const p of parts) {
        const sym = (p && p.symbols && p.symbols[0]) || '?';
        symbols.push(sym);
        rows.push({ symbol: sym, interval: p && p.interval, data: p && p.rows });
    }
    return { type: 'market_data', kind, symbols, interval: (parts[0] && parts[0].interval) || null, rows, attribution: 'TradingView', sources: [] };
}

function createMarketDataFromConfig(cfg) {
    cfg = cfg || {};
    if (!cfg.enabled || typeof cfg.httpRequest !== 'function') {
        return { marketDataTool: null, adapter: null, auth: null, disabled: true };
    }
    const auth = (authMod && typeof authMod.createAuthStub === 'function') ? authMod.createAuthStub() : null;
    const adapter = adapterMod.createMcpAdapter({
        httpRequest: cfg.httpRequest,
        endpoint: cfg.endpoint,
        supportedVersions: cfg.supportedVersions,
        modernVersions: cfg.modernVersions,
        mode: cfg.mode,
        discovery: cfg.discovery,
        authProvider: cfg.authProvider || auth,
        stateless: cfg.stateless,
        requireSession: cfg.requireSession,
        timeoutMs: cfg.timeoutMs
    });
    const core = toolMod.createMarketDataTool({ adapter });
    const marketDataTool = {
        detect: (q) => {
            try { return intentMod.detectFinancialIntent(q); } catch (e) { return null; }
        },
        fetch: async (plan, cancellable) => {
            const p = (plannerMod && typeof plannerMod.planMarketCalls === 'function')
                ? plannerMod.planMarketCalls(plan) : plan;
            const intent = (p && p.intent) || (plan && plan.intent);
            const symbols = (p && p.symbols) || (plan && plan.symbols) || [];
            const tfs = (p && p.timeframes) || (plan && plan.timeframes) || [];
            const tf = tfs.length ? tfs[0] : 'D1';
            if (intent === 'market_price') {
                if (symbols.length > 1) return core.getPrices(symbols, cancellable);
                return core.getPrice(symbols[0] || '', cancellable);
            }
            if (intent === 'market_ohlcv') {
                if (symbols.length > 1) {
                    const parts = [];
                    for (const s of symbols) parts.push(await core.getOhlcv(await core.resolveSymbol(s, cancellable), tf, 100, cancellable));
                    return _mergeLabelled('market_ohlcv', parts);
                }
                return core.getOhlcv(await core.resolveSymbol(symbols[0] || '', cancellable), tf, 100, cancellable);
            }
            if (intent === 'technical_analysis') {
                const runOne = async (raw) => {
                    const symbol = await core.resolveSymbol(raw, cancellable);
                    if (plan && plan.wantsBars) {
                        let tech = null;
                        try { tech = await core.getTechnicals(symbol, tf, cancellable); } catch (e) { tech = null; }
                        const ohlcv = await core.getOhlcv(symbol, tf, 100, cancellable);
                        if (tech && tech.rows && tech.rows[0]) ohlcv.rows = [{ technicals: tech.rows[0], bars: ohlcv.rows }];
                        return ohlcv;
                    }
                    return core.getTechnicals(symbol, tf, cancellable);
                };
                if (symbols.length > 1) {
                    const parts = [];
                    for (const s of symbols) parts.push(await runOne(s));
                    return _mergeLabelled('technicals', parts);
                }
                return runOne(symbols[0] || '');
            }
            if (intent === 'fundamental_analysis') return core.getFundamentals(symbols[0] || '', !!(plan && plan.wantsConsensus), cancellable);
            if (intent === 'market_news') {
                const md = await core.getNews(await core.resolveSymbol(symbols[0] || '', cancellable), cancellable);
                if (plan && plan.wantsStory && md.rows && md.rows[0] && md.rows[0].id) {
                    return core.getStory(md.rows[0].id, cancellable);
                }
                return md;
            }
            if (intent === 'financial_screener') return core.runScreener({ columns: (plan && plan.columns) || [], filters: (plan && plan.filters) || {}, limit: (plan && plan.limit) }, cancellable);
            if (intent === 'economic_data') return core.getEconomic(symbols[0] || ((plan && plan.economicSymbol) || ''), cancellable);
            if (intent === 'symbol_lookup') {
                const out = [];
                const list = symbols.length ? symbols : [''];
                for (const raw of list) {
                    const symbol = await core.resolveSymbol(raw, cancellable);
                    out.push({ symbol });
                }
                return { type: 'market_data', kind: 'symbol_lookup', symbols: out.map((r) => r.symbol), interval: null, rows: out, attribution: 'TradingView', sources: [] };
            }
            const e = new Error('Unsupported market intent: ' + intent);
            e.code = 'unsupported_tool';
            throw e;
        },
        _core: core
    };
    return { marketDataTool, adapter, auth, disabled: false };
}

module.exports = { createMarketDataFromConfig };
