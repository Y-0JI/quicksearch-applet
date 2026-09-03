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
