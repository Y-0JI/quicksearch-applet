# QuickSearch Cinnamon Applet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Native Cinnamon 6.x search applet: satu search box center-screen, providers Apps/Files/Web/Calc/URL, async total, ranking sederhana.

**Architecture:** Applet shell (ModalDialog overlay) → SearchEngine (debounce → classify → dispatch per-provider dengan generation+cancellation → partial results ASAP) → Result pipeline (normalize/dedupe/rank/limit) → render sections.

**Tech Stack:** GJS legacy imports (mozjs-115), Gio.Subprocess async, Soup 3.0, St/Clutter, node --test untuk modul pure.

## Global Constraints

- Native saja: Cinnamon/GJS/GIO/GLib/St/Soup. Tanpa Node/Python/Electron di runtime.
- Semua blocking ops async (`communicate_utf8_async`, `send_and_read_async`).
- Subprocess argv array selalu; query untrusted; URL pakai encodeURIComponent.
- Debounce default 150ms; generation ID + cancel cancellable lama tiap query baru.
- Limits: apps 5 / files 15 / web 5; file scope default $HOME.
- Tanpa eval bebas; tanpa indexer/database/crawler sendiri.
- Cleanup total di `on_applet_removed_from_panel()` dan saat overlay close.

## Guardrails Wajib (user-approved amendments)

1. `find` fallback: JANGAN andalkan `-quit`; limit diterapkan provider setelah membaca output subprocess.
2. SearchEngine: TIDAK ADA pending counter palsu. Tiap provider selesai → render langsung jika generation masih valid (partial results ASAP).
3. Gio.Cancellable: tiap query baru → cancel lama → buat cancellable BARU yang dipakai konsisten oleh file+web (tidak pernah null/lama karena provider disabled).
4. File backend argv WAJIB diverifikasi aktual per-tool (plocate ≠ locate ≠ find), bukan diasumsikan sama.

## Environment Facts (terverifikasi 2026-08-23)

- Cinnamon 6.6.9+zena, mozjs-115, legacy imports style.
- ModalDialog center-screen built-in (`imports.ui.modalDialog`).
- `Main.keybindingsManager.addHotKey/removeHotKey`.
- Async subprocess pola: `/usr/share/cinnamon/js/misc/util.js:229`.
- Soup-3.0.typelib tersedia; plocate+locate+find terinstall.
- Node v24 untuk unit test modul pure; tidak ada gjs standalone.
- Dual-env pattern: file pure + `if (typeof module !== 'undefined') module.exports`.

## Tasks

### Task 1 — Applet shell + overlay
Files: metadata.json, applet.js, stylesheet.css, .gitignore.
Steps: git init → metadata/css/js skeleton → reload cinnamon (`cinnamon --replace & disown`) → cek ~/.xsession-errors bersih → manual test klik/Esc/focus → commit.

### Task 2 — Calculator provider (TDD)
Files: providers/calculatorProvider.js, tests/calculator.test.mjs.
Interface: `tryCalculate(q)` → null | {expression, value}.
Tokenizer whitelist `[0-9+\-*/().% ]` + recursive descent. Tanpa eval. Div/0 → null.
Test: aritmatika dasar, preseden, float, unary minus, reject injeksi/huruf.

### Task 3 — URL provider (TDD)
Files: providers/urlProvider.js, tests/url.test.mjs.
Interface: `detectUrl(q)` → null | urlFinal. Regex ketat, spasi = bukan URL, auto https://.

### Task 4 — Result layer (TDD)
Files: result.js, tests/result.test.mjs.
Interfaces: classifyQuery, makeResult, dedupe(id stabil), scoreResult(tiered 400..50), processResults(lists,limits).
Score tiers: calc/url 400 > app exact 300/prefix 250/contains 200/keyword 150 > file 180/160/120 > web instant 90/fallback 50.

### Task 5 — App provider
Files: providers/appProvider.js.
`getAppsIndex()` sekali + refresh installed-changed; `searchApps(query, limit=5)` sync.
API: `Cinnamon.AppSystem.get_default().get_all(false)`, keywords via `Gio.DesktopAppInfo.new(app.get_id()).get_keywords()`, gicon via `.get_icon()`, launch `app.open_new_window(-1)` try/catch.

### Task 6 — File provider (guardrail 1,3,4)
Files: utils.js (pure pickFileBackend), providers/fileProvider.js, tests/filebackend.test.mjs.
- Verifikasi argv AKTUAL plocate/locate/find sebelum implement (guardrail 4).
- Backend detection sekali via GLib.find_program_in_path, cache.
- Async communicate_utf8_async; timeout find 3s; limit hasil diterapkan reader (bukan -quit) (guardrail 1).
- Cache Map max 50 FIFO key `query|location|backend`.
- Validasi path ada sebelum launch; launch via launch_default_for_uri_async.

### Task 7 — Web provider + engine + UI + keyboard (guardrail 2)
Files: providers/webProvider.js, searchEngine.js, applet.js modify.
Web: fallback entry SELALU instan; upgrade DDG instant answers via Soup3 send_and_read_async, timeout 4s, gagal = diam.
Engine: class SearchEngine{query(text,onResults),cancel(),destroy()}; debounce timeout_add; gen++ per query; cancellable baru per query dipakai file+web (guardrail 3); per-provider try/catch; cb hanya jika gen valid.
UI: sections APPLICATIONS/FILES/WEB, baris button(icon+title+desc), ↑↓ Enter Esc, klik, recent searches 15 via settings.

### Task 8 — Settings schema
Files: settings-schema.json, applet.js wiring.
Keys: open-shortcut keybinding <Super>space, enable-web/files switch, search-engine combobox, file-locations list, limits spinbutton 5/15/5, debounce-ms 150, show-recent, recent-queries hidden.

### Task 9 — Reliability pass
Matrix §28: race ketik cepat, cancellation ps-check, provider failure (tanpa plocate/locate, offline web), missing file, duplikat, remove applet bersih, open/close 10×, empty query, long/special chars, install/reload lifecycle. node --test semua PASS. Checklist DoD §32.

## Definition of Done
Sesuai spec §32 — semua item dicentang dengan bukti.
