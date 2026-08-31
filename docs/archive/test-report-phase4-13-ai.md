# Archive — Phase 4-13 AI Journal (removed from test-report.md)

> Diarsip 2026-08-30 dari `docs/test-report.md`. Fitur AI sudah dihapus dari `main`; disimpan di sini agar tidak dikira masih ada saat rebuild. Jangan anggap sebagai fitur aktif.

## Phase 4 — ASK AI inline (multi-provider)

- Arsitektur: Applet → AIManager (satu-satunya entry point) → registry metadata (9router/openrouter/openai/custom) → engine OpenAI-compatible generik.
- Settings: ai-provider (combobox), ai-model, ai-endpoint, ai-api-key (key hanya di ~/.config/cinnamon/spices, di luar repo).
- Request shape terbukti: {model:"coba9router", messages:[user], stream:false, max_tokens:512} ke http://127.0.0.1:20128/v1/chat/completions.
- LIVE PASS: mode ASK AI + "jelaskan plocate dalam 2 kalimat" + Enter → "Thinking..." → jawaban bahasa Indonesia inline di panel utama; overlay tetap terbuka; scroll area existing dipakai.
- Error informatif: pesan error upstream 9Router ditampilkan sebagai detail setelah baris ramah (mis. HTTP 401 → "API key tidak valid." + detail router); konten kosong dengan finish_reason=length juga dilaporkan.
- Catatan model reasoning (hy3-free): sebagian token habis di fase reasoning; bila jawaban kosong, UI menampilkan penyebab finish_reason secara informatif.

### Perbaikan pasca-review Phase 4
- max_tokens tidak lagi hard-coded 512: default 2048, configurable via setting `ai-max-tokens` (spinbutton 256-16384) — reasoning combo membutuhkan lebih.
- finish_reason=length DENGAN konten -> tetap SUCCESS; hanya benar-benar kosong yang dilaporkan informatif (finish_reason ikut ditampilkan).
- recent-queries berubah type `generic` (storage internal, tidak dirender di Settings UI); persistence/history/suggestion tetap identik.
- LIVE PASS ulang 9Router Combo coba9router: pertanyaan pendek & panjang -> jawaban nyata inline (max tokens cukup untuk melewati fase reasoning), overlay tetap terbuka >12s setelah jawaban; Esc/outside/Super+F/search pass; 47/47 tests.

### Perbaikan BUG pasca-Phase 4
- Autocomplete height kini diukur dari konten aktual autoCompleteBox (bukan preferred ScrollView yang stale): 1 row -> 1 row + padding, dst; tidak ada sisa tinggi dari state sebelumnya.
- search-engine dinormalisasi (id + label legacy, case-insensitive); nilai invalid di-log warning dan dipersist sebagai 'ddgo'. Deteksi perubahan engine dilakukan lazily per keystroke karena setValue combobox tidak memicu bind callback di build Cinnamon ini.
- Web fallback description memakai label engine terpilih (DuckDuckGo/Google/Bing) — tidak ada lagi fallback diam-diam ke DDG; instant answers tetap eksklusif ddgo.

## Phase 4.5 — Conversational AI (Chat 2 Arah)
- ConversationManager pure (maxTurns=8 PASANGAN = maks 16 message context, FIFO trim); Thinking hanya loading UI, tidak masuk history.
- LIVE PASS 9Router Combo coba9router, 5 turn: BMRI → fundamental → dividend → risiko → kesimpulan; follow-up dijawab kontekstual ("fundamentalnya?" paham konteks BMRI). Entries menumpuk (2→10) tanpa menimpa; history 10 messages.
- Percakapan baru (tombol) mengosongkan history+UI; reopen overlay setelah clear tetap kosong; session-only sesuai spec.
- Error rollback: user turn ditarik dari history + bubble user dihapus.

