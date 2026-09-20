// ai/marketData/financialIntent.js — pure generic financial intent gate. No ticker list.
// Routing requires FINANCIAL CONTEXT (instrument | indicator | venue | economic).
const _INSTRUMENT_RE = /\b(btc|eth|sol|xrp|doge|bnb|usdt|btcusdt|nvda|nvidia|bbca|bbri|xauusd|eurusd|gbpusd|usdjpy|saham|stock|crypto|kripto|forex|forex|pair|pairs|indeks|index|emiten|ticker|simbol|s symbol)\b/i;
const _TICKERLIKE_RE = /\b([A-Z]{2,12}(USD|USDT|IDR|EUR|JPY|GBP)|\b[A-Z]{4}\.JK\b)/;
const _KNOWN_NAMES = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'USDT', 'NVDA', 'BBCA', 'BBRI', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];
const _INDICATOR_RE = /\b(rsi|macd|ema|sma|stochastic|stoch|cci|adx|momentum|awesome|vwma|hullma|pe\b|p\/e|pb\b|p\/b|roe|roa|ebitda|fcf|dividen|dividend|yield|rating|teknikal|technical|fundamental|overbought|oversold|support|resistance)\b/i;
const _VENUE_RE = /\b(tradingview|ohlcv|timeframe|candlestick|candle|screener|saring|analisis teknikal|price action|volume perdagangan)\b/i;
const _ECON_RE = /\b(inflasi|inflation|gdp|pdb|cpi|ihk|suku bunga|interest rate|fed rate|pengangguran|unemployment|neraca perdagangan|trade balance|payroll|retail sales)\b/i;
const _PRICE_RE = /\b(harga|price|kurs|rate|berapa)\b/i;
const _NEWS_RE = /\b(berita|news|kabar|headline)\b/i;
const _SCREEN_RE = /\b(screener|screening|filter saham|saham dengan|oversold|overbought|cari saham)\b/i;
const _SYMBOL_LOOKUP_RE = /\b(simbol|symbol|ticker)\b.*\b(tradingview|tv)\b|\b(tradingview|tv)\b.*\b(simbol|symbol|ticker)\b|\bcari simbol\b/i;

const _TF_PATTERNS = [
    [/\bM1\b|\b1\s*m(enit)?\b/i, 'M1'],
    [/\bM5\b|\b5\s*m(enit)?\b/i, 'M5'],
    [/\bM15\b|\b15\s*m(enit)?\b/i, 'M15'],
    [/\bM30\b|\b30\s*m(enit)?\b/i, 'M30'],
    [/\bH1\b|\b1\s*(h|jam)\b/i, 'H1'],
    [/\bH4\b|\b4\s*(h|jam)\b/i, 'H4'],
    [/\bD1\b|\b1\s*(d|hari)\b|\b(daily|harian)\b/i, 'D1'],
    [/\bW1\b|\b1\s*(w|minggu)\b|\b(weekly|mingguan)\b/i, 'W1'],
    [/\bMN\b|\b1\s*(M|bulan)\b|\b(monthly|bulanan)\b/i, 'MN']
];

function _timeframes(s) {
    const hits = [];
    const seen = new Set();
    for (const [re, canon] of _TF_PATTERNS) {
        if (seen.has(canon)) continue;
        const m = re.exec(s);
        if (m) { hits.push({ idx: m.index, canon }); seen.add(canon); }
    }
    hits.sort((a, b) => a.idx - b.idx);
    return hits.map((h) => h.canon);
}
function _symbols(s) {
    const found = [];
    const parts = String(s).split(/[,;]|\bdan\b|\bvs\b|\bversus\b|\bcompare\b|\bbandingkan\b|\bbanding\b/i);
    for (const p of parts) {
        const toks = String(p).toUpperCase().match(/\b[A-Z]{2,12}(USDT|USD|IDR|\.JK)?\b/g) || [];
        for (const t of toks) {
            const skip = ['DAN', 'ATAU', 'YANG', 'DENGAN', 'UNTUK', 'DARI', 'APA', 'BAGAIMANA', 'BERAPA', 'HARGA', 'SEKARANG', 'TERBARU', 'TENTANG', 'ANALISIS', 'SAHAM', 'BERITA', 'CARI', 'SIMBOL', 'DATA', 'FILTER', 'FILE', 'PDF', 'CUACA', 'JAKARTA', 'LINUX', 'MINT', 'LAPTOP', 'INFLASI'];
            if (skip.indexOf(t) >= 0) continue;
            if (['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'].indexOf(t) >= 0) continue;
            if (found.indexOf(t) < 0) found.push(t);
        }
    }
    return found;
}
function _hasContext(s) {
    return _INSTRUMENT_RE.test(s) || _TICKERLIKE_RE.test(s) || _INDICATOR_RE.test(s) || _VENUE_RE.test(s) || _ECON_RE.test(s);
}

function detectFinancialIntent(query) {
    const s = String(query || '').trim();
    if (!s) return null;
    if (!_hasContext(s)) return null;
    const timeframes = _timeframes(s);
    const symbols = _symbols(s);
    if (_SYMBOL_LOOKUP_RE.test(s)) return { intent: 'symbol_lookup', symbols, timeframes };
    if (_ECON_RE.test(s)) return { intent: 'economic_data', symbols, timeframes };
    if (_SCREEN_RE.test(s)) return { intent: 'financial_screener', symbols, timeframes };
    if (_NEWS_RE.test(s)) return { intent: 'market_news', symbols, timeframes };
    if (/fundamental|pe\b|p\/e|pb\b|roe|roa|ebitda|laporan keuangan|revenue|income/i.test(s)) return { intent: 'fundamental_analysis', symbols, timeframes };
    if (/rsi|macd|ema|sma|stochastic|cci|adx|teknikal|technical|analisis/i.test(s)) return { intent: 'technical_analysis', symbols, timeframes };
    if (/\bohlcv\b|\bcandle\b|\bvolume\b|\bprice action\b/i.test(s)) return { intent: 'market_ohlcv', symbols, timeframes };
    if (_PRICE_RE.test(s) || symbols.length > 0) return { intent: symbols.length > 1 ? 'market_price' : 'market_price', symbols, timeframes };
    return { intent: 'market_price', symbols, timeframes };
}

module.exports = { detectFinancialIntent };
