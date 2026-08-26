# Test Report — quicksearch@yoji v1.0.0 (2026-08-23)

Environment: Cinnamon 6.6.9+zena · mozjs-115 · plocate/locate(→plocate)/find · Soup-3.0

## Unit tests (`node --test`): 16/16 PASS
calculator (parser safety), url detection, backend picker + glob sanitize,
result pipeline (classify/normalize/dedupe/rank/limits).

## Live matrix (via dbus Eval against running Cinnamon)

| # | Test | Hasil |
|---|------|-------|
| 1 | Race typing f→fi→…→firefox | ✅ final rows = firefox only; app top, limits 5/15/5 |
| 2 | Cancellation | ✅ SIGTERM+force_exit on timeout/cancel; 0 orphan find; cb exactly-once |
| 3 | Provider failure chain | ✅ forced-find → 187 hasil; no-backend → [] instan tanpa hang |
| 4 | Missing file sebelum Enter | ✅ query_exists guard, no crash |
| 5 | Dedup | ✅ Firefox app 1×; unit-tested stable ids (appid/path/canonical-url) |
| 6 | Applet removal | ✅ instance GONE, hotkey unbound, 0 error log |
| 7 | Re-add | ✅ REINSTALLED_OK |
| 8 | Open/close ×10 | ✅ state CLOSED, tanpa error |
| 9 | Empty query | ✅ cb instan ([]), tidak spawn fs/web |
| 10 | Long/special chars & injection | ✅ argv array; nasty string settled aman (1 row) |
| 11 | NUL output regression | ✅ newline protocol (GJS truncates at \0) |
| 12 | Settings disable web | ✅ web provider null; file tetap jalan (guardrail 3) |
| 13 | Recent persistence | ✅ JSON via settings; tampil saat kosong |
| 14 | Calc activation | ✅ clipboard = "1000" |
| 15 | DDG instant answers | ✅ upgrade ke score-90 rows (5 web) |
| 16 | Focus otomatis | ✅ stage focus = entry clutter_text |

## Guardrails
1. find limit reader-side ✅ (slice MAX_CANDIDATES, no -quit)
2. engine tanpa pending counter; flush per completion selama gen valid ✅
3. cancellable baru per query efektif, dipakai konsisten file+web ✅
4. argv diverifikasi aktual per tool; locate=plocate-symlink terdeteksi ✅

## Known behavior (bukan bug)
- "Ikon tidak muncul di panel": panel user memakai autohide mode **intel**
  (`panels-autohide=['1:intel',...]`) — panel disembunyikan saat jendela
  fullscreen/maksimal menutupinya. Ikon 🔍 ada di pojok kiri panel bawah
  (terverifikasi via screenshot). Akses alternatif: **Super+F**
  (default sejak migrasi; `Super+Space` lama bentrok dengan switcher
  input-source sistem `next-input-source`) — bekerja meski panel hidden.

## Phase 4 — ASK AI inline (multi-provider)

- Arsitektur: Applet → AIManager (satu-satunya entry point) → registry metadata
  (9router/openrouter/openai/custom) → engine OpenAI-compatible generik.
- Settings: ai-provider (combobox), ai-model, ai-endpoint, ai-api-key
  (key hanya di ~/.config/cinnamon/spices, di luar repo).
- Request shape terbukti: {model:"coba9router", messages:[user], stream:false,
  max_tokens:512} ke http://127.0.0.1:20128/v1/chat/completions.
- LIVE PASS: mode ASK AI + "jelaskan plocate dalam 2 kalimat" + Enter →
  "Thinking..." → jawaban bahasa Indonesia inline di panel utama; overlay tetap
  terbuka; scroll area existing dipakai.
- Error informatif: pesan error upstream 9Router ditampilkan sebagai detail
  setelah baris ramah (mis. HTTP 401 → "API key tidak valid." + detail router);
  konten kosong dengan finish_reason=length juga dilaporkan.
- Catatan model reasoning (hy3-free): sebagian token habis di fase reasoning;
  bila jawaban kosong, UI menampilkan penyebab finish_reason secara informatif.

### Perbaikan pasca-review Phase 4
- max_tokens tidak lagi hard-coded 512: default 2048, configurable via setting
  `ai-max-tokens` (spinbutton 256-16384) — reasoning combo membutuhkan lebih.
