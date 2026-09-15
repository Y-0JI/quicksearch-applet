// Weather card: structured live-data snapshot rides from Open-Meteo through the
// engine into the assistant message, and the applet renders it as a native card
// (icon, big temp, humidity/wind, 3-day strip, sparkline) above the answer text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APPLET_SRC = fs.readFileSync(path.join(ROOT, 'applet.js'), 'utf8');
const LDF_SRC = fs.readFileSync(path.join(ROOT, 'ai/liveDataFallback.js'), 'utf8');
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'ai/aiSearchEngine.js'), 'utf8');
const CONV_SRC = fs.readFileSync(path.join(ROOT, 'ai/conversationState.js'), 'utf8');
const PROMPT_SRC = fs.readFileSync(path.join(ROOT, 'ai/promptBuilder.js'), 'utf8');    const CSS_SRC = fs.readFileSync(path.join(ROOT, 'stylesheet.css'), 'utf8');

const ldf = require('../ai/liveDataFallback.js');
const convMod = require('../ai/conversationState.js');

test('live-data fallback: weather fetch returns structured snapshot + sources', () => {
    const inst = ldf.createLiveDataFallback({
        httpGet: (url, cancellable, cb) => {
            if (url.indexOf('geocoding-api') !== -1) {
                cb(null, JSON.stringify({ results: [{ name: 'Bandung', country: 'Indonesia', latitude: -6.9, longitude: 107.6 }] }));
            } else {
                cb(null, JSON.stringify({
                    current: { temperature_2m: 23.4, relative_humidity_2m: 78, apparent_temperature: 25.1, precipitation: 0.2, weather_code: 61, wind_speed_10m: 9.2, wind_direction_10m: 135, wind_gusts_10m: 14.5 },
                    daily: {
                        time: ['2026-09-14', '2026-09-15', '2026-09-16'],
                        temperature_2m_max: [31, 30, 29],
                        temperature_2m_min: [22, 22, 21],
                        weather_code: [61, 80, 3],
                        precipitation_probability_max: [40, 70, 10],
                        sunrise: ['2026-09-14T05:58', '2026-09-15T05:58', '2026-09-16T05:59'],
                        sunset: ['2026-09-14T17:52', '2026-09-15T17:51', '2026-09-16T17:50']
                    }
                }));
            }
        }
    });
    return inst.fetch('cuaca di Bandung', null).then((r) => {
        assert.equal(r.domain, 'weather');
        assert.ok(Array.isArray(r.sources) && r.sources.length === 1, 'flat text source still present');
        const d = r.structured;
        assert.ok(d && d.kind === 'weather', 'structured snapshot rides along');
        assert.equal(d.place, 'Bandung');
        assert.equal(d.current.code, 61);
        assert.equal(d.current.temperature, 23.4);
        assert.equal(d.daily.length, 3);
        assert.equal(d.daily[0].max, 31);
        assert.equal(d.daily[2].code, 3);
        assert.equal(d.current.feelsLike, 25.1);
        assert.equal(d.current.windDir, 135);
        assert.equal(d.current.gusts, 14.5);
        assert.equal(d.daily[0].precipProb, 40);
        assert.equal(d.sunrise, '05:58');
        assert.equal(d.sunset, '17:52');
    });
});

test('live-data fallback: non-weather domains stay plain (no structured)', () => {
    const inst = ldf.createLiveDataFallback({
        httpGet: (url, cancellable, cb) => {
            cb(null, JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 4450, chartPreviousClose: 4400, currency: 'IDR', shortName: 'Bank BRI' } }] } }));
        }
    });
    return inst.fetch('saham BBRI', null).then((r) => {
        assert.equal(r.domain, 'stock');
        assert.ok(!r.structured, 'no card data for stock yet');
        assert.ok(r.sources.length >= 1);
    });
});

test('conversationState: completeAssistant persists meta.data as msg.data', () => {
    const conv = convMod.createConversation();
    const u = convMod.appendUser(conv, 'cuaca di Bandung');
    const aid = convMod.appendAssistant(conv);
    const card = { kind: 'weather', place: 'Bandung', current: { temperature: 23 } };
    assert.ok(convMod.completeAssistant(conv, aid, 'jawaban', [], { data: card }), 'complete succeeds');
    const m = convMod.findMessage(conv, aid);
    assert.ok(m.data && m.data.kind === 'weather', 'structured card persisted on the message');
    assert.equal(m.data.place, 'Bandung');
    void u;
});

