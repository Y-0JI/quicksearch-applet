# Quick Search — Universal Search + AI Upgrade Plan

## Tujuan

Kembangkan applet Cinnamon Quick Search menjadi **Universal Quick Search** yang tetap ringan dan cepat.

Konsep utamanya:

```text
ONE SEARCH BOX
      +
TWO MODES
      +
INLINE RESULTS
```

Mode utama:

- **SEARCH** — mencari aplikasi, file, URL, web, dan kalkulasi.
- **ASK AI** — mengirim pertanyaan ke AI dan menampilkan jawabannya tetap di dalam overlay Quick Search.

Gunakan screenshot referensi sebagai **referensi pengalaman pengguna**, bukan untuk menyalin kode atau UI secara mentah.

---

## Prinsip Produk

Pertahankan karakter produk:

- sederhana
- cepat
- ringan
- keyboard-first
- satu overlay
- hasil muncul di tempat yang sama
- tidak membuka jendela tambahan untuk hasil AI
- tidak membuat dashboard atau chat application penuh
- jangan menambah kompleksitas tanpa kebutuhan nyata

**Jangan merombak core search yang sudah stabil.**

Gunakan kembali sistem yang sudah ada untuk:

- Applications
- Files
- Web
- URL
- Calculator
- ranking
- deduplication
- cancellation
- generation protection
- keyboard navigation
- click-outside
- shortcut `Super+F`

Tambahkan kemampuan baru secara bertahap di atas fondasi tersebut.

---

# 1. Empty State

Saat Quick Search dibuka:

**hanya search box yang terlihat.**

Tidak boleh langsung menampilkan:

- history
- hasil aplikasi
- file
- web
- kalkulasi
- jawaban AI
- suggestion

Konsep:

```text
┌──────────────────────────────────────────────┐
│ Ask anything, find anything...          🔍 ✨│
└──────────────────────────────────────────────┘
```

Searchbox harus otomatis fokus.

Saat query dihapus sampai kosong, overlay kembali ke kondisi compact yang sama.

---

# 2. Dua Mode

Tambahkan dua mode:

```text
SEARCH
ASK AI
```

`SEARCH` menjadi mode default.

Gunakan satu overlay yang sama. Jangan membuat halaman atau jendela terpisah.

Mode dapat diganti dengan kontrol sederhana yang mudah dipahami.

Contoh konsep:

```text
🔍 Search
✨ Ask AI
```

Pilih interaksi keyboard yang paling sederhana dan tidak bentrok dengan shortcut sistem.

---

# 3. SEARCH Mode

Mode SEARCH menggunakan core search engine yang sudah ada.

Pertahankan provider:

```text
Applications
Files
Web
URL
Calculator
```

Contoh:

```text
firefox
```

→ aplikasi yang relevan.

```text
document
```

→ file yang relevan.

```text
github.com
```

→ URL.

```text
2*3
```

→ calculator.

Jangan rewrite provider yang sudah berjalan.

---

# 4. History + Suggestions

Saat user mulai mengetik, hasil pencarian dapat diawali dengan history dan suggestion.

Bedakan keduanya secara visual.

```text
🕘 = history
🔍 = suggestion
```

Contoh:

```text
🕘 gesture
🕘 gemini ai
🕘 gempa hari ini

🔍 gemini
🔍 gerhana bulan
🔍 gempa bumi
```

### History

History berasal dari query yang sebelumnya dijalankan user.

Tetap gunakan persistence yang sudah ada.

Gunakan jumlah yang terbatas, misalnya sekitar 15–20 query.

Query baru:

```text
tambah ke history
→ deduplicate
→ pindah ke posisi teratas
→ batasi jumlah
```

### Suggestions

Suggestions bukan history.

Suggestions dapat berasal dari:

- penyelesaian query
- pencocokan lokal
- sumber web yang ringan
- sumber lain yang relevan

Jangan mencampur metadata history dan suggestion.

---

# 5. Result Model

Perluas result type yang sudah ada agar dapat mewakili:

```text
app
file
web
url
calc
history
suggestion
ai
```

Tetap gunakan model result yang seragam.

Provider menghasilkan data.

UI bertanggung jawab terhadap rendering.

Jangan membuat provider mengatur layout.

---

# 6. Search Result UI

Saat query aktif, overlay berkembang untuk menampilkan hasil.

Konsep:

```text
┌──────────────────────────────────────────────┐
│ 🔍 ge                                    ✕ ✨│
├──────────────────────────────────────────────┤
│                                              │
│ 🕘 gesture                                   │
│ 🕘 gemini ai                                 │
│                                              │
│ APPLICATIONS                                │
│ ✦ Gemini AI                                  │
│   Artificial intelligence chatbot...         │
│                                              │
│ FILES                                        │
│ ...                                          │
│                                              │
│ WEB                                          │
│ ...                                          │
└──────────────────────────────────────────────┘
```