- finish_reason=length DENGAN konten -> tetap SUCCESS; hanya benar-benar kosong
  yang dilaporkan informatif (finish_reason ikut ditampilkan).
- recent-queries berubah type `generic` (storage internal, tidak dirender di
  Settings UI); persistence/history/suggestion tetap identik.
- LIVE PASS ulang 9Router Combo coba9router: pertanyaan pendek & panjang ->
  jawaban nyata inline (max tokens cukup untuk melewati fase reasoning),
  overlay tetap terbuka >12s setelah jawaban; Esc/outside/Super+F/search pass;
  47/47 tests.

### Perbaikan BUG pasca-Phase 4
- Autocomplete height kini diukur dari konten aktual autoCompleteBox
  (bukan preferred ScrollView yang stale): 1 row -> 1 row + padding,
  dst; tidak ada sisa tinggi dari state sebelumnya.
- search-engine dinormalisasi (id + label legacy, case-insensitive);
  nilai invalid di-log warning dan dipersist sebagai 'ddgo'. Deteksi
  perubahan engine dilakukan lazily per keystroke karena setValue
  combobox tidak memicu bind callback di build Cinnamon ini.
- Web fallback description memakai label engine terpilih
  (DuckDuckGo/Google/Bing) — tidak ada lagi fallback diam-diam ke DDG;
  instant answers tetap eksklusif ddgo.

## Phase 4.5 — Conversational AI (Chat 2 Arah)
- ConversationManager pure (maxTurns=8 PASANGAN = maks 16 message context,
  FIFO trim); Thinking hanya loading UI, tidak masuk history.
- LIVE PASS 9Router Combo coba9router, 5 turn:
  BMRI → fundamental → dividend → risiko → kesimpulan; follow-up dijawab
  kontekstual ("fundamentalnya?" paham konteks BMRI). Entries menumpuk
  (2→10) tanpa menimpa; history 10 messages.
- Percakapan baru (tombol) mengosongkan history+UI; reopen overlay setelah
  clear tetap kosong; session-only sesuai spec.
- Error rollback: user turn ditarik dari history + bubble user dihapus.

## Phase 5 — Cancellation + Error Handling AI
- Engine: Gio.Cancellable internal per instance (opts.cancellable override
  untuk test); cancel() memutus HTTP nyata; 'cancelled' MENEMBUS stale-guard
  agar ConversationManager dapat rollback orphaned user turn.
- Timeout Soup dipetakan ke error 'timeout'; manager.cancel() delegasi +
  passthrough; applet: submit baru/close/switch mode memanggil cancel,
  callback 'cancelled' diabaikan UI secara diam-diam.
- Mapping baru: http-5xx -> "Server AI bermasalah. Coba lagi nanti."
- Tanpa retry. UX 4.6 dan ConversationManager tidak berubah perilaku.
- RUNTIME: race A-lambat/B-baru (hanya B, A dibatalkan+rollback),
  close mid-flight (rollback+sweep bubble), switch mode mid-flight
  (aman), stub timeout/429/500 inline masing-masing; SEARCH regression;
  reload bersih. 63/63 tests.

## Phase 6 — UX Integration (Lifecycle & Konsistensi)
- Audit read-only: query preservation SEARCH<->AI bolak-balik preserved;
  empty state compact 60px kedua mode; stale AI tidak bocor ke SEARCH;
  Up/Down aman di panel kosong; Tab toggle + highlight benar;
  focus per mode benar.
- Open/close x20: keybinding tetap 1, region children tetap 2,
  conversation/chat session-only utuh, tanpa leak.
- Remove/re-add applet (canonical enabled-applets path):
  remove -> instance UNLOADED, keybinding 0, tanpa JS error;
  re-add -> instance 99 ter-load ulang, keybinding 1 (tanpa duplikat),
  settings utuh (model coba9router, provider 9router),
  conversation session-only BENAR-BENAR hilang (in-memory),
  Super+F + kalkulator + AI stub langsung normal.
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
- Orphaned user turn saat response tiba setelah close/supersede ->
  ConversationManager kini heal trailing user turn saat compose context
  (send & buildMessages); bubble Thinking lama ditandai "dibatalkan".
