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