## Phase 5 — Cancellation + Error Handling AI
- Engine: Gio.Cancellable internal per instance (opts.cancellable override untuk test); cancel() memutus HTTP nyata; 'cancelled' MENEMBUS stale-guard agar ConversationManager dapat rollback orphaned user turn.
- Timeout Soup dipetakan ke error 'timeout'; manager.cancel() delegasi + passthrough; applet: submit baru/close/switch mode memanggil cancel, callback 'cancelled' diabaikan UI secara diam-diam.
- Mapping baru: http-5xx -> "Server AI bermasalah. Coba lagi nanti."
- Tanpa retry. UX 4.6 dan ConversationManager tidak berubah perilaku.
- RUNTIME: race A-lambat/B-baru (hanya B, A dibatalkan+rollback), close mid-flight (rollback+sweep bubble), switch mode mid-flight (aman), stub timeout/429/500 inline masing-masing; SEARCH regression; reload bersih. 63/63 tests.

## Phase 6 — UX Integration (Lifecycle & Konsistensi)
- Audit read-only: query preservation SEARCH<->AI bolak-balik preserved; empty state compact 60px kedua mode; stale AI tidak bocor ke SEARCH; Up/Down aman di panel kosong; Tab toggle + highlight benar; focus per mode benar.
- Open/close x20: keybinding tetap 1, region children tetap 2, conversation/chat session-only utuh, tanpa leak.
- Remove/re-add applet (canonical enabled-applets path): remove -> instance UNLOADED, keybinding 0, tanpa JS error; re-add -> instance 99 ter-load ulang, keybinding 1 (tanpa duplikat), settings utuh (model coba9router, provider 9router), conversation session-only BENAR-BENAR hilang (in-memory), Super+F + kalkulator + AI stub langsung normal.
- Final clean reload: 63/63 tests, 0 error.

## Phase 7 — Final Verification (Definition of Done)
64/64 unit tests · node --check semua modul · reload Cinnamon bersih (0 error).

| DoD item | Status |
|---|---|
| Initial state hanya searchbox | PASS (pill 60px) |
| Empty state compact | PASS |
| SEARCH mode bekerja | PASS (apps/files/web/URL/calc/history/suggestions) |
| ASK AI mode tersedia | PASS |
| Mode switching | PASS (query preserved, panel swap bersih) |
| History icon | PASS (document-open-recent) |
| Suggestion icon | PASS (system-search) |
| History/suggestion dibedakan | PASS |
| Existing search provider | PASS |
| Calculator | PASS (10/2=5, 2+2=4) |
| AI result inline | PASS (live 9Router Combo) |
| AI request asynchronous | PASS (Soup async, UI tidak blok) |
| AI cancellation | PASS (close/switch/new-submit memutus HTTP) |
| Stale AI response dibuang | PASS (token guard + orphan heal) |
| Click outside menutup | PASS |
| Esc menutup | PASS |
| Super+F | PASS |
| Tidak ada API key di repository | PASS (git grep secret patterns bersih) |
| Full regression PASS | PASS (64/64) |

### Temuan & perbaikan selama Phase 7
- Orphaned user turn saat response tiba setelah close/supersede -> ConversationManager kini heal trailing user turn saat compose context (send & buildMessages); bubble Thinking lama ditandai "dibatalkan".
- Timeout live terverifikasi: "Socket I/O timed out" -> inline informatif.
- Catatan: jawaban AI 351-char muat di panel tanpa scroll; mekanisme scroll panel terverifikasi via SEARCH battery (upper 717 > page 420, widget sama).
- Security: tanpa shell-exec dari user input; key hanya di user config.

### Fitur tambahan: clickable links dalam jawaban AI
- utils.extractUrls: hanya http/https (javascript:/file:/data: tidak pernah dieksekusi), trailing punctuation di-strip, dedupe, order preserved. 6/6 tests.
- Render: teks jawaban tetap satu label wrap utuh (isi tidak diubah); setiap URL dirender sebagai St.Button link di bawah teks (style link biru, wrap untuk URL panjang); klik -> Gio.AppInfo.launch_default_for_uri_async (native, tanpa shell) — pola sama dengan action web results existing.
- LIVE: jawaban stub dengan URL Maps -> link button ter-render dengan URL lengkap; handler terhubung standar St.Button 'clicked'.
- Catatan env: delivery klik fisik xtest tidak konsisten di sesi verifikasi ini (mempengaruhi semua tombol termasuk lightbox), sehingga handler diverifikasi via emit + direct method call; mekanisme klik identik dengan tombol lain yang sudah dipakai user.

