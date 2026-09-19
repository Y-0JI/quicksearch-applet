// tests/ai-retrieval-quality.test.js — GENERAL deterministic relevance gate.
// No per-topic hardcode: optimizer is topic-preserving (meta-strip only), the gate
// uses core-phrase coverage + intent/authority/freshness bonuses, fail-closed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const RQ = require('../ai/retrievalQuality.js');
const { createAISearchEngine } = require('../ai/aiSearchEngine.js');

const ROOT = path.join(__dirname, '..');
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'ai/aiSearchEngine.js'), 'utf8');

function src(title, url, snippet) {
    const m = /:\/\/([^/]+)/.exec(url || '');
    return { title, url, domain: m ? m[1] : '', snippet };
}

const APA = src('APA Formatting and Style Guide', 'https://owl.purdue.edu/owl/research_and_citation/apa_style/', 'APA citation generator and formatting rules for research papers.');
const SCRIBBR = src('Free APA Citation Generator — Scribbr', 'https://www.scribbr.com/apa-citation-generator/', 'Generate APA citations for books, journals and websites automatically.');
const PURDUE = src('Purdue OWL: APA Formatting and Style Guide', 'https://owl.purdue.edu/owl/research_and_citation/apa_style/apa_formatting_and_style_guide/', 'APA style introduction and formatting rules.');
const MINT_RELEASE = src("Linux Mint 22.3 'Zena' released", 'https://blog.linuxmint.com/?p=5000', 'Linux Mint 22.3 is the latest release with Cinnamon improvements.');
const MINT_MIN = src("Linux Mint 22.3 'Zena'", 'https://linuxmint.com/rel_zena.php', 'Linux Mint release announcement with download links.');
const CHELSEA_FIX = src('Chelsea fixtures this week — Premier League schedule', 'https://example.com/chelsea-fixtures', 'Chelsea matches this week with dates and kick-off times.');
const CHELSEA_ID = src('Jadwal Chelsea terbaru dan hasil pertandingan', 'https://example.id/jadwal-chelsea', 'Jadwal Chelsea minggu ini beserta hasil pertandingan terakhir.');
const BANSOS = src('Cek bansos minggu ini — cara cek penerima', 'https://example.id/cek-bansos', 'Cara cek bansos minggu ini secara online.');
const PAKET = src('Paket cepat dan cara cek status pengiriman', 'https://example.id/paket-cepat', 'Lacak paket cepat dan cek status pengiriman barang.');
const DOCKER_GUIDE = src('Install Docker Engine on Linux Mint — step by step guide', 'https://docs.docker.com/engine/install/', 'Docker installation guide for Linux Mint with official documentation steps.');
const NVIDIA_CEO = src('NVIDIA leadership — Jensen Huang, CEO', 'https://nvidia.com/about', 'NVIDIA CEO Jensen Huang leads the company; official leadership page.');
const CEO_RANDOM = src('CEO wortel dan gaya kepemimpinan modern', 'https://example.id/ceo-wording', 'Artikel tentang CEO dan kepemimpinan secara umum.');
const GOLD_NOW = src('Harga emas hari ini — XAU/USD live', 'https://example.com/gold-price', 'Current gold price today: XAU/USD market data updated hourly.');
const GOLD_2018 = src('Sejarah harga emas 2018', 'https://example.com/gold-2018', 'Historical gold price article from 2018.');

// ---- A. LINUX MINT ----
test('A: Mint query keeps Mint, rejects APA/Scribbr/Purdue', () => {
    const q = 'Apa versi terbaru Linux Mint saat ini';
    const out = RQ.filterRelevantSources(q, [MINT_RELEASE, APA, SCRIBBR, PURDUE, MINT_MIN]);
    assert.ok(out.some(s => s.url.includes('linuxmint.com')), 'mint kept');
    assert.ok(!out.some(s => /purdue|scribbr/.test(s.url)), 'junk rejected');
});

