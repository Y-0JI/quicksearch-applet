# Universal Quick Search + AI — Phase Planning

> Referensi utama: `docs/upgrade-quick-search-universal-ai-plan.md`
> Tanggal: 2026-08-24
> Mode eksekusi: **phase-per-phase** — selesaikan satu fase → test/verifikasi → review → baru lanjut.

---

## Keputusan Terkunci (hasil diskusi)

| # | Keputusan |
|---|---|
| D1 | Backend AI pertama: **OpenRouter** (interpretasi dari "9Router"). `AIProvider` tetap abstrak — UI dan SearchEngine tidak mengenal OpenRouter secara langsung |
| D2 | API key disimpan di **settings xlet** (`~/.config/cinnamon/spices/quicksearch@yoji/*.json`) — tanpa hard-code di source, tanpa commit ke git |
| D3 | Suggestions Phase 2: **sumber lokal saja** — prefix completion dari history, nama aplikasi, file lokal yang ringan. Tanpa web autocomplete untuk versi ini |
| D4 | Trigger AI: **Enter saat mode ASK AI** = kirim pertanyaan. Tidak ada auto-request per keypress |
| D5 | Eksekusi phase-by-phase dengan checkpoint review di antara fase |

## Prinsip Umum
- Jangan rewrite yang sudah stabil: SearchEngine, provider (app/file/web/url/calculator), ranking, dedupe, cancellation/generation guard, keyboard nav, click-outside, `Super+F`
- Perubahan kecil & terisolasi per fase
- Tanpa framework/dependency/database baru
- Prioritas: stabilitas > kesederhanaan > responsiveness > fitur tambahan > polish
- Setiap fase ditutup dengan: `node --check`, `node --test` (regresi tetap hijau), reload Cinnamon bersih, verifikasi runtime, lalu BERHENTI untuk review

---

## Phase 1 — UI Mode State

**Tujuan:** dua mode dalam satu overlay, tanpa mengubah apapun di pipeline search.

### Scope
- State `this._mode = 'search' | 'ai'` di applet; default `'search'`; reset ke `'search'` setiap `open()`
- Kontrol UI: dua tombol ikon kecil inline di kanan entry (`🔍` search, `✨` ask AI) dalam HBox `[entry][btn-search][btn-ai]`
- Keyboard: **Tab** toggle mode (di-intercept di `onKeyPress` sebelum propagate)
- Saat ganti mode: cancel engine + clear results + swap `hint_text` ("Search…" ↔ "Ask anything…") + highlight tombol aktif; teks query dipertahankan; tidak ada request apapun (AIProvider belum ada)
- Empty state harus tetap compact (98px)

### File tersentuh
- `applet.js` (overlay + applet), `stylesheet.css`

### Verifikasi exit
1. `node --check` + `node --test` 20/20
2. Reload bersih
3. Open kosong → compact, mode=search
4. Tab / klik ✨ → mode ai: hint berubah, hasil clear, teks utuh
5. Kembali search → pipeline normal ("te" → hasil muncul)
6. Regresi: Super+F, Esc, click-outside, ↑↓/Enter, kalkulator `2^3`
7. Screenshot empty + kedua mode

---

## Phase 2 — History + Suggestions

**Tujuan:** hasil pencarian diawali history 🕘 dan suggestion 🔍 yang terbedakan visual & metadata.

### Scope
- History: aktifkan kembali `_recent` (sudah persisten) sebagai result type `history`, icon 🕘 (`document-open-recent`), muncul hanya saat query aktif dan cocok/di atas hasil kosong — TIDAK pernah pada empty state
- Suggestions: source lokal saja (D3):
  - prefix completion dari history
  - nama aplikasi (dari index AppProvider yang sudah ada)
  - file lokal ringan (opsional, bila murah)
- Result types baru: `history`, `suggestion` — metadata terpisah, jangan dicampur
- Batasi jumlah render (mis. max 3 history + 3 suggestion)
- Klik row history/suggestion → isi ulang entry + jalankan search (reuse pola recent-row lama)

### File tersentuh
- `applet.js` (render + injection logic), `result.js` (type/score tiers), `stylesheet.css` (ikon beda)

### Verifikasi exit
1. Ketik "ge" setelah pernah menjalankan "gesture" → row 🕘 gesture muncul di atas
2. Suggestion 🔍 tampil terpisah dari 🕘
3. Empty state TETAP tanpa history
4. Regresi penuh search + kalkulator + empty compact

---

## Phase 2.5 — Floating Results UI

> Sisipan hasil review Phase 2. **Murni UI/presentation** — nol perubahan logic.

**Tujuan:** searchbox tetap compact sebagai surface tersendiri; history/suggestion/hasil search tampil sebagai **panel floating di bawah searchbox** (pola UX Google Search pada mockup), dalam overlay yang sama.

### Keputusan desain
- Tetap **satu QuickSearchOverlay** — tidak ada window/dialog Cinnamon kedua, tanpa global event listener
- Pendekatan paling sederhana: pisahkan *chrome* visual — searchbox jadi surface berdiri sendiri (rounded, opaque), results area diberi surface gelapnya sendiri (border/radius/typography mengikuti Orchidea-Dark QuickSearch existing), dengan gap kecil di antara keduanya; dialog induk dibuat transparan ketika panel tampil
- Lebar panel mengikuti searchbox; batas tinggi tetap (max-height existing ~420px) agar tidak memenuhi layar
- Urutan konten tidak berubah: History 🕘 → Suggestion 🔍 → hasil search (tanpa header besar)
- Interaksi tak disentuh: `activateRow()` existing untuk semua klik, ↑↓/Enter/Esc, click-outside via `_backgroundBin`/lightbox mekanisme existing

