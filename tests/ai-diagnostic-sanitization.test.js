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

// — regression: error propagation must preserve metadata —
test('regression: sync throw with stage/status/name preserved (task 6)', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const prov = {
    request: (payload, c, cb) => {
      if (typeof c === 'function') { cb = c; c = null; }
      const e = new Error('real runtime error');
      e.code = 'provider_error';
      e.stage = 'send_async';
      e.status = 500;
      e.name = 'TypeError';
      throw e;
    },
    streamRequest: (payload, c, onEvent) => {
      if (typeof c === 'function') { onEvent = c; c = null; }
      const e = new Error('real runtime error');
      e.code = 'provider_error';
      e.stage = 'send_async';
      e.status = 500;
      e.name = 'TypeError';
      throw e;
    },
    destroy() {}
  };
  const engine = createAISearchEngine({ provider: prov, webSearchTool: { search: (q,c,cb)=>cb(null,{type:'tool_result',sources:[{url:'https://example.com'}]}) } });
  const evt = await new Promise(resolve => {
    engine.searchStream('hello', { onError: (e)=>resolve(e), onComplete: ()=>resolve(null) });
    setTimeout(()=>resolve(null), 800);
  });
  assert.ok(evt, 'must error');
  assert.equal(evt.code, 'provider_error');
  assert.equal(evt.message, 'real runtime error');
  assert.equal(evt.stage, 'send_async');
  assert.equal(evt.status, 500);
  assert.equal(evt.name, 'TypeError');
  assert.ok(!String(evt.message).includes('API_KEY_SHOULD_NOT_APPEAR_12345'));
});

test('regression: second leg sync throw preserved', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const prov = {
    request(payload, c, cb) { if (typeof c==='function'){cb=c;c=null;} cb(null,{type:'answer',text:'ok'}); },
    streamRequest(payload, c, onEvent) {
      if (typeof c==='function'){ onEvent=c; c=null; }
      // first leg: emit tool_call -> engine will call webSearch then second streamRequest
      // detect second leg by groundingContext
      if (payload.groundingContext) {
        const e = new Error('Expected Gio.Cancellable');
        e.code = 'provider_error';
        e.stage = 'send_async';
        e.name = 'TypeError';
        e.status = 500;
        throw e;
      }
      // first leg: emit tool_call
      setTimeout(()=>onEvent({type:'start'}), 1);
      setTimeout(()=>onEvent({type:'tool_call', tool:'web_search', arguments:{query:'q'}}), 5);
    },
    destroy(){}
  };
  const engine = createAISearchEngine({ provider: prov, webSearchTool: { search: (q,c,cb)=>cb(null,{type:'tool_result', sources:[{url:'https://example.com/a', title:'t'}]}) }, enableGrounding:true });
  const err = await new Promise(resolve=>{
    engine.searchStream('hello', { onError: e=>resolve(e), onComplete: ()=>resolve(null) });
    setTimeout(()=>resolve(null), 800);
  });
  assert.ok(err, 'must error on second leg');
  assert.equal(err.code, 'provider_error');
  assert.equal(err.message, 'Expected Gio.Cancellable');
  assert.equal(err.stage, 'send_async');
  assert.equal(err.name, 'TypeError');
});

test('regression: unknown provider error preserves sanitized message (task 7)', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const prov = {
    request: (p,c,cb)=>{ if(typeof c==='function'){cb=c;c=null;} throw new Error('unexpected transport failure'); },
    streamRequest: (p,c,onEvent)=>{ if(typeof c==='function'){onEvent=c;c=null;} throw new Error('unexpected transport failure'); },
    destroy(){}
  };
  const engine = createAISearchEngine({ provider: prov, webSearchTool: { search: (q,c,cb)=>cb(new Error('no')) } });
  const err = await new Promise(resolve=>{
    engine.searchStream('hi', { onError:e=>resolve(e), onComplete:()=>resolve(null) });
    setTimeout(()=>resolve(null), 800);
  });
  assert.ok(err);
  assert.equal(err.code, 'provider_error');
  assert.ok(String(err.message).includes('unexpected transport failure'), err.message);
  // stage may be null/undefined for unknown throw without stage — must not be 'unknown' string?
  // should not hide message behind generic
  assert.notEqual(err.message, 'AI provider unavailable');
});

test('regression: Bearer/api_key redacted even when preserving message', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const secret = FAKE_KEY;
  const prov = {
    request: (p,c,cb)=>{ if(typeof c==='function'){cb=c;c=null;} const e=new Error('fail Bearer '+secret+' api_key='+secret); e.code='provider_error'; e.stage='send_async'; throw e; },
    streamRequest: (p,c,onEvent)=>{ if(typeof c==='function'){onEvent=c;c=null;} const e=new Error('fail Bearer '+secret+' api_key='+secret); e.code='provider_error'; e.stage='send_async'; throw e; },
    destroy(){}
  };
  const engine = createAISearchEngine({ provider: prov, webSearchTool: { search: (q,c,cb)=>cb(new Error('no')) } });
  const err = await new Promise(resolve=>{
    engine.searchStream('hi', { onError:e=>resolve(e), onComplete:()=>resolve(null) });
    setTimeout(()=>resolve(null), 800);
  });
  assert.ok(err);
  assert.ok(!String(err.message).includes(secret), 'must be redacted');
  assert.ok(String(err.message).includes('[REDACTED]'));
  assert.equal(err.stage, 'send_async');
});

test('regression: non-stream search sync throw also preserves metadata', async () => {
  const { createAISearchEngine } = require('../ai/aiSearchEngine.js');
  const prov = {
    request: (p,c,cb)=>{ if(typeof c==='function'){cb=c;c=null;} const e=new Error('real runtime error'); e.code='provider_error'; e.stage='read_bytes_async'; e.status=503; e.name='TypeError'; throw e; },
    streamRequest: (p,c,onEvent)=>{ if(typeof c==='function'){onEvent=c;c=null;} const e=new Error('real runtime error'); e.code='provider_error'; e.stage='read_bytes_async'; e.status=503; e.name='TypeError'; throw e; },
    destroy(){}
  };
  const engine = createAISearchEngine({ provider: prov, webSearchTool: { search: (q,c,cb)=>cb(new Error('no')) } });
  const err = await new Promise(resolve=>{
    engine.search('hi', { onError:e=>resolve(e), onAnswer:()=>resolve(null) });
    setTimeout(()=>resolve(null), 800);
  });
  // search uses callback object or function — we passed object
  assert.ok(err);
  assert.equal(err.code, 'provider_error');
  assert.equal(err.message, 'real runtime error');
  assert.equal(err.stage, 'read_bytes_async');
  assert.equal(err.status, 503);
});

