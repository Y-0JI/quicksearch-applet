const { test } = require('node:test');
const assert = require('node:assert');

test('webSearchTool _defaultHttpGet bridges plain JS cancellable to Gio.Cancellable', () => {
    const webSearchTool = require('../ai/webSearchTool.js');
    class FakeCancellable {
        constructor(){ this.cancelled=false; this.handlers=new Map(); this.nextId=1; }
        is_cancelled(){ return this.cancelled; }
        cancel(){ this.cancelled=true; for(const fn of this.handlers.values()) try{fn();}catch(e){} }
        connect(sig, fn){ const id=this.nextId++; this.handlers.set(id, fn); return id; }
        disconnect(id){ this.handlers.delete(id); }
    }
    const fakeGio = {
        Cancellable: FakeCancellable,
        DataInputStream: function(opts){ this.base_stream = opts && opts.base_stream; },
        File: { new_for_path: (p)=>({ replace_contents: ()=>[true], read: ()=>({ close:()=>{}, close_async: (a,b,cb)=>{ try{cb&&cb();}catch(e){} } }), delete: ()=>{} }) },
        FileCreateFlags: { REPLACE_DESTINATION: 0 }
    };
    fakeGio.DataInputStream.prototype.read_line_async = function(prio, canc, cb){ setImmediate(()=> cb(this, {})); };
    let _bridgeCall=0;
    fakeGio.DataInputStream.prototype.read_line_finish_utf8 = function(){ _bridgeCall++; if(_bridgeCall===1) return ['<html><body>ok</body></html>']; return [null]; };
    const fakeGLib = { PRIORITY_DEFAULT: 0, timeout_add: (p,ms,fn)=>setTimeout(fn,ms), source_remove: (id)=>clearTimeout(id), SOURCE_REMOVE: false, FileCreateFlags: { REPLACE_DESTINATION: 0 } };
    let capturedCancellable = null;
    let capturedIsGio = false;
    const fakeSoup = {
        Session: class {
            constructor(){}
            get timeout(){return 0} set timeout(v){}
            send_async(msg, prio, cancellable, cb){
                capturedCancellable = cancellable;
                capturedIsGio = cancellable instanceof FakeCancellable;
                const fakeStream = { close:()=>{}, close_async: (a,b,cb)=>{ try{cb&&cb();}catch(e){} } };
                setImmediate(()=> cb({ send_finish: ()=> fakeStream }, {}));
            }
        },
        Message: { new: (m,u)=>({ request_headers:{append:()=>{}}, get_status:()=>200, response_headers:{ get_one:()=>'text/html' }, set_request_body:()=>{}, set_request_body_from_bytes:()=>{} }) }
    };
    webSearchTool.__setGioSoupForTest(fakeGio, fakeGLib, fakeSoup);
    const backend = webSearchTool._createProductionBackend({ engine:'searxng', searxngUrl:'http://127.0.0.1:8080' });
    const appCancellable = { cancelled:false, is_cancelled(){ return this.cancelled; }, cancel(){ this.cancelled=true; } };
    let cbCalled = false;
    backend.search('test', 5, appCancellable, (err,res)=>{ cbCalled=true; });
    // Need to wait tick for Soup capture
    return new Promise((resolve,reject)=>{
        setTimeout(()=>{
            try {
                assert.ok(capturedCancellable !== appCancellable, 'should not pass plain JS object directly to Soup');
                assert.ok(capturedIsGio, 'Soup should receive Gio.Cancellable instance');
                assert.ok(capturedCancellable instanceof FakeCancellable, 'is Gio.Cancellable');
                webSearchTool.__setGioSoupForTest(null, null, null);
                resolve();
            } catch(e){ webSearchTool.__setGioSoupForTest(null,null,null); reject(e); }
        }, 20);
    });
});

