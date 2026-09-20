// ai/marketData/financialIntent.js — pure generic financial intent gate.
// NO ticker/entity list. Routing requires generic FINANCIAL CONTEXT:
// asset-class | indicator | venue/method | economic | ticker-like syntax.
// Symbol candidates are extracted generically (ALL-CAPS tokens in raw query,
// market-suffixed tokens, .JK) and resolved via search_symbols — never mapped.
const _ASSET_RE = /\b(saham|shares?|stock|crypto|kripto|koin|coin|forex|fx|valas|valuta|pair|indeks|index|emiten|bursa|exchange|komoditas|commodity|commodities|emas|gold|perak|silver|minyak|oil|gas|batubara|nikel|cpo|obligasi|bond|reksadana|etf|futures|futures|options|opsi)\b/i;
const _INDICATOR_RE = /\b(rsi|macd|ema|sma|stochastic|stoch|cci|adx|momentum|awesome|vwma|hullma|pe\b|p\/e|pb\b|p\/b|roe|roa|ebitda|fcf|dividen|dividend|yield|rating|teknikal|technical|fundamental|overbought|oversold|support|resistance)\b/i;
const _VENUE_RE = /\b(tradingview|\btv\b|ohlcv|timeframe|candlestick|candle|screener|price action|volume perdagangan)\b/i;
const _ECON_RE = /\b(inflasi|inflation|gdp|pdb|cpi|ihk|suku bunga|interest rate|fed rate|pengangguran|unemployment|neraca perdagangan|trade balance|payroll|retail sales|defisit|surplus)\b/i;
const _PRICE_RE = /\b(harga|price|kurs|rate|berapa)\b/i;
const _ANALYZE_RE = /\b(analisis|analisa|analysis|bandingkan|compare|banding)\b/i;
const _NEWS_RE = /\b(berita|news|kabar|headline)\b/i;
const _SCREEN_RE = /\b(screener|screening|filter saham|saham dengan|oversold|overbought|cari saham)\b/i;
const _SYMBOL_LOOKUP_RE = /\b(simbol|symbol|ticker)\b/i;

// Market suffixes are self-evidently market syntax (any case).
const _SUFFIX_RE = /\b([A-Za-z]{2,12}(USD|USDT|IDR|EUR|JPY|GBP))\b|\b([A-Z0-9]{2,12}\.JK)\b/i;
// ALL-CAPS tokens in the RAW query (case matters: "Mint" is not ticker-like).
const _CAPS_RE = /\b[A-Z]{2,12}\b/g;

// Generic words that must never become symbol candidates.
const _SYMBOL_SKIP = new Set(('DAN ATAU YANG DENGAN UNTUK DARI APA BAGAIMANA BERAPA HARGA SEKARANG ' +
    'TERBARU TERKINI TENTANG ANALISIS ANALYSIS ANALISA DATA BERITA NEWS SAHAM STOCK CRYPTO FOREX ' +
    'FUNDAMENTAL TEKNIKAL TECHNICAL SCREENER INFLASI EKONOMI TRADINGVIEW SIMBOL SYMBOL TICKER ' +
    'OVERBOUGHT OVERSOLD SUPPORT RESISTANCE CANDLE OHLCV VOLUME DIVIDEN DIVIDEND RSI MACD EMA SMA ' +
    'STOCHASTIC STOCH CCI ADX MOMENTUM AWESOME VWMA HULLMA PE PB ROE ROA EBITDA FCF RATING ' +
    'HARI INI ITU INFLASI SUKU BUNGA FED RATE PENGANGGURAN JAKARTA LINUX FILE PDF LAPTOP CUACA ' +
    'M1 M5 M15 M30 H1 H4 D1 W1 MN US UK EU ID MINT LAPTOP PDF FILE CUACA JAKARTA LINUX').split(' '));

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

