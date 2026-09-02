const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { createNineRouterProvider } = require('../ai/nineRouterProvider.js');

const FAKE_KEY = 'API_KEY_SHOULD_NOT_APPEAR_12345';
const FAKE_BEARER = 'Bearer ' + FAKE_KEY;
const FAKE_MODEL = 'test-model';

function collectStream(provider, payload) {
  return new Promise(resolve => {
    const events = [];
    provider.streamRequest(payload || { query: 'hi' }, evt => {
      events.push(evt);
      if (evt.type === 'complete' || evt.type === 'error') setTimeout(() => resolve(events), 10);
    });
    setTimeout(() => resolve(events), 800);
  });
}

test('diagnostic: apiKey never in stream error message (sanitized to [REDACTED])', async () => {
  const body = JSON.stringify({ error: { message: 'fail with ' + FAKE_KEY } });
  const provider = createNineRouterProvider({
    baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
    httpStreamFetch: (url, opts, onChunk, onDone) => {
      const err = new Error('upstream says ' + FAKE_KEY + ' also ' + FAKE_BEARER);
      err.status = 500;
      setTimeout(() => onDone(err), 5);
    }
  });
  const events = await collectStream(provider, { query: 'hi' });
  const err = events.find(e => e.type === 'error');
  assert.ok(err, 'must have error');
  const msg = String(err.error.message || '');
  assert.ok(!msg.includes(FAKE_KEY), 'message must not contain raw key: ' + msg);
  assert.ok(msg.includes('[REDACTED]'), 'message must be redacted');
  assert.ok(err.error.stage, 'stage must be present: ' + JSON.stringify(err.error));
  // extra: ensure no status leak hides key
  const all = JSON.stringify(err.error);
  assert.ok(!all.includes(FAKE_KEY), 'error payload must not contain raw key');
});

test('diagnostic: Bearer token redacted in error message', async () => {
  const provider = createNineRouterProvider({
    baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
    httpStreamFetch: (url, opts, onChunk, onDone) => {
      const err = new Error('auth failed Bearer ' + FAKE_KEY + ' extra');
      err.status = 401;
      setTimeout(() => onDone(err), 5);
    }
  });
  const events = await collectStream(provider, { query: 'hi' });
  const err = events.find(e => e.type === 'error');
  assert.ok(err);
  const msg = String(err.error.message || '');
  assert.ok(!msg.includes(FAKE_KEY));
  if (msg.includes('Bearer')) assert.ok(msg.includes('[REDACTED]'));
  assert.equal(err.error.stage, 'http_status');
  assert.ok(err.error.status === 401 || err.error.httpStatus === 401);
});

test('diagnostic: http_status stage preserved, api_key pattern redacted', async () => {
  const provider = createNineRouterProvider({
    baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
    httpStreamFetch: (url, opts, onChunk, onDone) => {
      const err = new Error('api_key=' + FAKE_KEY + ' leaked');
      err.status = 500;
      setTimeout(() => onDone(err), 5);
    }
  });
  const events = await collectStream(provider, { query: 'hi' });
  const err = events.find(e => e.type === 'error');
  assert.ok(err);
  assert.ok(!String(err.error.message).includes(FAKE_KEY));
  assert.ok(String(err.error.message).includes('[REDACTED]'));
  assert.equal(err.error.stage, 'http_status');
});

test('diagnostic: request non-streaming also redacts key', async () => {
  const provider = createNineRouterProvider({
    baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
    httpFetch: () => Promise.reject(new Error('network fail api_key: ' + FAKE_KEY))
  });
  await new Promise((resolve, reject) => {
    provider.request({ query: 'hi' }, (err, res) => {
      try {
        assert.ok(err);
        assert.ok(!String(err.message).includes(FAKE_KEY), err.message);
        assert.ok(String(err.message).includes('[REDACTED]') || err.code === 'network_error');
        assert.ok(err.stage, 'stage must be present');
        resolve();
      } catch (e) { reject(e); }
    });
  });
});

test('diagnostic: stage propagated through AISearchEngine', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const provider = createNineRouterProvider({
    baseUrl: 'http://localhost:3000', apiKey: FAKE_KEY, model: FAKE_MODEL,
    httpStreamFetch: (url, opts, onChunk, onDone) => {
      const err = new Error('boom ' + FAKE_KEY);
      err.status = 503;
      err.stage = 'send_finish';
      setTimeout(() => onDone(err), 5);
    }
  });
  const engine = createAISearchEngine({ provider, webSearchTool: { search: (q,c,cb)=>cb(new Error('no')) } });
  const events = [];
  await new Promise(resolve => {
    engine.searchStream('hello', {
      onStart(){}, onDelta(){}, onComplete(d){ events.push({type:'complete', d}); resolve(); },
      onError(err){ events.push({type:'error', err}); resolve(); }
    });
    setTimeout(resolve, 800);
  });
  const errEvt = events.find(e => e.type === 'error');
  assert.ok(errEvt, 'engine must emit error');
  assert.ok(errEvt.err.stage, 'stage propagated to engine');
  assert.ok(!String(errEvt.err.message).includes(FAKE_KEY));
  assert.ok(['send_finish','http_status'].includes(errEvt.err.stage));
});

test('diagnostic: applet debug helper exists and redacts', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'applet.js'), 'utf8');
  assert.ok(src.includes('_buildAiDiagnosticText'), 'helper must exist');
  assert.ok(src.includes('ai_debug_mode'), 'debug mode binding must exist');
  assert.ok(src.includes('Bearer [REDACTED]') || src.includes('Bearer\\s+'), 'helper must redact Bearer');
  assert.ok(src.includes('api_key') || src.includes('api[_-]?key'), 'helper must redact api_key');
  assert.ok(src.includes('Stage:'), 'helper must show Stage');
  assert.ok(src.includes('HTTP status'), 'helper must show HTTP status');
  const schema = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'settings-schema.json'), 'utf8'));
  assert.equal(schema['ai-debug-mode'].default, false, 'default must be false');
  assert.equal(schema['ai-debug-mode'].type, 'switch');
});

test('diagnostic: all 12 stages wired in provider', () => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'ai/nineRouterProvider.js'), 'utf8');
  const required = ['provider_create','request_build','transport_select','soup_session_create','send_async','send_finish','http_status','input_stream','read_bytes_async','stream_parse','parser_flush','engine_callback'];
  for (const s of required) assert.ok(src.includes(s), 'stage missing: ' + s);
});