test('webSearchTool bridge cancellation: app cancel -> native cancel', () => {
    const webSearchTool = require('../ai/webSearchTool.js');
    class FakeCancellable {
        constructor(){ this.cancelled=false; this.handlers=new Map(); this.nextId=1; }
        is_cancelled(){ return this.cancelled; }
        cancel(){ this.cancelled=true; for(const fn of this.handlers.values()) try{fn();}catch(e){} }
        connect(sig, fn){ const id=this.nextId++; this.handlers.set(id, fn); return id; }
        disconnect(id){ this.handlers.delete(id); }
    }
    const fakeGio = { Cancellable: FakeCancellable };
    const fakeGLib = { PRIORITY_DEFAULT: 0, timeout_add: (p,ms,fn)=>setTimeout(fn,ms), source_remove: (id)=>clearTimeout(id) };
    webSearchTool.__setGioSoupForTest(fakeGio, fakeGLib, null);
    const appCancellable = { cancelled:false, is_cancelled(){ return this.cancelled; }, cancel(){ this.cancelled=true; } };
    const resolved = webSearchTool._resolveSoupCancellable(appCancellable);
    assert.ok(resolved.soupCancellable instanceof FakeCancellable, 'native created');
    assert.notEqual(resolved.soupCancellable, appCancellable);
    let nativeCancelled = false;
    const orig = FakeCancellable.prototype.cancel;
    const native = resolved.soupCancellable;
    FakeCancellable.prototype.cancel = function(){ nativeCancelled=true; orig.call(this); };
    appCancellable.cancel();
    // Give bridge time to propagate
    return new Promise((resolve,reject)=>{
        setTimeout(()=>{
            try {
                assert.ok(nativeCancelled || native.cancelled, 'native should be cancelled via bridge');
                FakeCancellable.prototype.cancel = orig;
                try { resolved.bridgeCleanup(); } catch(e){}
                webSearchTool.__setGioSoupForTest(null,null,null);
                resolve();
            } catch(e){ FakeCancellable.prototype.cancel = orig; webSearchTool.__setGioSoupForTest(null,null,null); reject(e); }
        }, 10);
    });
});

test('webSearchTool DDG/Bing backends also use Gio bridge (not plain)', () => {
    const webSearchTool = require('../ai/webSearchTool.js');
    class FakeCancellable {
        constructor(){ this.cancelled=false; this.handlers=new Map(); this.nextId=1; }
        is_cancelled(){ return this.cancelled; }
        cancel(){ this.cancelled=true; for(const fn of this.handlers.values()) try{fn();}catch(e){} }
        connect(sig, fn){ const id=this.nextId++; this.handlers.set(id, fn); return id; }
        disconnect(id){ this.handlers.delete(id); }
    }
    // DDG/Bing now go via _defaultHttpGet -> soupTextReader (send_async), not send_and_read_async
    const htmlByEng = {
        bing: '<li class="b_algo"><h2><a href="https://example.com/a">T</a></h2><p>snip</p></li>',
        ddgo: '<div class="result"><a href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Title</a><a class="result__snippet">snip</a></div>'
    };
    const engines = ['ddgo', 'bing'];
    let chain = Promise.resolve();
    for (const eng of engines) {
        chain = chain.then(() => new Promise((resolve, reject) => {
            let captured = null;
            let capturedIsGio = false;
            const lines = [htmlByEng[eng]];
            let callN = 0;
            const fakeStream = { close:()=>{}, close_async: (a,b,cb)=>{ try{cb&&cb();}catch(e){} } };
            const fakeDis = { read_line_async(prio,canc,cb){ setImmediate(()=> cb(fakeDis, {})); }, read_line_finish_utf8(){ callN++; if(callN===1) return [lines[0]]; return [null]; }, base_stream: fakeStream };
            const fakeGio = {
                Cancellable: FakeCancellable,
                DataInputStream: function(opts){ return fakeDis; },
                File: { new_for_path: (p)=>({ replace_contents: ()=>[true], read: ()=> fakeStream, delete: ()=>{} }) },
                FileCreateFlags: { REPLACE_DESTINATION: 0 }
            };
            fakeGio.DataInputStream.prototype = fakeDis;
            const fakeGLib = { PRIORITY_DEFAULT: 0, timeout_add: (p,ms,fn)=>setTimeout(fn,ms), source_remove: (id)=>clearTimeout(id), SOURCE_REMOVE: false, FileCreateFlags: { REPLACE_DESTINATION: 0 } };
            const fakeSoup = {
                Session: class {
                    constructor(){}
                    get timeout(){return 0} set timeout(v){}
                    send_async(msg, prio, cancellable, cb){
                        captured = cancellable;
                        capturedIsGio = cancellable instanceof FakeCancellable;
                        setImmediate(()=> cb({ send_finish: ()=> fakeStream }, {}));
                    }
                },
                Message: { new: (m,u)=>({ request_headers:{append:()=>{}}, get_status:()=>200, response_headers:{ get_one:()=>'text/html' }, set_request_body:()=>{}, set_request_body_from_bytes:()=>{} }) }
            };
            webSearchTool.__setGioSoupForTest(fakeGio, fakeGLib, fakeSoup);
            const backend = webSearchTool._createProductionBackend({ engine: eng, searxngUrl:'http://127.0.0.1:8080' });
            const plain = { is_cancelled(){return false}, cancel(){} };
            backend.search('test', 5, plain, ()=>{});
            setTimeout(()=>{
                try {
                    assert.ok(captured !== plain, eng + ': should not pass plain directly');
                    assert.ok(capturedIsGio, eng + ': Soup should receive Gio.Cancellable');
                    assert.ok(captured instanceof FakeCancellable, eng + ': is Gio.Cancellable');
                    webSearchTool.__setGioSoupForTest(null,null,null);
                    resolve();
                } catch(e){ webSearchTool.__setGioSoupForTest(null,null,null); reject(e); }
            }, 20);
        }));
    }
    return chain.then(()=>{ webSearchTool.__setGioSoupForTest(null,null,null); });
});