- Timeout live terverifikasi: "Socket I/O timed out" -> inline informatif.
- Catatan: jawaban AI 351-char muat di panel tanpa scroll; mekanisme scroll
  panel terverifikasi via SEARCH battery (upper 717 > page 420, widget sama).
- Security: tanpa shell-exec dari user input; key hanya di user config.

### Fitur tambahan: clickable links dalam jawaban AI
- utils.extractUrls: hanya http/https (javascript:/file:/data: tidak pernah
  dieksekusi), trailing punctuation di-strip, dedupe, order preserved. 6/6 tests.
- Render: teks jawaban tetap satu label wrap utuh (isi tidak diubah); setiap
  URL dirender sebagai St.Button link di bawah teks (style link biru, wrap
  untuk URL panjang); klik -> Gio.AppInfo.launch_default_for_uri_async
  (native, tanpa shell) — pola sama dengan action web results existing.
- LIVE: jawaban stub dengan URL Maps -> link button ter-render dengan URL
  lengkap; handler terhubung standar St.Button 'clicked'.
- Catatan env: delivery klik fisik xtest tidak konsisten di sesi verifikasi
  ini (mempengaruhi semua tombol termasuk lightbox), sehingga handler
  diverifikasi via emit + direct method call; mekanisme klik identik dengan
  tombol lain yang sudah dipakai user.

## Phase 8 — Tool System / ToolRegistry

Fondasi tool system (registry generik + 6 tool adapter) tanpa menyentuh
SEARCH/AI yang stabil. ToolRegistry HANYA abstraction + validation +
execution (nol logic AI); 6 tool adalah adapter tipis atas provider existing.

### Arsitektur
- `providers/toolRegistry.js` — register/get/list/validate/execute/cancel.
  validator flat strict (unknown-key ditolak), result/error normalisasi,
  stale-callback guard via generation counter, cancellation batalkan seluruh
  run (bump gen + cancel cancellable aktif).
- `providers/tools/index.js` — 6 tool: calculator, search_files, search_web,
  open_url, open_file, launch_app. Semua platform-effect di-inject (providers,
  openUri, openPath, timers) -> pure-testable.
- `providers/fileProvider.js` — export `openPath(path)->bool` (native
  launch_default_for_uri_async setelah existence check), backward compatible.
- `applet.js::_createEngine()` — wiring ADD-ONLY: registry dibangun berbagi
  instance provider live, di-destroy saat rebuild. SEARCH & ASK AI tidak
  diubah satu byte.

### Batas (didefinisikan sejak awal, LIMITS)
- maxAgentSteps: 8 (dipakai Phase 9)
- maxListItems: 10, maxValueChars: 500, maxResultChars: 4000, webGraceMs: 2500

### Hasil test (node --test)
- toolregistry.test.js: 9/9 (register shape, list sorted, validate
  unknown/object/unknown-key/missing-required/bad-type, execute success,
  short-circuit invalid BEFORE run, thrown-error normalisasi, cancel stale
  drop + cancellable cancel, result truncation + size cap).
- tools.test.js: 9/9 (6 tool teregister + risk levels, calculator,
  search_files map+cancellable, search_web upgrade-early + grace-fallback,
  open_url scheme gate javascript:/file: rejected, open_file exist/missing,
  launch_app reuse action + no raw executable, SECURITY no shell/exec).
- FULL suite: 105/105 PASS (termasuk regression SEARCH/AI Phase 1-7).

### Guardrail terpenuhi
- Reuse murni provider existing (zero duplicated logic).
- ToolRegistry tanpa logic AI.
- Schema flat explicit, validator ~40 baris.
- Persis 6 tool, tanpa screen/computer-control.
- Cancellation + stale callback protection aktif.
- Tanpa shell/arbitrary command (audit grep CLEAN).
- SEARCH mode tidak berubah; AIProvider/AIManager/ConversationManager
  tidak disentuh.

### Runtime verification
- node --check: applet.js + 3 module baru OK.
- Reload Cinnamon: log "tool registry ready: calculator, launch_app,
  open_file, open_url, search_files, search_web". SEARCH & ASK AI identik.
- BERHENTI setelah Phase 8; menuju Phase 9 (Agent Loop) setelah review.

## Phase 9 — Agent Loop / AgentManager

ASK AI berubah dari one-shot menjadi tool-capable agent loop memakai
ToolRegistry Phase 8 (registry existing, tidak dibuat ulang).

