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
            if (intent === 'market_price') return core.getPrice(symbols[0] || '', cancellable);
            if (intent === 'market_ohlcv') return core.getOhlcv(symbols[0] || '', tf, 100, cancellable);
            if (intent === 'technical_analysis') {
                if (plan && plan.wantsBars) {
                    const symbol = symbols[0] || '';
                    let tech = null;
                    try { tech = await core.getTechnicals(symbol, tf, cancellable); } catch (e) { tech = null; }
                    const ohlcv = await core.getOhlcv(symbol, tf, 100, cancellable);
                    if (tech && tech.rows && tech.rows[0]) ohlcv.rows = [{ technicals: tech.rows[0], bars: ohlcv.rows }];
                    return ohlcv;
                }
                return core.getTechnicals(symbols[0] || '', tf, cancellable);
            }
            if (intent === 'market_news') return core.getNews(symbols[0] || '', cancellable);
            if (intent === 'symbol_lookup') {
                const symbol = await core.resolveSymbol(symbols[0] || '', cancellable);
                return { type: 'market_data', kind: 'symbol_lookup', symbols: [symbol], interval: null, rows: [{ symbol }], attribution: 'TradingView', sources: [] };
            }
            return core.getPrice(symbols[0] || '', cancellable);
        },
        _core: core
    };
    return { marketDataTool, adapter, auth, disabled: false };
}

module.exports = { createMarketDataFromConfig };