// ---- B. CHELSEA ----
test('B: Chelsea schedule keeps fixtures, rejects bansos/paket', () => {
    const q = 'Cek jadwal Chelsea minggu ini';
    const out = RQ.filterRelevantSources(q, [CHELSEA_FIX, BANSOS, PAKET, CHELSEA_ID]);
    assert.ok(out.some(s => s.url.includes('chelsea-fixtures')), 'fixtures kept');
    assert.ok(out.some(s => s.url.includes('jadwal-chelsea')), 'ID schedule kept');
    assert.ok(!out.some(s => s.url.includes('cek-bansos')), 'bansos rejected');
    assert.ok(!out.some(s => s.url.includes('paket-cepat')), 'paket rejected');
});

// ---- C. DOCKER ----
test('C: Docker howto keeps guide, rejects citation junk', () => {
    const q = 'Bagaimana cara install Docker di Linux Mint?';
    const out = RQ.filterRelevantSources(q, [DOCKER_GUIDE, APA]);
    assert.ok(out.some(s => s.url.includes('docker.com')), 'guide kept');
    assert.ok(!out.some(s => /purdue/.test(s.url)), 'APA rejected');
});

// ---- D. NVIDIA ----
test('D: NVIDIA CEO keeps leadership, rejects generic CEO article', () => {
    const q = 'Siapa CEO NVIDIA sekarang?';
    const out = RQ.filterRelevantSources(q, [NVIDIA_CEO, CEO_RANDOM]);
    assert.ok(out.some(s => s.url.includes('nvidia.com')), 'leadership kept');
    assert.ok(!out.some(s => s.url.includes('ceo-wording')), 'generic CEO rejected');
});

// ---- E. GOLD ----
test('E: gold now keeps live price over 2018 history', () => {
    const q = 'Berapa harga emas hari ini?';
    const out = RQ.filterRelevantSources(q, [GOLD_NOW, GOLD_2018]);
    assert.ok(out.length >= 1, 'something kept');
    assert.equal(out[0].url, GOLD_NOW.url, 'live price ranks first');
});

// ---- F/G. FALSE POSITIVES ----
test('F: only the Apa prefix stripped, topic wording intact', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Apa sumber pendanaan Linux Mint?'), 'sumber pendanaan Linux Mint');
});
test('G: source code wording never stripped', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Linux Mint source code'), 'Linux Mint source code');
});

// ---- H/I. SHORT & GENERIC ----
test('H: jadwal-only match cannot survive Chelsea query', () => {
    const onlyJadwal = src('Jadwal lengkap semua hal', 'https://example.id/jadwal-umum', 'Jadwal umum tanpa menyebut tim apa pun.');
    const out = RQ.filterRelevantSources('jadwal Chelsea', [onlyJadwal, CHELSEA_ID]);
    assert.ok(!out.some(s => s.url.includes('jadwal-umum')), 'jadwal-only rejected');
    assert.ok(out.some(s => s.url.includes('jadwal-chelsea')), 'chelsea schedule kept');
});
test('I: cek-only match cannot survive', () => {
    const onlyCek = src('Cek resi dan cek saldo', 'https://example.id/cek-umum', 'Cara cek resi dan cek saldo kapan saja.');
    const out = RQ.filterRelevantSources('cek jadwal', [onlyCek]);
    assert.deepStrictEqual(out, [], 'generic-only rejected');
});

// ---- J. MULTI-WORD ENTITY ----
test('J: Linux Mint phrase beats lone mint token', () => {
    const loneMint = src('Mint condition coins guide', 'https://example.com/mint-coins', 'A guide to mint condition coins for collectors.');
    const out = RQ.filterRelevantSources('Linux Mint', [loneMint, MINT_MIN]);
    assert.ok(out.some(s => s.url.includes('linuxmint.com')), 'entity kept');
    assert.ok(!out.some(s => s.url.includes('mint-coins')), 'lone-mint rejected');
});