Gunakan struktur section dan ranking yang sudah ada.

Ketika tidak ada hasil, jangan menyisakan ruang kosong berlebihan.

---

# 7. ASK AI Mode

Tambahkan **AIProvider** terpisah dari SearchEngine.

Arsitektur tingkat tinggi:

```text
QuickSearchOverlay
        │
        ├── SEARCH → SearchEngine
        │
        └── ASK AI → AIProvider
```

AIProvider bertanggung jawab terhadap:

- menerima pertanyaan
- mengirim request
- menerima response
- cancellation
- error handling

Jangan memasukkan logika AI ke provider file/app/web atau ke result renderer.

---

# 8. AI Result

Jawaban AI harus tetap muncul **di dalam overlay yang sama**.

Contoh:

```text
┌──────────────────────────────────────────────┐
│ ✨ Jelaskan apa itu plocate                  │
├──────────────────────────────────────────────┤
│ AI                                           │
│                                              │
│ plocate adalah tool pencarian file yang      │
│ menggunakan database index...                │
│                                              │
└──────────────────────────────────────────────┘
```

Jangan membuka:

- browser baru
- terminal
- aplikasi chat
- window lain

Hasil AI harus terasa sebagai bagian dari Quick Search.

Tidak perlu membangun UI chat penuh untuk versi ini.

---

# 9. AI Provider Abstraction

Jangan mengikat UI ke satu penyedia AI.

Gunakan abstraksi sederhana:

```text
AIProvider
    ↓
query
    ↓
response
```

Implementasi provider dapat ditambahkan kemudian.

Contoh kemungkinan backend:

```text
OpenRouter
OpenAI
Claude
Gemini
local model
```

Pemilihan provider tidak boleh mempengaruhi struktur UI.

API key atau credentials:

- jangan ditulis ke source code
- gunakan settings/environment yang sesuai
- jangan pernah commit secret ke repository

---

# 10. AI Cancellation

Gunakan prinsip yang sama dengan search engine.

Ketika query baru datang:

```text
query lama
    ↓
cancel
    ↓
generation baru
    ↓
query baru
```

Response lama tidak boleh mengganti hasil query terbaru.

Request network harus asynchronous.

Jangan membuat Cinnamon UI freeze.

---

# 11. Mode Switching

User dapat berpindah:

```text
SEARCH ↔ ASK AI
```

tanpa menutup overlay.

Ketika mode berubah:

- state mode diperbarui
- result yang tidak relevan dibersihkan
- query tetap dipertahankan bila itu menghasilkan UX yang lebih natural
- stale search/AI response tidak boleh muncul

Contoh:

```text
SEARCH
  ↓
ketik query
  ↓
ASK AI
  ↓
jawaban AI
  ↓
SEARCH
  ↓
hasil local/web
```

---

# 12. Keyboard

Pertahankan:

```text
Super+F
↑
↓
Enter
Esc
```

Tambahkan hanya satu cara sederhana untuk berpindah mode.

Pilihan yang baik:

```text
Tab
```

atau shortcut kombinasi yang tidak konflik.

Sebelum memakai shortcut baru, cek konflik sistem.

---

# 13. Click Behavior

Pertahankan behavior yang sudah ada:

```text
click result
→ action

click outside
→ close

Esc
→ close
```

Untuk AI:

```text
AI response selesai
→ overlay tetap terbuka

click outside / Esc
→ close
```

---

# 14. Performance

Jangan membuat request web atau AI setiap karakter.

Gunakan debounce yang sudah ada untuk search.

Untuk AI:

- jangan request saat query kosong
- jangan request pada setiap keypress
- lakukan request ketika user sudah selesai mengetik atau menggunakan aksi submit yang jelas

History dan suggestions harus ringan.

Jumlah item yang dirender tetap dibatasi.

---

# 15. Arsitektur yang Dipertahankan

Jangan mengganti fondasi existing.

Pertahankan:

```text
SearchEngine
ApplicationProvider
FileProvider
WebProvider
URLProvider
CalculatorProvider
Result pipeline
Cancellation
Generation guard
```

Tambahkan seperlunya:

```text
Mode handling
History/Suggestion results
AIProvider
AI result rendering
```

Hindari:

- framework baru
- database baru
- indexing baru
- rewrite SearchEngine
- rewrite provider yang sudah stabil

---

# 16. Urutan Implementasi

## Phase 1 — UI State

Tambahkan mode:

```text
SEARCH
AI
```

Pastikan empty state tetap compact.

## Phase 2 — History + Suggestions

Pisahkan:

```text
history
suggestion
```

dan tampilkan icon yang berbeda.

## Phase 3 — AIProvider

