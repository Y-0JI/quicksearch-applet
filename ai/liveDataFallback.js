// ai/liveDataFallback.js — keyless direct-API grounding for structured live data.
//
// When the general web search backend is unavailable (upstream engines rate-limited),
// structured-data questions (weather / stocks & crypto / news) can still be grounded
// from their canonical free APIs instead of failing or answering from stale knowledge:
//
//   weather → Open-Meteo forecast API   (no key, generous limits)   + geocoding API
//   stocks  → Yahoo Finance chart API   (no key, unofficial but stable endpoint)
//   news    → RSS feeds (Detik, CNN Indonesia) — parsed with a tiny XML regex parser
//
// Output shape mirrors web-search results ({title, url, snippet}) so the data flows
// straight into the existing grounding pipeline. Everything fails safe: never throws.
(function (globalThis) {
    'use strict';

    const DEFAULT_TIMEOUT_MS = 6000;

    function _timeout(ms, fn) {
        const t = setTimeout(fn, ms);
        if (t && typeof t.unref === 'function') { try { t.unref(); } catch (e) {} }
        return t;
    }

    // Plain-Node http(s) GET (GJS/Soup transport is provided by the engine caller via opts.httpGet)
    function _nodeHttpGet(url, cb) {
        try {
            const mod = (url.indexOf('https:') === 0) ? require('https') : require('http');
            const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 QuickSearch', 'Accept': 'application/json,text/xml,text/*;q=0.8' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    const next = new URL(res.headers.location, url).toString();
                    return _nodeHttpGet(next, cb);
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => { body += c; if (body.length > 512 * 1024) req.destroy(); });
                res.on('end', () => cb(null, body, { status: res.statusCode }));
                res.on('error', (e) => cb(e));
            });
            req.on('error', (e) => cb(e));
            req.setTimeout(DEFAULT_TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
        } catch (e) { cb(e); }
    }

    function _makeError(message, code) {
        const e = new Error(String(message || code));
        e.code = code || 'request_failed';
        return e;
    }

    function createLiveDataFallback(opts) {
        opts = opts || {};
        const doGet = (typeof opts.httpGet === 'function')
            ? (url, canc, cb) => opts.httpGet(url, canc, cb)
            : (url, canc, cb) => _nodeHttpGet(url, cb);
        const timeoutMs = (typeof opts.timeoutMs === 'number') ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
        const _feeds = Array.isArray(opts.newsFeeds) && opts.newsFeeds.length ? opts.newsFeeds : null;

        function httpGetJson(url, cancellable) {
            return new Promise((resolve, reject) => {
                let done = false;
                const tid = _timeout(timeoutMs, () => { if (!done) { done = true; reject(_makeError('live data timeout', 'backend_unavailable')); } });
                const settle = (err, body) => {
                    if (done) return; done = true; clearTimeout(tid);
                    if (err) return reject(err);
                    try { resolve(JSON.parse(body)); } catch (e) { reject(_makeError('invalid JSON from live API', 'invalid_response')); }
                };
                try {
                    doGet(url, cancellable, (err, body, meta) => {
                        if (err) return settle(err);
                        if (meta && meta.status && meta.status >= 400) return settle(_makeError('HTTP ' + meta.status, 'request_failed'));
                        settle(null, body);
                    });
                } catch (e) { settle(e); }
            });
        }

        function httpGetText(url, cancellable) {
            return httpGetJson(url, cancellable).then(() => { throw new Error('unused'); }).catch((e) => {
                // reuse the fetch path but return raw text: re-request with JSON parse disabled
                if (e && e.message === 'unused') throw e;
                return new Promise((resolve, reject) => {
                    let done = false;
                    const tid = _timeout(timeoutMs, () => { if (!done) { done = true; reject(_makeError('live data timeout', 'backend_unavailable')); } });
                    try {
                        doGet(url, cancellable, (err, body, meta) => {
                            if (done) return; done = true; clearTimeout(tid);
                            if (err) return reject(err);
                            if (meta && meta.status && meta.status >= 400) return reject(_makeError('HTTP ' + meta.status, 'request_failed'));
                            resolve(String(body || ''));
                        });
                    } catch (e2) { if (!done) { done = true; clearTimeout(tid); reject(e2); } }
                });
            });
        }

        // ── domain detection ─────────────────────────────────────────────────────
        const CRYPTO = { 'bitcoin': 'BTC-USD', 'btc': 'BTC-USD', 'ethereum': 'ETH-USD', 'eth': 'ETH-USD', 'dogecoin': 'DOGE-USD', 'doge': 'DOGE-USD', 'solana': 'SOL-USD', 'sol': 'SOL-USD', 'xrp': 'XRP-USD', 'ripple': 'XRP-USD', 'bnb': 'BNB-USD', 'tether': 'USDT-USD', 'cardano': 'ADA-USD', 'ada': 'ADA-USD' };
        const SPECIAL = { 'emas': 'GC=F', 'gold': 'GC=F', 'perak': 'SI=F', 'silver': 'SI=F', 'minyak': 'CL=F', 'oil': 'CL=F', 'dolar': 'USDIDR=X', 'dollar': 'USDIDR=X', 'usd': 'USDIDR=X', 'rupiah': 'USDIDR=X', 'idr': 'USDIDR=X', 'ihsg': '^JKSE', 'nasdaq': '^IXIC', 'dow': '^DJI', 's&p': '^GSPC' };
        const COIN_RE = new RegExp('\\b(' + Object.keys(CRYPTO).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b');

        function _detectDomain(q) {
            const s = String(q || '').toLowerCase();
            if (/\b(cuaca|weather|suhu|hujan|badai|temperatur|suhu udara)\b/.test(s)) return 'weather';
            if (/\b(berita|news|kabar|headline|terkini)\b/.test(s)) return 'news';
            if (/\b(saham|kurs|ihsg|stock|crypto|kripto|emas|gold|perak|minyak|dolar|rupiah)\b/.test(s) || COIN_RE.test(s)) return 'stock';
            if (/[A-Z]{4}\.JK\b/.test(String(q || ''))) return 'stock';
            return null;
        }

        function _extractSymbol(q) {
            const raw = String(q || '');
            const jk = /\b([A-Z]{4})\.JK\b/.exec(raw);
            if (jk) return jk[1] + '.JK';
            const s = raw.toLowerCase();
            for (const k of Object.keys(CRYPTO)) {
                if (new RegExp('\\b' + k + '\\b').test(s)) return CRYPTO[k];
            }
            for (const k of Object.keys(SPECIAL)) {
                if (s.indexOf(k) >= 0) return SPECIAL[k];
            }
            const idx = /\b([A-Z]{4})\b/.exec(raw); // "saham BBRI" style
            if (idx && /\bsaham\b/i.test(raw)) return idx[1] + '.JK';
            return null;
        }

        function _extractPlace(q) {
            const m = /(?:cuaca|weather|suhu)\s+(?:di\s+|untuk\s+|kota\s+)?([a-zA-Z\s]{3,32})/i.exec(String(q || ''));
            if (m) return m[1].replace(/\b(hari|ini|besok|sekarang|skrg|gimana|bagaimana|apa|adalah)\b/gi, ' ').replace(/\s+/g, ' ').trim();
            const m2 = /(?:di)\s+([a-zA-Z\s]{3,32})/i.exec(String(q || ''));
            return m2 ? m2[1].replace(/\s+/g, ' ').trim() : '';
        }

        // ── weather (Open-Meteo, keyless) ────────────────────────────────────────
        const WMO = { 0: 'langit cerah', 1: 'cerah berawan', 2: 'berawan sebagian', 3: 'berawan', 45: 'berkabut', 48: 'berkabut membeku', 51: 'gerimis ringan', 53: 'gerimis', 55: 'gerimis lebat', 61: 'hujan ringan', 63: 'hujan sedang', 65: 'hujan lebat', 66: 'hujan membeku', 67: 'hujan membeku lebat', 71: 'salju ringan', 73: 'salju sedang', 75: 'salju lebat', 80: 'hujan lokal ringan', 81: 'hujan lokal sedang', 82: 'hujan lokal deras', 95: 'badai petir', 96: 'badai petir + hujan es', 99: 'badai petir hebat + hujan es' };
        const _wmo = (c) => WMO[Number(c)] || 'kondisi ' + c;

        function fetchWeather(q, cancellable) {
            const place = _extractPlace(q) || 'Jakarta';
            const geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(place) + '&count=1&language=id&format=json';
            return httpGetJson(geoUrl, cancellable).then((geo) => {
                const hit = geo && geo.results && geo.results[0];
                if (!hit) throw _makeError('location not found: ' + place, 'no_results');
                const fUrl = 'https://api.open-meteo.com/v1/forecast?latitude=' + hit.latitude + '&longitude=' + hit.longitude +
                    '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=3&timezone=auto';
                return httpGetJson(fUrl, cancellable).then((f) => {
                    const c = f.current || {};
                    const d = (f.daily || {});
                    const lines = [];
                    lines.push('Cuaca ' + (hit.name || place) + (hit.country ? ', ' + hit.country : '') + ' saat ini: ' + _wmo(c.weather_code) +
                        ', suhu ' + c.temperature_2m + '°C, kelembapan ' + c.relative_humidity_2m + '%, angin ' + c.wind_speed_10m + ' km/j.');
                    if (d.time) {
                        for (let i = 0; i < Math.min(3, d.time.length); i++) {
                            lines.push(d.time[i] + ': ' + _wmo((d.weather_code || [])[i]) + ', ' + (d.temperature_2m_min || [])[i] + '–' + (d.temperature_2m_max || [])[i] + '°C.');
                        }
                    }
                    return [{ title: 'Cuaca ' + (hit.name || place) + ' — Open-Meteo', url: 'https://open-meteo.com/', snippet: lines.join(' ') }];
                });
            });
        }

        // ── stocks / crypto / fx (Yahoo chart API, keyless) ─────────────────────
        function fetchStock(q, cancellable) {
            const sym = _extractSymbol(q);
            if (!sym) throw _makeError('no symbol in query', 'invalid_query');
            const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=5d';
            return httpGetJson(url, cancellable).then((j) => {
                const r = j && j.chart && j.chart.result && j.chart.result[0];
                if (!r) throw _makeError('no yahoo result', 'no_results');
                const meta = r.meta || {};
                const price = meta.regularMarketPrice;
                const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
                const cur = meta.currency || '';
                let snippet = sym + ': ' + price + (cur ? ' ' + cur : '');
                if (price != null && prev != null) {
                    const diff = Number(price) - Number(prev);
                    const pct = prev ? ((diff / Number(prev)) * 100).toFixed(2) : '?';
                    snippet += ' (' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + ', ' + (diff >= 0 ? '+' : '') + pct + '% vs penutupan sebelumnya ' + prev + ')';
                }
                if (meta.regularMarketTime) snippet += ' | data per: ' + new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
                return [{ title: (meta.shortName || meta.longName || sym) + ' (' + sym + ') — Yahoo Finance', url: 'https://finance.yahoo.com/quote/' + encodeURIComponent(sym), snippet: snippet }];
            });
        }

        // ── news (RSS, keyless) ──────────────────────────────────────────────────
        const FEEDS = [
            'https://www.cnnindonesia.com/rss/2',
            'https://rss.tempo.co/nasional'
        ];
        function _parseRss(xml, limit) {
            const out = [];
            const items = String(xml || '').split(/<item[\s>]/i).slice(1);
            for (const it of items) {
                if (out.length >= (limit || 6)) break;
                const pick = (tag) => {
                    const m = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i').exec(it);
                    return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
                };
                const title = pick('title');
                const link = pick('link');
                const desc = pick('description');
                if (title && /^https?:\/\//i.test(link)) out.push({ title: title.slice(0, 200), url: link.trim(), snippet: desc.slice(0, 500) });
            }
            return out;
        }
        function fetchNews(q, cancellable) {
            const feeds = _feeds || FEEDS;
            let lastErr = null;
            return feeds.reduce((chain, feedUrl) => chain.then((acc) => {
                if (acc.length > 0) return acc;
                return new Promise((resolve) => {
                    let done = false;
                    const tid = _timeout(timeoutMs, () => { if (!done) { done = true; resolve([]); } });
                    try {
                        doGet(feedUrl, cancellable, (err, body) => {
                            if (done) return; done = true; clearTimeout(tid);
                            if (err) { lastErr = err; return resolve([]); }
                            resolve(_parseRss(body, 6));
                        });
                    } catch (e) { if (!done) { done = true; clearTimeout(tid); resolve([]); } }
                });
            }), Promise.resolve([])).then((items) => {
                if (!items.length) throw (lastErr || _makeError('no news items', 'no_results'));
                return items;
            });
        }

        // ── public API ───────────────────────────────────────────────────────────
        function detectDomain(query) { return _detectDomain(query); }

        function fetch(query, cancellable) {
            const domain = _detectDomain(query);
            if (!domain) return Promise.reject(_makeError('query is not structured live data', 'invalid_query'));
            const p = domain === 'weather' ? fetchWeather(query, cancellable)
                : domain === 'stock' ? fetchStock(query, cancellable)
                : fetchNews(query, cancellable);
            return p.then((sources) => ({ domain: domain, sources: sources }));
        }

        return { detectDomain: detectDomain, fetch: fetch, __backends: { weather: 'open-meteo', stock: 'yahoo-finance', news: 'rss' } };
    }

    const mod = { createLiveDataFallback: createLiveDataFallback };
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (globalThis) globalThis.LiveDataFallback = mod;
})(typeof global !== 'undefined' ? global : this);