// ---- K/L. TEMPORAL vs HISTORICAL ----
test('K: latest query activates freshness bonus', () => {
    const r = RQ.scoreSource('Linux Mint latest version', MINT_RELEASE, { primary: 'current', flags: { live: true } });
    assert.ok(r.fresh, 'fresh active');
});
test('L: historical query has no freshness penalty', () => {
    const out = RQ.filterRelevantSources('Linux Mint release history 2020', [MINT_MIN]);
    assert.equal(out.length, 1, 'history source kept without freshness');
});

// ---- OPTIMIZER: topic-preserving ----
test('M1: focused rebuild (intent-aware) keeps topic, drops meta', () => {
    const RI = require('../ai/responseIntent.js');
    const b = (q) => RQ.optimizeRetrievalQuery(q, RI.detectResponseIntent(q));
    assert.equal(b('Apa versi terbaru Linux Mint saat ini? Sertakan sumbernya.'), 'Linux Mint version latest');
    assert.equal(b('Cek jadwal Chelsea minggu ini'), 'Chelsea fixtures this week');
    assert.equal(b('Bagaimana cara install Docker di Linux Mint?'), 'How to install Docker on Linux Mint');
    assert.equal(b('Berapa harga emas hari ini?'), 'emas price today');
    assert.equal(b('Siapa CEO NVIDIA sekarang?'), 'CEO NVIDIA today');
});
test('M2: EN meta stripped case-insensitively', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Linux Mint latest version, include sources!'), 'Linux Mint latest version');
    assert.equal(RQ.optimizeRetrievalQuery('Cite your sources.'), '');
});
test('M3: bounded output', () => {
    assert.ok(RQ.optimizeRetrievalQuery('Apa versi terbaru Linux Mint saat ini?').length <= 120, 'bounded');
});

// T9: general interrogative-prefix strip (retrieval only, intent stays on RAW).
test('T9-1: ID question prefixes stripped to topic', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Apa versi terbaru Linux Mint saat ini'), 'versi terbaru Linux Mint saat ini');
    assert.equal(RQ.optimizeRetrievalQuery('Siapa pemilik Twitter sekarang'), 'pemilik Twitter sekarang');
    assert.equal(RQ.optimizeRetrievalQuery('Bagaimana cara install Docker di Linux Mint'), 'cara install Docker di Linux Mint');
    assert.equal(RQ.optimizeRetrievalQuery('Apakah Docker tersedia di Linux Mint'), 'Docker tersedia di Linux Mint');
    assert.equal(RQ.optimizeRetrievalQuery('Kapan Linux Mint 23 dirilis'), 'Linux Mint 23 dirilis');
    assert.equal(RQ.optimizeRetrievalQuery('Di mana download Linux Mint'), 'download Linux Mint');
    assert.equal(RQ.optimizeRetrievalQuery('Berapa harga emas hari ini'), 'harga emas hari ini');
});
test('T9-2: apa-itu definitional prefix', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Apa itu Linux'), 'Linux');
    assert.equal(RQ.optimizeRetrievalQuery('Apa itu Docker'), 'Docker');
});
test('T9-3: fail-safe never empties', () => {
    assert.equal(RQ.optimizeRetrievalQuery('apa'), 'apa');
    assert.equal(RQ.optimizeRetrievalQuery('siapa'), 'siapa');
});
test('T9-4: mid-query question words untouched', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Linux Mint apa yang paling ringan'), 'Linux Mint apa yang paling ringan');
});
test('T9-5: intent still computed from RAW query', () => {
    const RI = require('../ai/responseIntent.js');
    assert.equal(RI.detectResponseIntent('Siapa pemilik Twitter sekarang').primary, 'simple');
    assert.ok(RQ.optimizeRetrievalQuery('Siapa pemilik Twitter sekarang').indexOf('Siapa') === -1, 'retrieval stripped, intent source intact');
});

// ---- UNRELATED EN/ID ----
test('N1: Purdue rejected, N2: bansos rejected', () => {
    assert.deepStrictEqual(RQ.filterRelevantSources('Linux Mint latest version', [PURDUE]), [], 'purdue out');
    assert.deepStrictEqual(RQ.filterRelevantSources('Cek jadwal Chelsea minggu ini', [BANSOS]), [], 'bansos out');
});