test('applet: weather card renderer + sparkline + WMO icon mapping exist', () => {
    assert.ok(APPLET_SRC.includes('_buildWeatherCard(data)'), 'card renderer present');
    assert.ok(APPLET_SRC.includes('_buildSparkline(series, w, h)'), 'sparkline builder present');
    assert.ok(APPLET_SRC.includes('_wmoIconName(code)'), 'WMO icon mapper present');
    assert.ok(APPLET_SRC.includes('weather-clear-symbolic') && APPLET_SRC.includes('weather-storm-symbolic'), 'symbolic icon names mapped');
    assert.ok(APPLET_SRC.includes('quicksearch-ai-weather-spark-col') && APPLET_SRC.includes('St.Bin'), 'sparkline: pure-CSS bars (St widgets only)');
    assert.ok(APPLET_SRC.includes('_windDirName(deg)'), 'wind compass mapper present');
    assert.ok(APPLET_SRC.includes('precipProb') && APPLET_SRC.includes('sunrise'), 'card renders rain chance + sun times');
    assert.ok(!APPLET_SRC.includes('$dispose'), 'no $dispose anywhere: boxed ownership games SIGSEGV/SIGABRT Cinnamon at GC');
    assert.ok(!APPLET_SRC.includes('get_context') && !APPLET_SRC.includes('DrawingArea'), 'no cairo drawing surface in applet');
    // card renders ABOVE the answer text inside the answer actor
    const idx = APPLET_SRC.indexOf('_buildAiAnswerActor(content, structuredData)');
    assert.ok(idx !== -1, 'answer actor accepts structured data');
    const section = APPLET_SRC.slice(idx, idx + 2600);
    assert.ok(section.indexOf('_buildWeatherCard') !== -1 && section.indexOf('_buildWeatherCard') < APPLET_SRC.indexOf('parseMarkdownBlocks', idx), 'card added before markdown blocks');
    assert.ok(APPLET_SRC.includes('this._buildAiAnswerActor(String(msg.content || \'\'), msg.data)'), 'render paths pass msg.data');
});

test('applet: engine payload data is persisted through onComplete/onAnswer/onDone', () => {
    assert.ok(APPLET_SRC.includes('meta.data = data.data'), 'stream onComplete carries data');
    assert.ok(APPLET_SRC.includes('meta2.data = data.data'), 'non-stream onDone carries data');
    assert.ok(ENGINE_SRC.includes('payload.data = structuredData'), 'engine _deliverAnswer attaches data');
    assert.ok(ENGINE_SRC.includes('_consumeStructuredData()'), 'structured snapshot consumed once per delivery');
});

test('prompt + css: card mention hint and card styles', () => {
    assert.ok(PROMPT_SRC.includes('visual data card'), 'AI hints the visual card at answer end');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-weather {'), 'card surface styled');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-weather-temp'), 'big temp styled');
    assert.ok(CSS_SRC.includes('.quicksearch-ai-weather-days'), '3-day strip styled');
});

test('engine: weather snapshot is pre-fetched in parallel, not only on web-search outage', () => {
    // 2026-09-14 fix: the card used to appear ONLY when web search failed, so a successful
    // SearXNG search answered text-only. Both entry points must now pre-fetch + reset.
    const hooks = ENGINE_SRC.split('_prefetchStructuredData(q, myCancellable)').length - 1;
    assert.strictEqual(hooks, 2, 'pre-fetch hooked in search() AND searchStream()');
    // 4 = 2 per-request hooks + 1 declaration + 1 inside _consumeStructuredData (consume-once)
    assert.strictEqual(ENGINE_SRC.split('_lastStructuredData = null;').length - 1, 4, 'stale snapshot reset per request + consume-once intact');
    assert.ok(ENGINE_SRC.includes("if (domain !== 'weather') return;"), 'pre-fetch only for weather queries');
    assert.ok(ENGINE_SRC.includes('myPrefetchGen !== gen'), 'stale pre-fetch cannot clobber a newer request');
    assert.ok(ENGINE_SRC.includes('deps.liveDataFallback === false') &&
        ENGINE_SRC.indexOf('deps.liveDataFallback === false') < ENGINE_SRC.indexOf('function _consumeStructuredData'), 'kill-switch honored by pre-fetch');
});