### Scope eksplisit
- Eksplorasi struktur layout existing lebih dulu, lalu pilih solusi minimal (CSS-first; struktur actor hanya jika perlu)
- TIDAK mengubah: `buildLocalRows()`, SearchEngine, calculator, providers, history persistence, shortcut, mode SEARCH/AI, AIProvider
- Tanpa dependency baru, tanpa refactor besar

### Verifikasi exit
1. `node --check` + full unit test PASS (26/26 saat ini)
2. Reload Cinnamon tanpa error
3. Open kosong → **hanya searchbox**, panel tidak muncul, tetap compact
4. Ketik → panel muncul tepat di bawah searchbox, lebar sama
5. History + suggestion + hasil search berurutan sesuai Phase 2
6. ↑↓ Enter, klik history/suggestion/result, Esc, click-outside — semua tetap bekerja
7. Buka/tutup berulang → tidak ada handler/overlay menumpuk (scan binding tetap tunggal)
8. Screenshot dibandingkan dengan mockup Google-style

---

## Phase 3 — AIProvider (Abstraksi + OpenRouter)

**Tujuan:** modul AI terpisah total dari SearchEngine.

### Scope
- Modul baru `providers/aiProvider.js`: interface netral `createAIProvider({ endpoint, apiKey, model }) → { ask(question, { cancellable }, cb), cancel() }`
- Implementasi pertama: **OpenRouter** (D1) via HTTP async (libsoup/GIO — non-blocking, tanpa freeze UI)
- API key + model + endpoint dibaca dari settings xlet (D2): field baru `settings-schema.json` (`api-key` type `entry`, `ai-model` combobox/input, default model murah)
- Tidak ada wiring ke UI di fase ini; unit test dengan mock fetch layer
- Placeholder text/secret: pastikan `.gitignore`/storage aman; key hanya di user config

### File tersentuh
- `providers/aiProvider.js` (BARU), `tests/aiprovider.test.js` (BARU, mock network), `settings-schema.json` (+2 field)

### Verifikasi exit
1. Unit test mock: sukses, error HTTP, timeout, cancel → callback tidak dipanggil
2. Key tidak ada di repo (`git grep` bersih)
3. Engine/provider lain tak tersentuh (diff audit)

---

## Phase 4 — AI Result Inline

**Tujuan:** jawaban AI tampil di overlay yang sama.

### Scope
- Result type `ai`: section "AI" dirender di resultsBox (St.Label multi-line wrap, icon ✨)
- Di mode `ai`: Enter → `AIProvider.ask()` → loading state ringan (row "Thinking…") → replace dengan jawaban
- Error → row error inline (tanpa crash, tanpa notifikasi berisik)
- Jawaban panjang → scroll area yang sama (max-height existing)
- Tanpa window/browser/chat page tambahan

### File tersentuh
- `applet.js` (mode ai submit path + render section ai), `result.js` (score tier `ai`), `stylesheet.css`

### Verifikasi exit
1. Mode ai → pertanyaan → Enter → jawaban inline (OpenRouter nyata, key user)
2. Overlay tetap terbuka setelah jawaban; Esc/outside menutup
3. Screenshot pertanyaan + jawaban

---

## Phase 5 — Cancellation + Error Handling AI

**Tujuan:** response basi tak pernah menimpa yang baru; semua failure path aman.

### Scope
- Generation guard ala SearchEngine untuk AI: pertanyaan baru → cancel request lama + gen++ ; callback lama dibuang via stale check
- Close overlay / switch mode → cancel in-flight AI
- Timeout + retry sederhana? (default: timeout saja, tanpa retry — kesederhanaan)
- Rate-limit/error mapping: 401 (key salah), 429, 5xx → pesan inline spesifik

### File tersentuh
- `providers/aiProvider.js`, `applet.js` (stale wiring)

### Verifikasi exit
1. Pertanyaan A lambat → Enter B → A datang belakangan → DIBUANG, hanya B tampil
2. Switch mode/close saat in-flight → tidak ada callback liar (log bersih)
3. Key salah → pesan inline jelas, tanpa crash

---

## Phase 6 — UX Integration

**Tujuan:** konsistensi menyeluruh lintas mode.

### Scope
- Audit & rapikan: mode switching bolak-balik tanpa stale result; query dipertahankan natural; empty state selalu compact di kedua mode; Tab fokus tidak tertukar; ikon tombol state benar
- Keyboard final: Super+F, ↑↓, Enter (kontekstual per mode), Esc, Tab
- Lifecycle: open/close berulang ×10, remove/re-add applet — tanpa leak binding/callback

### Verifikasi exit
- Checklist §17 dokumen induk dijalankan penuh secara runtime

---

## Phase 7 — Testing + Regression Penuh

### Scope
- `node --test` full suite diperluas (aiprovider mock, result types baru)
- Regression manual sesuai §17: empty/search/calculator/history/suggestion/AI/cancellation/mode-switch/lifecycle/security
- Definition of Done §18 dicek item per item
- Commit + push per phase sudah terjadi; final tag/catatan rilis singkat di README

---

## Catatan Risiko
- OpenRouter butuh key valid milik user untuk test nyata (Phase 4) — minta ke user saat fase tersebut
- libsoup versi di Cinnamon (2.4 vs 3) harus dicek saat Phase 3
- Tab interception: pastikan tidak merusak aksesibilitas focus navigation internal dialog
