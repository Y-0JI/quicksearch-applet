// Phase 8 default tools: THIN adapters over existing providers — zero
// duplicated provider logic (roadmap Phase 8 guardrail #1). Pure CJS:
// every platform effect (providers, openUri, openPath, timers) is injected,
// so node --test runs with plain JS fakes. No screen/computer-control here
// beyond get_screen's adapter (Phase 10/11). No shell anywhere.
//
// LOADER INVARIANT: files under providers/ must NEVER use '../' requires —
// Cinnamon's zena loader strips './' sequences anywhere in a path
// (fileUtils.js), turning '../x.js' into '.x.js' and killing the whole
// applet import. Cross-file constants/helpers arrive via injection instead
// (same pattern as every other provider module).
const FALLBACK_LIMITS = { webGraceMs: 2500, maxListItems: 10 };

function createDefaultTools(deps) {
    const d = deps || {};
    const timers = d.timers || { after: () => 0, clear: () => {} };
    const LIMITS = d.LIMITS || FALLBACK_LIMITS;
    const V = d.validators || {};

    return [
        {   // CalculatorProvider.tryCalculate (sync, whitelist parser, no eval)
            id: 'calculator', name: 'Calculator', riskLevel: 'LOW',
            description: 'Evaluate arithmetic: + - * / % ^ sqrt abs round floor ceil.',
            inputSchema: { type: 'object',
                properties: { expression: { type: 'string' } }, required: ['expression'] },
            execute(args, ctx, cb) {
                const r = d.tryCalculate ? d.tryCalculate(String(args.expression)) : null;
                if (!r) { cb({ error: 'invalid-expression' }); return; }
                cb(null, { expression: r.expression, value: r.value });
            }
        },
        {   // FileProvider.search (async, cancellable owned by caller)
            id: 'search_files', name: 'Search Files', riskLevel: 'LOW',
            description: 'Find files by name substring. Returns matching paths.',
            inputSchema: { type: 'object',
                properties: { query: { type: 'string' } }, required: ['query'] },
            execute(args, ctx, cb) {
                if (!d.fileProvider) { cb({ error: 'unavailable', message: 'file search disabled' }); return; }
                d.fileProvider.search(String(args.query), ctx.cancellable || null, results => {
                    const files = (results || []).map(r => ({ title: r.title, path: r.path }));
                    cb(null, { query: String(args.query), count: files.length, files: files });
                });
            }
        },
        {   // WebProvider.search delivers twice BY DESIGN: instant fallback, then
            // upgraded instant answers. Finish early on 2nd delivery, else after
            // LIMITS.webGraceMs grace timer (injectable for tests).
            //
            // Phase 14 latency fix: in agent mode, skip the instant fallback
            // entirely — the AI synthesizes faster when it never sees the
            // useless 'Search the web for …' placeholder.  A settle timer
            // guarantees the tool still resolves (with fallback) if the
            // backend is unreachable.
            id: 'search_web', name: 'Search Web', riskLevel: 'LOW',
            description: 'Web search returning result titles, URLs and summaries.',
            inputSchema: { type: 'object',
                properties: { query: { type: 'string' } }, required: ['query'] },
            execute(args, ctx, cb) {
                if (!d.webProvider) { cb({ error: 'unavailable', message: 'web search disabled' }); return; }
                const isAgent = !!(ctx && ctx.agent);
                let settled = false, timerId = 0, settleTimerId = 0;
                // Phase 13: agent grace window (reduced to 400ms in Phase 14)
                const graceMs = (ctx && typeof ctx.webGraceMs === 'number') ? ctx.webGraceMs : LIMITS.webGraceMs;
                const isCancelled = () => !!(ctx && ctx.cancellable && ctx.cancellable.is_cancelled && ctx.cancellable.is_cancelled());
                const finish = list => {
                    if (settled) return;
                    if (isCancelled()) {
                        settled = true;
                        timers.clear(timerId);
                        timers.clear(settleTimerId);
                        return;
                    }
                    settled = true;
                    timers.clear(timerId);
                    timers.clear(settleTimerId);
                    const results = (list || []).filter(r => r && r.url)
                        .map(r => ({ title: r.title, url: r.url, summary: r.description || '' }));
                    cb(null, { query: String(args.query), count: results.length, results: results });
                };
                // Phase 14: deliver the fallback list (or empty) for SEARCH mode,
                // but skip it in agent mode so the AI never processes a useless
                // placeholder — it goes straight to real results.
                const deliverOrWait = list => {
                    if (isCancelled()) return;
                    if (isAgent) return; // agent: wait for real results only
                    finish(list);       // SEARCH mode: instant fallback
                };
                let first = true;
                let firstList = null;
                // 5 000 ms > webProvider 4000 ms timeout so provider has time
                // to deliver proper error fallback before settle fires
                settleTimerId = timers.after(isAgent ? 5000 : LIMITS.webGraceMs, () => {
                    if (!settled) {
                        if (isAgent && firstList) finish(firstList);
                        else finish(isAgent ? [] : undefined);
                    }
                });
                const opts = isAgent ? { agent: true } : undefined;
                d.webProvider.search(String(args.query), ctx.cancellable || null, list => {
                    if (isCancelled()) return;
                    if (first) {
                        first = false;
                        firstList = list;
                        timerId = timers.after(graceMs, () => deliverOrWait(list));
                    } else {
                        finish(list); // upgraded answers arrived: done early
                    }
                }, opts);
            }
        },
        {   // URLProvider.detectUrl gates schemes strictly (http/https/bare domain
            // only) -> javascript:, file:, data: are structurally impossible.
            id: 'open_url', name: 'Open URL', riskLevel: 'LOW',
            description: 'Open an http(s) URL in the default browser.',
            inputSchema: { type: 'object',
                properties: { url: { type: 'string' } }, required: ['url'] },
            execute(args, ctx, cb) {
                const url = d.detectUrl ? d.detectUrl(String(args.url)) : null;
                if (!url) { cb({ error: 'invalid-url' }); return; }
                if (typeof d.openUri !== 'function') { cb({ error: 'open-url-unavailable' }); return; }
                const ok = d.openUri(url);
                if (!ok) { cb({ error: 'open-url-failed', url: url }); return; }
                cb(null, { opened: url });
            }
        },
        {   // Native opener shared with file results (Gio.AppInfo
            // launch_default_for_uri_async after existence check). No shell.
            id: 'open_file', name: 'Open File', riskLevel: 'MEDIUM',
            description: 'Open a local file path with its default application.',
            inputSchema: { type: 'object',
                properties: { path: { type: 'string' } }, required: ['path'] },
            execute(args, ctx, cb) {
                if (!d.openPath) { cb({ error: 'unavailable' }); return; }
                const p = String(args.path).replace(/\/+$/, '') || '/';
                const ok = d.openPath(p);
                if (!ok) { cb({ error: 'file-not-found', path: p }); return; }
                cb(null, { opened: p });
            }
        },
        {   // AppSystem lookup via existing index; launches through the SAME
            // action closure used by SEARCH rows (open_new_window on the matched
            // desktop entry). Raw names/executables can never be executed.
            id: 'launch_app', name: 'Launch App', riskLevel: 'MEDIUM',
            description: 'Launch an installed application by name.',
            inputSchema: { type: 'object',
                properties: { app: { type: 'string' } }, required: ['app'] },
            execute(args, ctx, cb) {
                if (!d.appProvider) { cb({ error: 'unavailable' }); return; }
                const hits = d.appProvider.searchApps(String(args.app), 1) || [];
                if (!hits.length) { cb({ error: 'app-not-found', app: String(args.app) }); return; }
                hits[0].action();
                cb(null, { launched: hits[0].title, appId: hits[0].appId });
            }
        },
        {   // Phase 10 screen awareness. On-demand ONLY (no timers/listeners);
            // transient capture (temp file deleted right after read); the
            // vision gate fires BEFORE any pixels are taken so a text-only
            // model never triggers a screenshot. No computer control here.
            id: 'get_screen', name: 'Get Screen', riskLevel: 'LOW',
            description: 'Take one on-demand screenshot of the current screen for visual analysis.',
            inputSchema: { type: 'object', properties: {}, required: [] },
            execute(args, ctx, cb) {
                if (!(ctx && ctx.capabilities && ctx.capabilities.vision)) {
                    cb({ error: 'vision-not-supported' });
                    return;
                }
                if (!d.screenCapture) { cb({ error: 'unavailable' }); return; }
                d.screenCapture.capture(ctx.cancellable || null, (err, dataUrl) => {
                    cb(err || null, err ? null : { image: dataUrl });
                });
            }
        },
        {   // Phase 11 computer control. Every action is an explicit tool with
            // total pre-validation (bounds / whitelist / caps) BEFORE any
            // system effect; the backend injects events natively or via a
            // fixed-argv helper — never a shell, never model-chosen commands.
            id: 'focus_app', name: 'Focus App', riskLevel: 'MEDIUM',
            description: 'Bring an installed application window to the front (or start it if closed).',
            inputSchema: { type: 'object',
                properties: { app: { type: 'string' } }, required: ['app'] },
            execute(args, ctx, cb) {
                if (!d.computerControl) { cb({ error: 'unavailable' }); return; }
                d.computerControl.focusApp(String(args.app), ctx.cancellable || null,
                    (err, res) => {
                        if (err) { cb(err); return; }
                        if (!res || !res.focused) { cb({ error: 'app-not-found', app: String(args.app) }); return; }
                        cb(null, { focused: true, app: res.app });
                    });
            }
        },
        {
            id: 'click', name: 'Click', riskLevel: 'MEDIUM',
            description: 'Click at screen coordinates. Coordinates must be integers inside the current screen bounds.',
            inputSchema: { type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' },
                              button: { type: 'string' } },
                required: ['x', 'y'] },
            execute(args, ctx, cb) {
                const button = args.button === undefined ? 'left' : String(args.button);
                if (['left', 'right', 'middle'].indexOf(button) === -1) {
                    cb({ error: 'invalid-button' }); return;
                }
                const err = V.validatePoint(args.x, args.y,
                    d.getScreenBounds ? d.getScreenBounds() : [0, 0]);
                if (err) { cb(err); return; }
                if (!d.computerControl) { cb({ error: 'unavailable' }); return; }
                d.computerControl.click(args.x, args.y, button, ctx.cancellable || null,
                    e => cb(e || null, e ? null : { clicked: true, x: args.x, y: args.y, button: button }));
            }
        },
        {
            id: 'type_text', name: 'Type Text', riskLevel: 'MEDIUM',
            description: 'Type literal text into the focused window (max 500 chars).',
            inputSchema: { type: 'object',
                properties: { text: { type: 'string' } }, required: ['text'] },
            execute(args, ctx, cb) {
                const text = V.sanitizeText(String(args.text == null ? '' : args.text));
                if (!text) { cb({ error: 'invalid-text' }); return; }
                if (!d.computerControl) { cb({ error: 'unavailable' }); return; }
                d.computerControl.typeText(text, ctx.cancellable || null,
                    e => cb(e || null, e ? null : { typed: text }));
            }
        },
        {
            id: 'press_key', name: 'Press Key', riskLevel: 'MEDIUM',
            description: 'Press one whitelisted key (Return, Escape, Tab, BackSpace, Delete, arrows, Home/End/PageUp/PageDown, Space, F1-F12). No modifier combos.',
            inputSchema: { type: 'object',
                properties: { key: { type: 'string' } }, required: ['key'] },
            execute(args, ctx, cb) {
                const key = String(args.key == null ? '' : args.key);
                const kErr = V.validateKey(key);
                if (kErr) { cb({ error: kErr }); return; }
                if (!d.computerControl) { cb({ error: 'unavailable' }); return; }
                d.computerControl.pressKey(key, ctx.cancellable || null,
                    e => cb(e || null, e ? null : { pressed: key }));
            }
        },
        {
            id: 'scroll', name: 'Scroll', riskLevel: 'MEDIUM',
            description: 'Scroll the view under the pointer: direction up|down, amount 1..10 wheel steps.',
            inputSchema: { type: 'object',
                properties: { direction: { type: 'string' }, amount: { type: 'number' } },
                required: ['direction'] },
            execute(args, ctx, cb) {
                const v = V.validateScroll(args);
                if (v.error) { cb(v); return; }
                if (!d.computerControl) { cb({ error: 'unavailable' }); return; }
                d.computerControl.scroll(v.direction, v.amount, ctx.cancellable || null,
                    e => cb(e || null, e ? null : { scrolled: v.direction, amount: v.amount }));
            }
        }
    ];
}

module.exports = { createDefaultTools };