test('live-data fallback: single shared HTTP transport (no second Soup stack)', () => {
    // 2026-09-14: transport Soup ganda di liveDataFallback bikin GBytes crash GC Cinnamon
    // (core 3x: BoxedInstanceD2Ev/g_bytes_unref). Kartu cuaca sekarang pakai SATU transport
    // terbukti (webSearchTool.defaultHttpGet, disalurkan factory -> engine liveDataHttpGet).
    const WST_SRC = fs.readFileSync(path.join(ROOT, 'ai/webSearchTool.js'), 'utf8');
    const FACT_SRC = fs.readFileSync(path.join(ROOT, 'ai/aiFactory.js'), 'utf8');
    assert.ok(!LDF_SRC.includes('_createGjsHttpGet'), 'no second Soup transport in liveDataFallback');
    assert.ok(!LDF_SRC.includes("require('gi.Soup')"), 'no direct Soup import in liveDataFallback');
    assert.ok(WST_SRC.includes('defaultHttpGet'), 'proven GET exported from webSearchTool');
    assert.ok(FACT_SRC.includes('engineOpts.liveDataHttpGet'), 'factory wires liveDataHttpGet into engine');
    assert.ok(ENGINE_SRC.includes('deps.liveDataHttpGet'), 'engine forwards liveDataHttpGet to liveDataFallback');
    // behavioral: injected httpGet still serves the structured snapshot (mocked, offline-safe)
    const inst = ldf.createLiveDataFallback({
        httpGet: (url, canc, cb) => {
            if (url.indexOf('geocoding-api') !== -1) {
                cb(null, JSON.stringify({ results: [{ name: 'Bandung', country: 'Indonesia', latitude: -6.9, longitude: 107.6 }] }));
            } else {
                cb(null, JSON.stringify({
                    current: { temperature_2m: 23.4, relative_humidity_2m: 78, apparent_temperature: 25.1, precipitation: 0, weather_code: 61, wind_speed_10m: 9.2, wind_direction_10m: 90, wind_gusts_10m: 12 },
                    daily: { time: ['2026-09-14'], temperature_2m_max: [31], temperature_2m_min: [22], weather_code: [61], precipitation_probability_max: [20], sunrise: ['2026-09-14T05:58'], sunset: ['2026-09-14T17:52'] }
                }));
            }
        }
    });
    return inst.fetch('cuaca di Bandung', null).then((r) => {
        assert.ok(r && r.structured && r.structured.kind === 'weather', 'structured snapshot via injected transport');
        assert.equal(r.structured.current.feelsLike, 25.1, 'feels-like rides along');
        assert.equal(r.structured.daily[0].precipProb, 20, 'daily rain chance rides along');
    });
});

test('crash 2026-09-15: one weather fetch per query + crash-safe Soup transport', () => {
    const WST_SRC = fs.readFileSync(path.join(ROOT, 'ai/webSearchTool.js'), 'utf8');
    assert.ok(WST_SRC.includes('soupTextReader'), 'GET + POST read via boxed-free reader (no GBytes on JS heap)');
    assert.ok(!WST_SRC.includes('.get_data()'), 'no raw get_data() decode left (GET or POST)');
    assert.ok(WST_SRC.includes('finishOnce'), 'late Soup callbacks ignored after timeout (no piled-up decodes)');
    assert.ok(WST_SRC.includes('web search timeout'), 'Soup GET has its own abort timeout (no orphan request past live-data deadline)');
    assert.ok(ENGINE_SRC.includes('_weatherPrefetch'), 'prefetch promise shared with fallback');
    assert.ok(ENGINE_SRC.includes('Reuse the in-flight/settled prefetch'), 'fallback reuses prefetch instead of second Open-Meteo storm');
    assert.ok(!LDF_SRC.includes("then(() => { throw new Error('unused'); })"), 'news feed single request (no fetch-then-refetch double)');
});