// ---- FAIL-CLOSED ----
test('O: junk-only fails closed', () => {
    assert.deepStrictEqual(RQ.filterRelevantSources('Linux Mint latest version', [APA, SCRIBBR]), []);
});

// ---- CORE PHRASE ----
test('P: corePhrase preserves multi-word entity, drops generic verbs', () => {
    assert.equal(RQ.corePhrase('Cek jadwal Chelsea minggu ini'), 'jadwal chelsea minggu');
    assert.equal(RQ.corePhrase('Apa versi terbaru Linux Mint saat ini'), 'versi terbaru linux mint');
});

// ---- ENGINE WIRING ----
test('Q1: engine computes intent once and gates on all legs', () => {
    assert.ok(ENGINE_SRC.includes('const reqIntent = _detectIntent(q)'), 'intent once per request');
    assert.ok(ENGINE_SRC.includes('_gateRelevantSources(gateQuery'), 'gate wired');
    assert.ok(ENGINE_SRC.includes("stage: 'web_search_relevance'"), 'relevance stage');
    assert.ok(ENGINE_SRC.includes('intent='), 'intent in trace');
});
test('Q2: single grounding round + guards intact', () => {
    assert.ok(ENGINE_SRC.includes('_stale(myGen)'), 'stale protection');
    assert.ok(ENGINE_SRC.includes('_isCancelled('), 'cancellation');
    const fanoutCalls = ENGINE_SRC.split('_fanoutWebSearch(').length - 1;
    assert.ok(fanoutCalls >= 4 && fanoutCalls <= 6, 'one dispatch per leg (found ' + fanoutCalls + ')');
});

// ---- DOMAIN CONFIRMATION (general, no whitelist) ----
test('S1: official homepage kept via domain-confirmed entity', () => {
    const tw = { title: 'Twitter', url: 'https://twitter.com/', domain: 'twitter.com', snippet: 'Follow updates' };
    const out = RQ.filterRelevantSources('Twitter X owner Elon Musk', [tw], null);
    assert.equal(out.length, 1, 'entity homepage kept');
});
test('S2: raw URL text never creates coverage alone', () => {
    const spam = { title: 'Promo Cicilan Motor', url: 'https://emas-spam.id/promo', domain: 'emas-spam.id', snippet: 'Promo cicilan motor murah' };
    const out = RQ.filterRelevantSources('Berapa harga emas hari ini?', [spam], null);
    assert.deepStrictEqual(out, [], 'slug-stuffed spam rejected');
});

// ---- E2E: junk-only -> no_results, never grounded ----
test('R: engine fails closed on junk-only SearXNG', (t, done) => {
    const provider = {
        request(payload, cancellable, cb) {
            if (Array.isArray(payload.tools) && payload.tools.includes('web_search')) {
                return cb(null, { type: 'tool_call', tool: 'web_search', arguments: { query: 'Linux Mint latest version' } });
            }
            return cb(null, { type: 'answer', text: 'should never ground here' });
        }
    };
    const tool = {
        search(req, cancellable, cb) {
            if (typeof cancellable === 'function' && !cb) { cb = cancellable; cancellable = null; }
            const q = (req && req.query) || '';
            cb(null, { type: 'tool_result', tool: 'web_search', query: q, sources: [APA, SCRIBBR] });
        }
    };
    const engine = createAISearchEngine({ provider, webSearchTool: tool, enableGrounding: true });
    engine.search('Apa versi terbaru Linux Mint saat ini?', {
        onAnswer: () => done(new Error('must not answer from unrelated sources')),
        onError: (e) => {
            try {
                assert.equal(e.code, 'no_results', 'fail closed, got ' + e.code);
                done();
            } catch (a) { done(a); }
        },
        onDone: (e) => {
            try {
                assert.ok(e && e.code === 'no_results', 'fail closed via onDone');
                done();
            } catch (a) { done(a); }
        }
    });
});
