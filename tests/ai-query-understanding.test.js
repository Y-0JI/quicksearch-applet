// tests/ai-query-understanding.test.js — GENERAL query understanding (no topic lists).
// Builder: ENTITY (generic caps/core) + INTENT vocab (existing) + TIME map (explicit).
// Unknown entities (SpaceX/ETH/Firefox/Fedora/Microsoft/BBCA) must work with zero rules.
const { test } = require('node:test');
const assert = require('node:assert');
const RQ = require('../ai/retrievalQuality.js');
const RI = require('../ai/responseIntent.js');

function build(q) {
    return RQ.optimizeRetrievalQuery(q, RI.detectResponseIntent(q));
}

// A–F: spec target shapes (semantic, mechanism-general).
test('A: sports schedule', () => {
    assert.equal(build('Cek jadwal Chelsea minggu ini'), 'Chelsea fixtures this week');
});
test('B: finance price', () => {
    assert.equal(build('Berapa harga Bitcoin sekarang?'), 'Bitcoin price today');
});
test('C: howto multi-entity', () => {
    assert.equal(build('Bagaimana cara install Docker di Linux Mint?'), 'How to install Docker on Linux Mint');
});
test('D: person current', () => {
    const out = build('Siapa pemilik Twitter sekarang?');
    assert.ok(/twitter/i.test(out) && /owner/i.test(out), 'entity+role: ' + out);
    assert.ok(/today|current/.test(out), 'temporal: ' + out);
});
test('E: software version', () => {
    assert.equal(build('Apa versi terbaru Linux Mint?'), 'Linux Mint version latest');
});
test('F: news', () => {
    assert.equal(build('Berita terbaru NVIDIA'), 'NVIDIA news latest');
});

// G: presentation instruction never topical.
test('G: meta stripped, topic kept', () => {
    const out = build('Siapa pemilik Twitter sekarang? Sertakan sumbernya.');
    assert.ok(out.indexOf('Sertakan') === -1, 'meta gone: ' + out);
    assert.ok(/twitter/i.test(out), 'topic kept: ' + out);
});

// H: entity preservation (source code intact).
test('H: source code untouched', () => {
    assert.equal(build('Linux Mint source code'), 'Linux Mint source code');
});

// I: unknown/new entities — zero special rules.
test('I1: SpaceX news', () => {
    assert.equal(build('Berita terbaru SpaceX'), 'SpaceX news latest');
});
test('I2: ETH price', () => {
    assert.equal(build('Berapa harga ETH sekarang?'), 'ETH price today');
});
test('I3: Firefox/Fedora howto', () => {
    assert.equal(build('Bagaimana cara install Firefox di Fedora?'), 'How to install Firefox on Fedora');
});
test('I4: Microsoft CEO', () => {
    const out = build('Siapa CEO Microsoft sekarang?');
    assert.ok(/microsoft/i.test(out) && /ceo/i.test(out), 'entity+role: ' + out);
});
test('I5: BBCA stock', () => {
    assert.equal(build('Berapa harga saham BBCA hari ini?'), 'BBCA stock price today');
});

// Fallback: unknown structure keeps cleaned wording, never empty.
test('J1: explanation falls back to cleaned wording', () => {
    const out = build('Jelaskan fotosintesis secara mendalam');
    assert.ok(out.length > 0 && out.indexOf('fotosintesis') !== -1, 'fallback: ' + out);
});
test('J2: meta-only never empty-searches', () => {
    assert.equal(build('Cite your sources.'), '');
});

// No topic lists anywhere in the builder.
test('K: no topic whitelist/blacklist in retrievalQuality', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ai', 'retrievalQuality.js'), 'utf8');
    const buildStart = src.indexOf('function _buildFocusedQuery(');
    const buildEnd = src.indexOf('function optimizeRetrievalQuery(');
    const builder = src.slice(buildStart, buildEnd).toLowerCase();
    for (const w of ['chelsea', 'mint', 'docker', 'bitcoin', 'nvidia', 'twitter', 'bbca', 'spacex', 'microsoft', 'bansos', 'scribbr', 'purdue', 'linuxmint.com', 'docker.com']) {
        assert.ok(builder.indexOf(w) === -1, 'no topic token in builder: ' + w);
    }
});

// Regression anchors (existing behavior preserved).
test('R1: funding/source-code wordings intact (prefix-strip only)', () => {
    assert.equal(RQ.optimizeRetrievalQuery('Apa sumber pendanaan Linux Mint?'), 'sumber pendanaan Linux Mint');
    assert.equal(RQ.optimizeRetrievalQuery('Linux Mint source code'), 'Linux Mint source code');
});
test('R2: fanout aspects preserved', () => {
    const out = RQ.optimizeRetrievalQuery('Linux Mint dari sisi keamanan dan performa', RI.detectResponseIntent('Linux Mint dari sisi keamanan dan performa'));
    assert.ok(/dari\s+sisi/i.test(out), 'aspect kept: ' + out);
});
