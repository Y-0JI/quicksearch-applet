const { test } = require('node:test');
const assert = require('node:assert');
const { createConversationManager } = require('../providers/conversationManager.js');

const OK = (answer) => (q, ctx, cb) => cb(null, { answer: answer || ('jawaban untuk: ' + q) });

test('single turn: history = user + assistant', () => {
    const cm = createConversationManager({});
    cm.send('jelaskan BMRI', OK('BMRI adalah bank'), () => {});
    const h = cm.history();
    assert.deepEqual(h, [
        { role: 'user', content: 'jelaskan BMRI' },
        { role: 'assistant', content: 'BMRI adalah bank' }
    ]);
    assert.equal(cm.size(), 2);
});

test('follow-up: context messages include prior turns in order', () => {
    const cm = createConversationManager({});
    let seen = null;
    const askFn = (q, ctx, cb) => { seen = ctx.messages; cb(null, { answer: 'ok' }); };
    cm.send('jelaskan BMRI', OK('BMRI adalah bank'), () => {});
    cm.send('bagaimana fundamentalnya?', askFn, () => {});
    // 2 prior turns + new question = 3 messages, correct order
    assert.deepEqual(seen.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(seen[0].content, 'jelaskan BMRI');
    assert.equal(seen[2].content, 'bagaimana fundamentalnya?');
});

test('maxTurns=8 means max 8 PAIRS (16 messages) as context', () => {
    const cm = createConversationManager({ maxTurns: 8 });
    let seen = null;
    const askFn = (q, ctx, cb) => { seen = ctx.messages; cb(null, { answer: 'a' + cm.size() }); };
    // 10 turns -> history grows to 20 messages; context must cap at 16
    // (8 PAIRS: maxTurns counts user+assistant as one pair)
    for (let i = 0; i < 10; i++) cm.send('q' + i, askFn, () => {});
    assert.ok(cm.size() > 16);              // full history kept in memory
    assert.equal(seen.length, 16);          // but only 16 messages sent
    assert.equal(seen[0].role, 'assistant'); // oldest kept message (mid-pair trim is fine)
    const users = seen.filter(m => m.role === 'user').map(m => m.content);
    assert.equal(users.length, 8);          // exactly 8 pairs
    assert.equal(users[0], 'q2');           // oldest two turns trimmed FIFO
    assert.equal(seen[15].content, 'q9');   // newest question last
});

test('buildMessages composes history + question without mutating', () => {
    const cm = createConversationManager({});
    cm.send('satu', OK('satu jawab'), () => {});
    const msgs = cm.buildMessages('dua?');
    assert.equal(msgs.length, 3);
    assert.equal(msgs[2].content, 'dua?');
    assert.equal(cm.size(), 2); // not mutated
});

test('clear() resets conversation', () => {
    const cm = createConversationManager({});
    cm.send('satu', OK('a'), () => {});
    cm.clear();
    assert.equal(cm.size(), 0);
    assert.deepEqual(cm.history(), []);
});

test('failed request rolls back the user turn (history intact)', () => {
    const cm = createConversationManager({});
    cm.send('satu', OK('a satu'), () => {});
    const before = cm.history();
    cm.send('dua gagal', (q, ctx, cb) => cb({ error: 'http-500' }), (err) => {
        assert.equal(err.error, 'http-500');
    });
    assert.deepEqual(cm.history(), before); // unchanged
    assert.equal(cm.size(), 2);
});

test('empty/whitespace question -> empty-question, nothing recorded', () => {
    const cm = createConversationManager({});
    cm.send('   ', OK('x'), (err) => assert.equal(err.error, 'empty-question'));
    assert.equal(cm.size(), 0);
});

test('5-turn conversation keeps full order', () => {
    const cm = createConversationManager({});
    for (let i = 0; i < 5; i++) cm.send('pertanyaan ' + i, OK('jawaban ' + i), () => {});
    const h = cm.history();
    assert.equal(h.length, 10);
    for (let i = 0; i < 5; i++) {
        assert.equal(h[i * 2].content, 'pertanyaan ' + i);
        assert.equal(h[i * 2 + 1].content, 'jawaban ' + i);
    }
});