test('card 2026-09-15: typo uaca still resolves weather + success path waits for card', () => {
    const inst = ldf.createLiveDataFallback({
        httpGet: (url, canc, cb) => {
            if (url.indexOf('geocoding-api') !== -1) {
                cb(null, JSON.stringify({ results: [{ name: 'Ponorogo', country: 'Indonesia', latitude: -7.87, longitude: 111.47 }] }));
            } else {
                cb(null, JSON.stringify({
                    current: { temperature_2m: 24, relative_humidity_2m: 70, apparent_temperature: 26, precipitation: 0, weather_code: 2, wind_speed_10m: 8, wind_direction_10m: 90, wind_gusts_10m: 12 },
                    daily: { time: ['2026-09-15'], temperature_2m_max: [32], temperature_2m_min: [18], weather_code: [2], precipitation_probability_max: [10], sunrise: ['2026-09-15T05:30'], sunset: ['2026-09-15T17:40'] }
                }));
            }
        }
    });
    assert.equal(inst.detectDomain('uaca di ponorogo'), 'weather', 'typo uaca detected as weather');
    return inst.fetch('uaca di ponorogo', null).then((r) => {
        assert.equal(r.domain, 'weather', 'typo query fetches weather');
        assert.equal(r.structured.place, 'Ponorogo', 'place extracted despite typo');
    }).then(() => {
        assert.ok(ENGINE_SRC.includes('CARD_WAIT_MS'), 'bounded card wait defined');
        assert.ok(ENGINE_SRC.includes('_whenCardReady'), 'card readiness gate present');
        assert.ok(ENGINE_SRC.includes('queryForCard'), 'non-stream delivery takes card query');
        assert.ok(ENGINE_SRC.includes('_metaOf(res2), q)'), 'success paths pass query to card gate');
        assert.ok(ENGINE_SRC.includes('return _whenCardReady(q, () => {'), 'stream onComplete gated on prefetch');
    });
});

test('crash 2026-09-15 SEGV: message-level GBytes reads eliminated (BoxedInstanceD2Ev)', () => {
    const WST = fs.readFileSync(path.join(ROOT, 'ai/webSearchTool.js'), 'utf8');
    const EXP = fs.readFileSync(path.join(ROOT, 'ai/sourceContentExpander.js'), 'utf8');
    const NINE = fs.readFileSync(path.join(ROOT, 'ai/nineRouterProvider.js'), 'utf8');
    assert.ok(!WST.includes('.send_and_read_finish('), 'webSearchTool: no message-level GBytes finish');
    assert.ok(!WST.includes('.get_data()'), 'webSearchTool: no GBytes decode');
    assert.ok(!EXP.includes('.send_and_read_finish('), 'expander: no message-level GBytes finish');
    assert.ok(!EXP.includes('.get_data()'), 'expander: no GBytes decode');
    assert.ok(!NINE.includes('.send_and_read_finish('), 'nineRouter: no message-level GBytes finish (non-stream + fallback)');
    for (const [name, src] of [['webSearchTool', WST], ['expander', EXP], ['nineRouter', NINE]]) {
        assert.ok(src.includes('soupTextReader'), name + ': wired to boxed-free reader');
    }
});

test('crash 2026-09-15 SEGV (11:02/11:19 cores): boxed GLib.Bytes request bodies eliminated', () => {
    // The 2026-09-15 morning fix removed boxed GBytes on the RESPONSE side but left
    // set_request_body_from_bytes(GLib.Bytes...) fallbacks on the REQUEST side. The LLM
    // POST rides that path on EVERY AI query (weather included): finalizing the boxed
    // proxy SEGVs Cinnamon at GC (BoxedInstanceD2Ev -> g_mutex_lock). Transports must now
    // use the shared boxed-free helper and abort the request when it fails.
    const WST = fs.readFileSync(path.join(ROOT, 'ai/webSearchTool.js'), 'utf8');
    const NINE = fs.readFileSync(path.join(ROOT, 'ai/nineRouterProvider.js'), 'utf8');
    const WP = fs.readFileSync(path.join(ROOT, 'providers/webProvider.js'), 'utf8');
    const reader = require('../ai/soupTextReader.js');
    assert.equal(typeof reader.setSoupRequestBodyFromText, 'function', 'shared boxed-free request-body helper exported');
    for (const [name, src] of [['webSearchTool', WST], ['nineRouter', NINE], ['webProvider', WP]]) {
        assert.ok(!src.includes('GLib.Bytes.new('), name + ': no boxed GLib.Bytes.new');
        assert.ok(!src.includes('new GLib.Bytes('), name + ': no boxed GLib.Bytes constructor');
        assert.ok(!src.includes("new (require('gi.GLib').Bytes)("), name + ': no inline gi.GLib Bytes constructor');
        assert.ok(src.includes("soupTextReader.setSoupRequestBodyFromText"), name + ': request bodies go through the boxed-free helper');
    }
    // helper honors the contract on a mocked Gio (node-safe): file body + set_request_body(stream)
    const calls = { replace: 0, read: 0, set: 0, del: 0, cleanupScheduled: false };
    const fakeStream = { close: () => {} };
    const fakeFile = {
        replace_contents: (bytes) => { calls.replace++; assert.ok(bytes && bytes.length > 0, 'body bytes written'); return [true]; },
        read: () => { calls.read++; return fakeStream; },
        delete: () => { calls.del++; }
    };
    const fakeGio = {
        File: { new_for_path: () => fakeFile },
        FileCreateFlags: { REPLACE_DESTINATION: 0 }
    };
    const fakeGLib = { PRIORITY_DEFAULT: 0, timeout_add: () => { calls.cleanupScheduled = true; return 1; }, SOURCE_REMOVE: false };
    const fakeMsg = { set_request_body: (ct, stream, len) => { calls.set++; assert.equal(ct, 'application/json'); assert.equal(stream, fakeStream); assert.equal(len, Buffer.byteLength('{"q":"cuaca"}')); } };
    assert.equal(reader.setSoupRequestBodyFromText({ GLib: fakeGLib, Gio: fakeGio }, fakeMsg, 'application/json', '{"q":"cuaca"}'), true, 'boxed-free body set');
    assert.equal(calls.cleanupScheduled, true, 'body stream cleanup scheduled (no Bytes anywhere)');
    // missing Gio -> false (caller aborts), never a Bytes fallback
    assert.equal(reader.setSoupRequestBodyFromText({ GLib: null, Gio: null }, fakeMsg, 'application/json', 'x'), false, 'no Gio -> false');
});