### Arsitektur
```
ConversationManager.send -> askFn = AgentManager.run
  loop (max LIMITS.maxAgentSteps = 8):
    AIManager.ask(question, {messages, tools, cancellable})
      <- final answer -> selesai
      <- tool_calls -> ToolRegistry.execute per call (berurutan)
      <- hasil = role:'tool' message -> AI lagi
```
- `providers/agentManager.js` BARU (~160 baris): gen-guard stale run,
  satu cancellable per run dibagikan ke AI HTTP + tool subprocess
  (cancel = seluruh run mati), assistant tool_calls turn direkam utuh,
  sequential multi-tool execution, TANPA retry otomatis.
- `providers/aiProvider.js` ADDITIVE (+54/-8): body `tools` bila ada;
  pass-through message shape agent (role 'tool' + assistant tool_calls);
  parse response tool_calls SEBELUM cek empty-content. Legacy shape utuh.
- `providers/aiManager.js` +1 baris passthrough tools.
- `applet.js` add-only: buat `_agent` berbagi registry live di
  `_createEngine`; askFn lewat agent; cancel hooks di mode-switch/close/
  new-conversation/submit; `_aiErrorText` + case max-steps.
- ConversationManager / result.js / searchEngine.js: NOL perubahan.

### Normalisasi error dalam loop (semua jadi role:'tool', tidak crash)
- unknown-tool · invalid-arguments (unparseable-json / schema fail) ·
  tool-failed (throw) · error payload tool · result di-cap 4000 chars.

### Hasil test (node --test) — target roadmap Phase 9
1. no-tool final answer ✅ 2. one-tool ✅ 3. multi-tool (multi-round +
   3 calls satu response urut) ✅ 4. unknown tool ✅ 5. invalid arguments
   ✅ 6. tool failure (payload + throw) ✅ 7. cancellation (cancellable
   terpanggil, cb nol render) ✅ 8. max steps (tepat 8 panggilan AI) ✅
   9. stale response (run baru supersede; late completion drop) ✅
   tanpa retry ✅
- agentmanager.test.js 14/14; aiprovider +5; aimanager +1.
- FULL suite: 125/125 PASS (regression Phase 1-8 aman).
- node --check semua .js OK; grep shell/exec CLEAN; API key tak tersentuh.

### Runtime verification
- Reload Cinnamon: ASK AI pertanyaan biasa -> jawaban final seperti biasa
  (tanpa tools); pertanyaan tool ("cari file X", "hitung ...") -> loop
  jalan sampai final; tombol/mode switch saat Thinking -> run mati tanpa
  stale bubble.
- BERHENTI setelah Phase 9; menuju Phase 10 (Screen Awareness) setelah review.

## Phase 10 — Screen Awareness / Vision Tool (get_screen)

Tool `get_screen` — screenshot on-demand via D-Bus native, transient,
vision-gated. TANPA computer control (Phase 11). SEARCH tak tersentuh;
ConversationManager nol perubahan.

### Arsitektur & keputusan
- `providers/screenCapture.js` BARU: session-bus `org.gnome.Shell.Screenshot`
  (fallback `org.Cinnamon.Screenshot`) → PNG ke file tmp unik → baca →
  base64 → **file dihapus segera** (transien, tak pernah persist).
  Tanpa shell; tanpa timer/listener = tidak ada continuous capture.
- Vision gate PROAKTIF SEBELUM capture: setting `ai-vision-supported`
  (default FALSE, privacy-safe opt-in) → AgentManager.hasVision() →
  ctx.capabilities.vision → tool return `vision-not-supported` tanpa
  mengambil piksel.
- Gambar→model: hasil tool berisi dataURL DIUBAH AgentManager menjadi
  tool-msg kecil `{image_received:true}` + user turn multimodal
  `[text, image_url]` — protokol aman utk provider strict, base64 tak
  terduplikasi di history. Provider pass-through content array verbatim.
- Registry: string `data:image/` lolos UTUH (truncate = gambar korup);
  satu gerbang ukuran di agent: `image-too-large`
  (> LIMITS.maxImageDataUrlChars = 6M chars ≈ 4.5MB PNG).