Tambahkan abstraksi AI tanpa mengubah SearchEngine.

## Phase 4 — AI Result

Render jawaban AI inline di overlay.

## Phase 5 — Cancellation + Error Handling

Pastikan AI request dapat dibatalkan dan response lama dibuang.

## Phase 6 — UX Integration

Pastikan mode switching, keyboard, click-outside, dan empty state konsisten.

## Phase 7 — Testing + Regression

Jalankan test penuh sebelum dianggap selesai.

---

# 17. Testing

### Empty state

```text
open
→ hanya searchbox
```

### Search

```text
firefox
→ app result

document
→ file result
```

### Calculator

```text
2*3
10/2
2^3
sqrt(16)
```

### History

```text
jalankan query
→ close
→ buka
→ mulai mengetik
→ history muncul dengan 🕘
```

### Suggestions

Pastikan suggestion berbeda secara visual dari history:

```text
🕘 history
🔍 suggestion
```

### AI

```text
switch ke AI
→ masukkan pertanyaan
→ AI result tampil di overlay
```

### Cancellation

```text
AI query A
→ query B
→ response A terlambat
→ A dibuang
```

### Mode switching

```text
SEARCH → AI → SEARCH
```

tanpa stale result.

### Lifecycle

```text
open/close berulang
reload Cinnamon
remove/re-add applet
```

Tidak boleh ada leak, duplicate shortcut, atau callback lama.

### Security

Pastikan:

```text
API key tidak tersimpan di source
```

---

# 18. Definition of Done

Fitur dianggap selesai bila:

```text
[ ] Initial state hanya searchbox
[ ] Empty state compact
[ ] SEARCH mode bekerja
[ ] ASK AI mode tersedia
[ ] Mode switching bekerja
[ ] History memakai icon 🕘
[ ] Suggestions memakai icon 🔍
[ ] History dan suggestion dibedakan
[ ] Existing search provider tetap bekerja
[ ] Calculator tetap bekerja
[ ] AI result muncul inline
[ ] AI request asynchronous
[ ] AI cancellation bekerja
[ ] Stale AI response dibuang
[ ] Click outside tetap menutup
[ ] Esc tetap menutup
[ ] Super+F tetap bekerja
[ ] Tidak ada API key di repository
[ ] Full regression test PASS
```

---

# 19. Instruksi untuk AI Agent

Sebelum coding:

1. **Baca repository dan pahami implementasi yang sudah ada.**
2. Identifikasi bagian yang bisa digunakan kembali.
3. Jangan mengubah komponen yang sudah stabil tanpa alasan.
4. Buat perubahan kecil dan terisolasi.
5. Setelah setiap tahap, jalankan test yang relevan.
6. Jika menemukan bug yang tidak berkaitan langsung dengan task, jangan melakukan rewrite besar; dokumentasikan dan prioritaskan berdasarkan dampaknya.
7. Gunakan solusi paling sederhana yang konsisten dengan arsitektur existing.
8. Jangan menambahkan abstraction hanya untuk terlihat modular.
9. Jangan menambahkan dependency baru kecuali benar-benar diperlukan.
10. Setelah semua tahap selesai, lakukan regression test penuh dan pastikan lifecycle Cinnamon bersih.

**Prioritas:**

```text
stabilitas
>
kesederhanaan
>
responsiveness
>
fitur tambahan
>
polish
```

Jangan menganggap fitur selesai hanya karena UI terlihat benar. Pastikan behavior dan lifecycle juga terverifikasi.

---

# 20. Batasan Scope

Untuk versi ini **jangan menambahkan**:

- chat history penuh
- streaming AI kompleks
- multi-agent
- plugin system
- database pencarian baru
- filesystem indexer sendiri
- browser automation
- dashboard
- workspace besar
- sinkronisasi cloud

Bangun fondasi Universal Quick Search yang sederhana terlebih dahulu.

---

## Target Akhir

Pengalaman yang diinginkan:

```text
                QUICK SEARCH

       ┌───────────────────────────────┐
       │ Ask anything, find anything...│
       │                         🔍 ✨ │
       └───────────────────────────────┘

                   ↓ ketik

       ┌───────────────────────────────┐
       │ 🔍 query                 ✕ ✨ │
       ├───────────────────────────────┤
       │ 🕘 history                    │
       │ 🔍 suggestion                 │
       │                               │
       │ APPLICATIONS                  │
       │ FILES                         │
       │ WEB                           │
       └───────────────────────────────┘

                   atau

       ┌───────────────────────────────┐
       │ ✨ pertanyaan AI          ✕   │
       ├───────────────────────────────┤
       │ AI                            │
       │                               │
       │ jawaban AI tetap di sini      │
       │                               │
       └───────────────────────────────┘
```

**One search box, two modes, inline results, minimal architecture.**