## Phase 8 — Tool System / ToolRegistry

Fondasi tool system (registry generik + 6 tool adapter) tanpa menyentuh SEARCH/AI yang stabil. ToolRegistry HANYA abstraction + validation + execution (nol logic AI); 6 tool adalah adapter tipis atas provider existing.

### Arsitektur
- `providers/toolRegistry.js` — register/get/list/validate/execute/cancel. validator flat strict (unknown-key ditolak), result/error normalisasi, stale-callback guard via generation counter, cancellation batalkan seluruh run (bump gen + cancel cancellable aktif).
- `providers/tools/index.js` — 6 tool: calculator, search_files, search_web, open_url, open_file, launch_app. Semua platform-effect di-inject (providers, openUri, openPath, timers) -> pure-testable.
- `providers/fileProvider.js` — export `openPath(path)->bool` (native launch_default_for_uri_async setelah existence check), backward compatible.
- `applet.js::_createEngine()` — wiring ADD-ONLY: registry dibangun berbagi instance provider live, di-destroy saat rebuild. SEARCH & ASK AI tidak diubah satu byte.

### Batas (didefinisikan sejak awal, LIMITS)
- maxAgentSteps: 8 (dipakai Phase 9)
- maxListItems: 10, maxValueChars: 500, maxResultChars: 4000, webGraceMs: 2500

### Hasil test (node --test)
- toolregistry.test.js: 9/9, tools.test.js: 9/9, FULL suite: 105/105 PASS

### Guardrail terpenuhi
- Reuse murni provider existing, ToolRegistry tanpa logic AI, schema flat explicit, persis 6 tool, cancellation + stale callback protection aktif, tanpa shell/arbitrary command, SEARCH mode tidak berubah.

## Phase 9 — Agent Loop / AgentManager

ASK AI berubah dari one-shot menjadi tool-capable agent loop memakai ToolRegistry Phase 8.

- `providers/agentManager.js` BARU (~160 baris): gen-guard stale run, satu cancellable per run dibagikan ke AI HTTP + tool subprocess, sequential multi-tool execution, TANPA retry otomatis.
- `providers/aiProvider.js` ADDITIVE (+54/-8): body `tools` bila ada; pass-through message shape agent (role 'tool' + assistant tool_calls); parse response tool_calls SEBELUM cek empty-content.
- FULL suite: 125/125 PASS

## Phase 10 — Screen Awareness / Vision Tool (get_screen)

Tool `get_screen` — screenshot on-demand via D-Bus native, transient, vision-gated. TANPA computer control. Vision gate PROAKTIF SEBELUM capture: setting `ai-vision-supported` (default FALSE). Gambar→model: dataURL diubah menjadi tool-msg kecil + user turn multimodal. FULL suite: 142/142 PASS.

## Phase 11 — Structured Computer Control

5 tool UI-control terstruktur baru; computer-use loop muncul natural dari loop generik (get_screen → action → get_screen → final). TANPA permission system besar.

| Tool | Risk | Validasi |
|---|---|---|
| focus_app | LOW | AppSystem lookup |
| click | MEDIUM | int ketat, dalam bounds layar live |
| type_text | MEDIUM | cap 500 char, control-char di-strip |
| press_key | MEDIUM | whitelist eksplisit (Return/Esc/Tab/Bksp/Del/panah/Home/End/PgUp/PgDn/Space/F1-F12) |
| scroll | MEDIUM | direction up\|down; amount 1..10 |

FULL suite: 160/160 PASS

## Phase 12 — Permission / Safety Model

Policy `providers/permissionPolicy.js` — `decide(toolId, riskLevel) -> allow | confirm | deny`. Confirmation UX ModalDialog [Batal][Izinkan]. FULL suite: 173/173 PASS

## Phase 13 — Agent UX / UI

Status aktivitas agent tanpa mengubah arsitektur. AgentManager hook `onPhase`/`onToolStart`/`onToolComplete`/`onToolError`, `utils.toolLabel`, satu bubble pending aktif per run. FULL suite: 180/180 PASS