### Hasil test (node --test) — target user Phase 10
1. get_screen sukses ✅ (data URL + cancellable forwarded)
2. no display/session/iface ✅ (`screenshot-unavailable`, kode fixed,
   path tak pernah dilog)
3. vision unsupported ✅ (`vision-not-supported`, NOL capture)
4. image size ✅ (registry pass-through + agent `image-too-large`)
5. cancellation ✅ (cancellable dibagikan DBus+read; 'cancelled')
6. stale callback ✅ (gen-guard agent+registry, run baru supersede)
7. agent final tanpa screen tool ✅ (no-tool regression tetap hijau)
8. full node --test: **142/142 PASS** (17 test baru)
9. node --check semua .js OK · grep shell/exec CLEAN ·
   NOL pemanggilan log di jalur capture (path/base64 tak mungkin bocor)

### Runtime verification (Cinnamon)
- Reload applet → log "tool registry ready: ...get_screen..." (7 tool).
- Vision OFF (default): "lihat layar saya" → agent menerima
  vision-not-supported sebagai tool result → jawaban natural, tanpa flash.
- Aktifkan "Model supports images" di Settings AI → tanya lagi → flash
  screenshot sesaat → model menganalisis isi layar.
- Cek ~/.xsession-errors: tidak ada base64/path tmp.

### Catatan desain
- Capability ditentukan host (settings), bukan tebakan metadata provider —
  deterministic & privacy-safe; provider metadata bisa menyusul bila
  dibutuhkan (Phase lanjutan).
- BERHENTI setelah Phase 10; menuju Phase 11 (Computer Control) setelah review.

## Phase 11 — Structured Computer Control

5 tool UI-control terstruktur baru; computer-use loop muncul natural dari
loop generik (get_screen → action → get_screen → final). TANPA permission
system besar (Phase 12), tanpa high-risk action, SEARCH nol perubahan.

### Tool baru (semua async + cancellable + validasi TOTAL pra-eksekusi)
| Tool | Risk | Validasi |
|---|---|---|
| focus_app | LOW | AppSystem lookup (id→nama); raise window existing → fallback app.activate |
| click | MEDIUM | int ketat, dalam bounds layar live (`global.screen_width/height`); button ∈ left/right/middle |
| type_text | MEDIUM | cap 500 char, control-char di-strip; kosong → invalid-text |
| press_key | MEDIUM | whitelist eksplisit (Return/Esc/Tab/Bksp/Del/panah/Home/End/PgUp/PgDn/Space/F1-F12); TANPA modifier combo |
| scroll | MEDIUM | direction up\|down; amount int 1..10 (default 3) |

### Backend injeksi (deteksi sekali, pola pickFileBackend)
1. `clutter` — Clutter.Seat virtual device in-process (native, tanpa binary)
2. `xdotool` — fallback fixed-argv via Gio.Subprocess (pola fileProvider;
   BUKAN shell — argv array, teks user selalu setelah `--`)
3. tidak ada keduanya → `input-unavailable` untuk semua op (fail-closed)

### Hasil test (node --test)
- computerControl.test.js 6/6: whitelist, bounds ketat, sanitize,
  scroll-validate, argv builders (fixed shape), backend picker.
- tools.test.js 26/26: 12 tool teregister; klik valid diteruskan
  (button+cancellable); koordinat invalid ditolak SEBELUM backend
  (4 kasus); bounds dari host; type sanitize/invalid-text; key whitelist
  (ctrl+s & Foo ditolak, tak pernah dispatch); scroll default+invalid;
  focus found/not-found; cancellable mencapai 5 op; input-unavailable
  dinormalisasi.
- agentmanager: computer-use loop end-to-end ✅ (screen→click→screen→final,
  2 screenshot sampai ke model, tepat 1 klik).
- FULL suite: **160/160 PASS** · node --check ALL OK · grep shell CLEAN ·
  SEARCH/result/appProvider tak berubah.

### Runtime verification (Cinnamon)
- Reload → log registry 12 tool. Vision ON + "klik tombol X di layar" →
  shot → klik terasa → shot verifikasi → jawaban.
- Tanpa xdotool pun tetap jalan bila clutter path tersedia; jika keduanya
  absen → `input-unavailable` rapi (tidak crash).
- BERHENTI setelah Phase 11; menuju Phase 12 (Permission/Safety) setelah review.
