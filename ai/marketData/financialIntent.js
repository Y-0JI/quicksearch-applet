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
// FX pair with separator: EUR/USD, EURUSD handled by suffix; slash form explicit.
const _FXPAIR_RE = /\b([A-Z]{3})\/([A-Z]{3})\b/;

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
    const fx = String(raw).match(new RegExp(_FXPAIR_RE.source, 'g')) || [];
    for (const t of fx) push(String(t).replace('/', ''));
    // suffix tokens first (self-sufficient market syntax), any case
    const sm = String(raw).match(new RegExp(_SUFFIX_RE.source, 'gi')) || [];
    for (const t of sm) push(t);
    // ALL-CAPS tokens in raw query only
    const cm = String(raw).match(_CAPS_RE) || [];
    for (const t of cm) push(t);
    return found;
}

// Entity/instrument phrase for search_symbols: the generically-extracted
// candidate text the resolver must look up (NO local ticker mapping).
// Prefers: explicit “X/Y” pair → suffix token → longest ALL-CAPS token →
// longest capitalized word run (NVIDIA, Bitcoin) → null.
function _entityPhrase(raw) {
    const s = String(raw || '');
    const fx = s.match(_FXPAIR_RE);
    if (fx) return (fx[1] + fx[2]).toUpperCase();
    const sm = s.match(new RegExp(_SUFFIX_RE.source, 'i'));
    if (sm) return String(sm[0]).toUpperCase();
    const caps = (s.match(_CAPS_RE) || []).filter((t) => !_SYMBOL_SKIP.has(t) && !/^(M1|M5|M15|M30|H1|H4|D1|W1|MN)$/.test(t));
    if (caps.length) {
        caps.sort((a, b) => b.length - a.length);
        return caps[0].toUpperCase();
    }
    const words = s.match(/\b[A-Z][a-z]{2,20}(?:\s+[A-Z][a-z]{2,20}){0,2}\b/g) || [];
    const stopFirst = new Set(['Berapa', 'Berikan', 'Cari', 'Analisis', 'Analisa', 'Bagaimana', 'Bandingkan', 'Ada', 'Cek', 'Linux', 'Berita']);
    const cands = words.map((w) => String(w).split(/\s+/).filter((p) => !stopFirst.has(p)).join(' ')).map((w) => w.trim()).filter((w) => w.length >= 3);
    if (cands.length) {
        cands.sort((a, b) => b.length - a.length);
        return cands[0];
    }
    return null;
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
    // Entity alone ("Apple" with no context) stays non-financial — resolver
    // decides via search_symbols only after the gate passes.
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
    if (!gated) {
        // Bare single-token entity lookup ("Nvidia", "Bitcoin", "Apple"):
        // the whole query is one entity-ish token. Route as candidate;
        // search_symbols is the source of truth (no_results if unknown).
        const ent = _entityPhrase(raw);
        if (ent) {
            const stripped = s.replace(/M1|M5|M15|M30|H1|H4|D1|W1|MN|[?,.!\s\/]/gi, '');
            if (stripped && stripped.toUpperCase() === String(ent).toUpperCase().replace(/\s+/g, '')) gated = true;
            // Entity + market co-signal ("harga Apple"): route ONLY when the
            // entity is market-syntax-like (suffix/FX/ticker token) or strong
            // context exists. "Berita terbaru Linux Mint" must stay web.
            else if (coSignal || _ANALYZE_RE.test(s)) {
                const entUp = String(ent).toUpperCase();
                const marketLike = _SUFFIX_RE.test(ent) || _FXPAIR_RE.test(raw) || tickers.indexOf(entUp) >= 0 || suffixHit;
                if (marketLike) gated = true;
            }
        }
    }
    if (!gated) return null;
    const timeframes = _timeframes(s);
    const symbols = _symbols(s, raw);
    const entity = _entityPhrase(raw);
    // Economic entity context: country/region + indicator words, generic.
    const econEntity = _econEntity(raw);
    const base = { timeframes, entity };
    if (_ECON_RE.test(s)) return Object.assign({ intent: 'economic_data', symbols, econEntity }, base);
    if (_SYMBOL_LOOKUP_RE.test(s) && (_VENUE_RE.test(s) || symbols.length > 0)) return Object.assign({ intent: 'symbol_lookup', symbols }, base);
    if (_SCREEN_RE.test(s)) return Object.assign({ intent: 'financial_screener', symbols }, base);
    if (_NEWS_RE.test(s) && (symbols.length > 0 || entity || _ASSET_RE.test(s) || _INDICATOR_RE.test(s))) {
        return Object.assign({ intent: 'market_news', symbols }, base);
    }
    if (_NEWS_RE.test(s)) return null;
    if (/fundamental|pe\b|p\/e|pb\b|p\/b|roe|roa|ebitda|laporan keuangan|revenue|income/i.test(s)) return Object.assign({ intent: 'fundamental_analysis', symbols }, base);
    if (/rsi|macd|ema|sma|stochastic|stoch|cci|adx|teknikal|technical|analisis|analisa/i.test(s)) return Object.assign({ intent: 'technical_analysis', symbols }, base);
    if (/\bohlcv\b|\bcandle\b|\bvolume\b|\bprice action\b/i.test(s)) return Object.assign({ intent: 'market_ohlcv', symbols }, base);
    if (_PRICE_RE.test(s) || suffixHit || symbols.length > 0) return Object.assign({ intent: 'market_price', symbols }, base);
    if (entity) return Object.assign({ intent: 'market_price', symbols: symbols.length ? symbols : [entity] }, base);
    return null;
}

// Generic economic entity: { country, indicator } from free text.
// Country: 2-letter code or well-known region word (no ticker list).
// Indicator: matched economic phrase. Both may be null.
const _COUNTRY_RE = /\b(US|USA|USA|ID|EU|CN|JP|GB|DE|AMERIKA|AMERICA|INDONESIA|EROPA|EUROPE|CHINA|JEPANG|JAPAN)\b/i;
function _econEntity(raw) {
    const s = String(raw || '');
    const ind = s.match(/inflasi|inflation|gdp|pdb|cpi|ihk|suku bunga|interest rate|fed rate|pengangguran|unemployment|neraca perdagangan|trade balance|payroll|retail sales|defisit|surplus/i);
    const c = s.match(_COUNTRY_RE);
    const normCountry = (x) => {
        const u = String(x || '').toUpperCase();
        if (/AMERIKA|AMERICA|^US$|^USA$/.test(u)) return 'US';
        if (/INDONESIA/.test(u)) return 'ID';
        if (/EROPA|EUROPE|^EU$/.test(u)) return 'EU';
        if (/CHINA/.test(u)) return 'CN';
        if (/JEPANG|JAPAN/.test(u)) return 'JP';
        return u.slice(0, 2);
    };
    return { country: c ? normCountry(c[0]) : null, indicator: ind ? ind[0].toLowerCase() : null };
}

module.exports = { detectFinancialIntent };
