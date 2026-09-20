// ai/marketData/minCallPlanner.js — minimum necessary MCP calls per intent. Pure.
function planMarketCalls(plan) {
    plan = plan || {};
    const intent = String(plan.intent || '');
    const symbols = Array.isArray(plan.symbols) ? plan.symbols : [];
    const steps = [];
    for (const s of symbols) steps.push('resolve:' + s);
    if (symbols.length === 0 && intent !== 'financial_screener' && intent !== 'economic_data') steps.push('resolve');
    if (intent === 'market_price') steps.push('market_price');
    else if (intent === 'market_ohlcv') steps.push('ohlcv');
    else if (intent === 'technical_analysis') {
        steps.push('technicals');
        if (plan.wantsBars) steps.push('ohlcv');
    } else if (intent === 'fundamental_analysis') {
        steps.push('financials');
        if (plan.wantsConsensus) steps.push('forecasts');
    } else if (intent === 'market_news') {
        steps.push('news');
        if (plan.wantsStory) steps.push('news_story');
    } else if (intent === 'financial_screener') {
        steps.push('screener_columns_cached');
        steps.push('run_screener');
    } else if (intent === 'economic_data') steps.push('economic_data');
    else if (intent === 'symbol_lookup') steps.push('symbol_lookup');
    else steps.push('market_price');
    return { intent, symbols, timeframes: plan.timeframes || [], steps };
}
module.exports = { planMarketCalls };
