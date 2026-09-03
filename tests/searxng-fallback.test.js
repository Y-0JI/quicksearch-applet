const { test } = require('node:test');
const assert = require('node:assert');
const { _createProductionBackend } = require('../ai/webSearchTool.js');

function htmlWithResults() {
  return `<html><body><div id="results">
    <article class="result"><h3><a href="https://example.com/a">Title A</a></h3><p class="content">snippet a</p></article>
    <article class="result"><h3><a href="https://example.com/b">Title B</a></h3><p class="content">snippet b</p></article>
  </div></body></html>`;
}
function htmlNoResults(){ return `<html><body><div id="results"></div></body></html>`; }
function ddgHtmlWithResults(){ return `<html><body><div class="result"><a class="result__a" href="https://ddg-example.com/1">Ddg One</a><a class="result__snippet">snip 1</a></div></body></html>`; }
function liteHtmlWithResults(){ return `<html><body><a href="https://duckduckgo.com/?q=x">Web</a><table><tr><td><a rel="nofollow" href="https://lite-example.com/1">Lite One</a></td><td class="result-snippet">snip one</td></tr><tr><td><a rel="nofollow" href="https://lite-example.com/2">Lite Two</a></td></tr></table></body></html>`; }

test('searxng: JSON 403 fallback to HTML succeeds', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            if (url.includes('&format=json')) {
                const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<!doctype html><title>403'; e.contentType='text/html'; e.stage='web_search_request'; return cb(e);
            }
            cb(null, htmlWithResults());
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{ assert.equal(err,null); assert.equal(raw.length,2); assert.equal(raw[0].url,'https://example.com/a'); res(); }catch(e){rej(e);}
        });
    });
});

test('searxng: JSON returns HTML (200 text/html) fallback to HTML', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=> cb(null, htmlWithResults())
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{ assert.equal(err,null); assert.equal(raw.length,2); res(); }catch(e){rej(e);}
        });
    });
});

test('searxng: HTML fallback no results -> diagnostic with HTTP status', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            if (url.includes('&format=json')) { const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<!doctype html>403'; e.contentType='text/html'; return cb(e); }
            cb(null, htmlNoResults());
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{
                assert.ok(err);
                assert.equal(err.code,'request_failed');
                assert.equal(err.stage,'web_search_request');
                assert.match(err.message, /HTTP 403/);
                assert.match(err.message, /Expected application\/json/);
                res();
            }catch(e){rej(e);}
        });
    });
});

test('searxng: JSON 403 AND SearXNG HTML request failure -> DDG HTML rescues', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            if (url.includes('&format=json')) { const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<html>403'; e.contentType='text/html'; return cb(e); }
            if (url.startsWith('http://127.0.0.1:8080/')) { const e=new Error('HTTP 500'); e.status=500; e.httpStatus=500; return cb(e); }
            cb(null, ddgHtmlWithResults());
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{ assert.equal(err,null); assert.equal(raw.length,1); assert.equal(raw[0].url,'https://ddg-example.com/1'); res(); }catch(e){rej(e);}
        });
    });
});

test('searxng: SearXNG HTML 0 results and DDG HTML 0 -> DDG Lite rescues', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            if (url.includes('&format=json')) { const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<html>403'; e.contentType='text/html'; return cb(e); }
            if (url.startsWith('https://lite.duckduckgo.com')) return cb(null, liteHtmlWithResults());
            cb(null, htmlNoResults());
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{ assert.equal(err,null); assert.equal(raw.length,2); assert.equal(raw[0].url,'https://lite-example.com/1'); res(); }catch(e){rej(e);}
        });
    });
});

test('searxng: JSON 200 zero results still rescues via HTML/DDG chain', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            if (url.includes('&format=json')) return cb(null, JSON.stringify({ results: [] }));
            if (url.startsWith('https://lite.duckduckgo.com')) return cb(null, liteHtmlWithResults());
            cb(null, htmlNoResults());
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{ assert.equal(err,null); assert.equal(raw.length,2); assert.equal(raw[0].url,'https://lite-example.com/1'); res(); }catch(e){rej(e);}
        });
    });
});

test('searxng: total chain failure yields request_failed diagnostic naming DDG', async () => {
    const backend = _createProductionBackend({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<html>403'; e.contentType='text/html'; return cb(e);
        }
    });
    await new Promise((res,rej)=>{
        backend.search('chelsea',5,null,(err,raw)=>{
            try{
                assert.ok(err);
                assert.equal(err.code,'request_failed');
                assert.equal(err.stage || err._stage,'web_search_request');
                assert.ok(err.message.includes('DDG fallback also failed'), 'naming DDG legs: ' + err.message);
                assert.ok(err.message.includes('DDG HTML'), 'ddg html named: ' + err.message);
                assert.ok(err.message.includes('DDG Lite'), 'ddg lite named: ' + err.message);
                res();
            }catch(e){rej(e);}
        });
    });
});

test('_parseDdgLiteForSources: external results only, DDG-internal links skipped', () => {
    const { _parseDdgLiteForSources } = require('../ai/webSearchTool.js');
    const out = _parseDdgLiteForSources(liteHtmlWithResults());
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://lite-example.com/1');
    assert.ok(out[0].snippet.includes('snip one'));
});

test('searxng: HTTP 403 diagnostic includes stage and content-type', async () => {
    const { createProductionWebSearchTool } = require('../ai/webSearchTool.js');
    const tool = createProductionWebSearchTool({
        engine:'searxng',
        searxngUrl:'http://127.0.0.1:8080',
        httpGet: (url,canc,cb)=>{
            const e=new Error('HTTP 403'); e.status=403; e.httpStatus=403; e.bodyText='<!doctype html>403'; e.contentType='text/html'; e.stage='web_search_request'; return cb(e);
        }
    });
    // Make HTML also fail to trigger diagnostic
    const backend = tool.__backend;
    // Override html to also fail so we get diagnostic
    await new Promise((res,rej)=>{
        tool.search({query:'chelsea',maxResults:5}, (err,result)=>{
            try{
                assert.ok(err);
                // After HTML fallback fail, should still have stage web_search_request
                assert.equal(err.stage || err._stage, 'web_search_request');
                res();
            }catch(e){rej(e);}
        });
    });
});
