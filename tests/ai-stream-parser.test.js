const { test } = require('node:test');
const assert = require('node:assert');
const { createStreamParser } = require('../ai/streamParser.js');

function sseData(obj) {
    return 'data: ' + JSON.stringify(obj) + '\n\n';
}

function sseDone() {
    return 'data: [DONE]\n\n';
}

function sseDelta(text) {
    return sseData({ choices: [{ delta: { content: text } }] });
}

function collect(opts) {
    const events = [];
    const parser = createStreamParser(Object.assign({}, opts, { onEvent: e => events.push(e) }));
    return { parser, events };
}

test('A1: one event in one feed', () => {
    const { parser, events } = collect();
    parser.feed(sseDelta('Hello'));
    parser.flush();
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'start');
    assert.equal(events[1].type, 'delta');
    assert.equal(events[1].text, 'Hello');
    assert.equal(events[2].type, 'complete');
    assert.equal(events[2].result.text, 'Hello');
});

test('A2: multiple events in one chunk', () => {
    const { parser, events } = collect();
    parser.feed(sseDelta('Linux ') + sseDelta('Mint ') + sseDelta('is'));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 3);
    assert.equal(deltas[0].text, 'Linux ');
    assert.equal(deltas[1].text, 'Mint ');
    assert.equal(deltas[2].text, 'is');
    assert.equal(events[events.length - 1].result.text, 'Linux Mint is');
});

test('A3: event split across reads', () => {
    const { parser, events } = collect();
    const full = sseDelta('Hello world');
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    assert.equal(events.filter(e => e.type === 'delta').length, 0);
    parser.feed(full.slice(mid));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'Hello world');
});

test('A4: JSON split across reads', () => {
    const { parser, events } = collect();
    const full = sseData({ choices: [{ delta: { content: 'split' } }] });
    const mid = Math.floor(full.length / 2);
    parser.feed(full.slice(0, mid));
    parser.feed(full.slice(mid));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'split');
});

test('A5: empty keepalive events ignored', () => {
    const { parser, events } = collect();
    parser.feed(':\n\n');
    parser.feed('\n\n');
    parser.feed('event: ping\n\n');
    parser.feed(sseDelta('real'));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'real');
});

test('A6: [DONE] fires complete exactly once', () => {
    const { parser, events } = collect();
    parser.feed(sseDelta('text'));
    parser.feed(sseDone());
    parser.feed(sseDone());
    parser.flush();
    const completes = events.filter(e => e.type === 'complete');
    assert.equal(completes.length, 1);
    assert.equal(completes[0].result.text, 'text');
});

test('A7: unknown metadata safely ignored', () => {
    const { parser, events } = collect();
    parser.feed('data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');
    parser.feed(sseDelta('content'));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'content');
});

test('A8: no data lines produces no events', () => {
    const { parser, events } = collect();
    parser.feed('event: something\nid: 1\nretry: 3000\n\n');
    parser.flush();
    assert.equal(events.length, 0);
});

test('A9: empty string feed is safe', () => {
    const { parser, events } = collect();
    parser.feed('');
    parser.feed('');
    parser.flush();
    assert.equal(events.length, 0);
});

test('A10: feed after done is ignored', () => {
    const { parser, events } = collect();
    parser.feed(sseDelta('a'));
    parser.flush();
    const countBefore = events.length;
    parser.feed(sseDelta('b'));
    assert.equal(events.length, countBefore);
});

test('A11: flush with no data emits nothing', () => {
    const { parser, events } = collect();
    parser.flush();
    assert.equal(events.length, 0);
});

test('A12: realistic streaming scenario', () => {
    const { parser, events } = collect();
    parser.feed('data: {"choices":[{"delta":{"content":"Linux"}}]}\n\ndata: {"choices":[{"delta":{"content":" Mint"}}]}\n\n');
    parser.feed('data: {"choices":[{"delta":{"content":" is"}}]}');
    parser.feed('\n\ndata: {"choices":[{"delta":{"content":" a"}}]}\n\n');
    parser.feed(sseDone());
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 4);
    assert.equal(deltas[0].text, 'Linux');
    assert.equal(deltas[1].text, ' Mint');
    assert.equal(deltas[2].text, ' is');
    assert.equal(deltas[3].text, ' a');
    const complete = events.find(e => e.type === 'complete');
    assert.equal(complete.result.text, 'Linux Mint is a');
});

test('A13: error in payload emits error', () => {
    const { parser, events } = collect();
    parser.feed(sseData({ error: { message: 'Rate limited', code: 'rate_limit_exceeded' } }));
    parser.flush();
    const errs = events.filter(e => e.type === 'error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].error.code, 'rate_limit_exceeded');
});

test('A14: isDone state', () => {
    const { parser } = collect();
    assert.equal(parser.isDone(), false);
    parser.feed(sseDelta('hi'));
    assert.equal(parser.isDone(), false);
    parser.feed(sseDone());
    assert.equal(parser.isDone(), true);
});

test('A15: getAccumulatedText accumulates', () => {
    const { parser } = collect();
    parser.feed(sseDelta('Hello '));
    assert.equal(parser.getAccumulatedText(), 'Hello ');
    parser.feed(sseDelta('World'));
    assert.equal(parser.getAccumulatedText(), 'Hello World');
});

test('A16: non-string chunk ignored', () => {
    const { parser, events } = collect();
    parser.feed(null);
    parser.feed(undefined);
    parser.feed(42);
    assert.equal(events.length, 0);
});

test('A17: message.content format', () => {
    const { parser, events } = collect();
    parser.feed(sseData({ choices: [{ message: { content: 'answer' } }] }));
    parser.flush();
    const deltas = events.filter(e => e.type === 'delta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].text, 'answer');
});

test('A18: [DONE] without prior data emits start+complete', () => {
    const { parser, events } = collect();
    parser.feed(sseDone());
    const types = events.map(e => e.type);
    assert.ok(types.includes('start'), 'should emit start');
    assert.ok(types.includes('complete'), 'should emit complete');
    assert.equal(events.find(e => e.type === 'complete').result.text, '');
});