test('crash 2026-09-15 SEGV (22:14 core): boxed response-side proxies eliminated (headers + uri)', () => {
    // The 22:14 SIGSEGV (BoxedInstanceD2Ev inside JS_GC -> trigger_gc_if_needed, Cinnamon
    // full crash during streaming) proved boxed proxies were STILL being created on the
    // Soup response path: get_response_headers() (Soup.MessageHeaders) and msg.get_uri()
    // (GLib.Uri) materialize boxed proxies on the JS heap; GC finalizing them SEGVs
    // Cinnamon. Response-side reads are now plain-JS only (mock header objects), and
    // finalUrl falls back to the request url.
    const WST = fs.readFileSync(path.join(ROOT, 'ai/webSearchTool.js'), 'utf8');
    const SCE = fs.readFileSync(path.join(ROOT, 'ai/sourceContentExpander.js'), 'utf8');
    assert.ok(!WST.includes('msg.get_response_headers'), 'webSearchTool: no boxed get_response_headers()');
    assert.ok(!SCE.includes('msg.get_response_headers'), 'sourceContentExpander: no boxed get_response_headers()');
    assert.ok(!SCE.includes('msg.get_uri()'), 'sourceContentExpander: no boxed get_uri() (GLib.Uri proxy)');
    // plain-JS header objects (node/test mock path) stay supported
    assert.ok(WST.includes('msg.response_headers.get_one'), 'webSearchTool: plain-JS response_headers honored');
    assert.ok(SCE.includes('msg.response_headers.get_one'), 'sourceContentExpander: plain-JS response_headers honored');
});

test('soupTextReader: contract on mocked Soup/Gio (node-safe)', () => {
    const reader = require('../ai/soupTextReader.js');
    assert.equal(typeof reader.readSoupMessageText, 'function', 'exports reader');
    const lines = ['{"a":1}', '{"b":2}'];
    const fakeStream = { close_async: () => {} };
    const fakeDis = {
        read_line_async: (prio, canc, cb) => {
            const line = lines.length ? lines.shift() : null;
            setImmediate(() => cb(fakeDis, {}));
            fakeDis.__line = line;
        },
        read_line_finish_utf8: () => [fakeDis.__line],
    };
    const fakeGio = { DataInputStream: function () { return fakeDis; } };
    const fakeSess = { send_finish: () => fakeStream };
    const fakeSession = { send_async: (msg, prio, canc, cb) => setImmediate(() => cb(fakeSess, {})) };
    return new Promise((resolve, reject) => {
        reader.readSoupMessageText({ GLib: { PRIORITY_DEFAULT: 0 }, Gio: fakeGio }, fakeSession, {}, null, (err, text) => {
            try {
                assert.ifError(err);
                assert.equal(text, '{"a":1}\n{"b":2}', 'lines joined without GBytes');
                // error path: send_finish throws -> single error callback
                const badSession = { send_async: (m, p, c, cb2) => setImmediate(() => cb2({ send_finish: () => { throw new Error('boom'); } }, {})) };
                let calls = 0;
                reader.readSoupMessageText({ GLib: { PRIORITY_DEFAULT: 0 }, Gio: fakeGio }, badSession, {}, null, (e2) => {
                    calls++;
                    assert.ok(e2, 'error surfaces');
                    assert.equal(calls, 1, 'exactly-once callback');
                    resolve();
                });
            } catch (e) { reject(e); }
        });
    });
});
