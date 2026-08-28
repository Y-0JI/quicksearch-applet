// Unit tests for the question router (Phase 13 latency fix).
const { test } = require('node:test');
const assert = require('node:assert');
const { createQuestionRouter } = require('../providers/questionRouter.js');

const fakeApp = q => (/firefox/i.test(q) ? [{ appId: 'firefox.desktop' }] : []);

test('router: general knowledge -> Fast Path (false)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('Apa ibu kota Jepang?'), false);
    assert.equal(r('Jelaskan plocate'), false);
    assert.equal(r('Siapa penemu lampu?'), false);
});

test('router: web intent -> agent loop (true)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('Cari berita BMRI hari ini'), true);
    assert.equal(r('search python tutorial'), true);
    assert.equal(r('cari resep rendang'), true);
});

test('router: Indonesian affixed "cari" forms -> agent loop (true)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('carikan harga BMRI hari ini'), true);
    assert.equal(r('mencari resep rendang'), true);
    assert.equal(r('cari di google harga emas'), true);
    assert.equal(r('cariin cara pasang linux'), true);
    assert.equal(r('info pencarian hotel jakarta'), true);
});

test('router: app launch with matching app -> agent loop (true)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('Buka Firefox'), true);
    assert.equal(r('launch firefox'), true);
});

test('router: "buka" without a known app -> Fast Path (false)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('buka pintu'), false);
});

test('router: URL -> agent loop (true)', () => {
    const r = createQuestionRouter({ detectUrl: u => /^https?:\/\//.test(u) ? u : null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('buka https://google.com'), true);
});

test('router: arithmetic -> agent loop (true, keep calculator)', () => {
    const r = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(r('2 + 2'), true);
    assert.equal(r('hitung 12*8'), true);
});

test('router: computer-control verbs gated by computerControl presence', () => {
    const off = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: null, hasScreen: () => false });
    const on = createQuestionRouter({ detectUrl: () => null, appProvider: { searchApps: fakeApp }, computerControl: {}, hasScreen: () => false });
    assert.equal(off('ketik halo'), false); // control disabled -> not routed
    assert.equal(on('ketik halo'), true);   // control enabled -> agent loop
});