function _tickerTokens(raw) {
    const found = [];
    const push = (t) => {
        const u = String(t || '').toUpperCase();
        if (!u || _SYMBOL_SKIP.has(u)) return;
        if (/^(M1|M5|M15|M30|H1|H4|D1|W1|MN)$/.test(u)) return;
        if (found.indexOf(u) < 0) found.push(u);
    };
    // suffix tokens first (self-sufficient market syntax), any case
    const sm = String(raw).match(new RegExp(_SUFFIX_RE.source, 'gi')) || [];
    for (const t of sm) push(t);
    // ALL-CAPS tokens in raw query only
    const cm = String(raw).match(_CAPS_RE) || [];
    for (const t of cm) push(t);
    return found;
}

function _symbols(s, raw) {
    const found = [];
    const parts = String(s).split(/[,;]|\bdan\b|\bvs\b|\bversus\b|\bcompare\b|\bbandingkan\b|\bbanding\b/i);
    const rawParts = String(raw).split(/[,;]|\bdan\b|\bvs\b|\bversus\b|\bcompare\b|\bbandingkan\b|\bbanding\b/i);
    for (let i = 0; i < parts.length; i++) {
        for (const t of _tickerTokens(rawParts[i] || '')) {
            if (found.indexOf(t) < 0) found.push(t);
        }
    }
    return found;
}

function detectFinancialIntent(query) {
    const raw = String(query || '');
    const s = raw.trim();
    if (!s) return null;
    const strong = _ASSET_RE.test(s) || _INDICATOR_RE.test(s) || _VENUE_RE.test(s) || _ECON_RE.test(s);
    const suffixHit = _SUFFIX_RE.test(s);
    const tickers = _tickerTokens(s);
    const tfs = _timeframes(s);
    const coSignal = _PRICE_RE.test(s) || _NEWS_RE.test(s) || _SCREEN_RE.test(s) || _SYMBOL_LOOKUP_RE.test(s);
    // Gate: strong context, OR suffix syntax, OR 2+ ticker tokens,
    // OR single ticker token with a market co-signal (incl. generic
    // analisis/bandingkan + ticker + timeframe), OR bare single symbol (lookup).
    let gated = false;
    if (strong) gated = true;
    else if (suffixHit) gated = true;
    else if (tickers.length >= 2) gated = true;
    else if (tickers.length === 1 && coSignal) gated = true;
    else if (tickers.length === 1 && _ANALYZE_RE.test(s) && tfs.length > 0) gated = true;
    else if (tickers.length === 1) {
        const stripped = s.replace(/M1|M5|M15|M30|H1|H4|D1|W1|MN|[?,.!\s]/gi, '');
        if (stripped.toUpperCase() === tickers[0]) gated = true;
    }
    if (!gated) return null;
    const timeframes = _timeframes(s);
    const symbols = _symbols(s, raw);
    if (_SYMBOL_LOOKUP_RE.test(s) && (_VENUE_RE.test(s) || symbols.length > 0)) return { intent: 'symbol_lookup', symbols, timeframes };
    if (_ECON_RE.test(s)) return { intent: 'economic_data', symbols, timeframes };
    if (_SCREEN_RE.test(s)) return { intent: 'financial_screener', symbols, timeframes };
    if (_NEWS_RE.test(s)) return { intent: 'market_news', symbols, timeframes };
    if (/fundamental|pe\b|p\/e|pb\b|p\/b|roe|roa|ebitda|laporan keuangan|revenue|income/i.test(s)) return { intent: 'fundamental_analysis', symbols, timeframes };
    if (/rsi|macd|ema|sma|stochastic|stoch|cci|adx|teknikal|technical|analisis|analisa/i.test(s)) return { intent: 'technical_analysis', symbols, timeframes };
    if (/\bohlcv\b|\bcandle\b|\bvolume\b|\bprice action\b/i.test(s)) return { intent: 'market_ohlcv', symbols, timeframes };
    if (_PRICE_RE.test(s) || suffixHit || symbols.length > 0) return { intent: 'market_price', symbols, timeframes };
    return { intent: 'market_price', symbols, timeframes };
}

module.exports = { detectFinancialIntent };