test('webSearchTool Google Soup also bridged', () => {
    const webSearchTool = require('../ai/webSearchTool.js');
    class FakeCancellable {
        constructor(){ this.cancelled=false; }
        is_cancelled(){ return this.cancelled; }
        cancel(){ this.cancelled=true; }
        connect(){return 1}
        disconnect(){}
    }
    const fakeGio = {
        Cancellable: FakeCancellable,
        DataInputStream: function(opts){ this.base_stream = opts && opts.base_stream; },
        File: { new_for_path: (p)=>({ replace_contents: ()=>[true], read: ()=>({ close:()=>{}, close_async: (a,b,cb)=>{ try{cb&&cb();}catch(e){} } }), delete: ()=>{} }) },
        FileCreateFlags: { REPLACE_DESTINATION: 0 }
    };
    fakeGio.DataInputStream.prototype.read_line_async = function(prio, canc, cb){ setImmediate(()=> cb(this, {})); };
    let _gCall=0;
    fakeGio.DataInputStream.prototype.read_line_finish_utf8 = function(){ _gCall++; if(_gCall===1) return ['{"organic":[{"title":"T","link":"https://example.com/a","snippet":"s"}]}']; return [null]; };
    const fakeGLib = {
        PRIORITY_DEFAULT: 0,
        timeout_add: (p,ms,fn)=>setTimeout(fn,ms),
        source_remove: (id)=>clearTimeout(id),
        Bytes: { new: (s)=>s },
        SOURCE_REMOVE: false,
        FileCreateFlags: { REPLACE_DESTINATION: 0 }
    };
    let captured = null;
    const fakeSoup = {
        Session: class {
            send_async(msg, prio, cancellable, cb){
                captured = cancellable;
                const fakeStream = { close:()=>{}, close_async: (a,b,cb)=>{ try{cb&&cb();}catch(e){} } };
                setImmediate(()=> cb({ send_finish: ()=> fakeStream }, {}));
            }
        },
        Message: { new: ()=>({ request_headers:{append:()=>{}}, get_status:()=>200, response_headers:{ get_one:()=>'application/json' }, set_request_body:()=>{}, set_request_body_from_bytes:()=>{} }) }
    };
    webSearchTool.__setGioSoupForTest(fakeGio, fakeGLib, fakeSoup);
    const backend = webSearchTool._createProductionBackend({ engine:'google', googleApiKey:'fake-key' });
    const plain = { is_cancelled(){return false}, cancel(){} };
    let done=false;
    backend.search('test', 5, plain, (err,res)=>{ done=true; });
    return new Promise((resolve,reject)=>{
        setTimeout(()=>{
            try {
                assert.ok(captured instanceof FakeCancellable, 'Google Soup should receive Gio.Cancellable not plain');
                assert.notEqual(captured, plain);
                webSearchTool.__setGioSoupForTest(null,null,null);
                resolve();
            } catch(e){ webSearchTool.__setGioSoupForTest(null,null,null); reject(e); }
        }, 30);
    });
});
