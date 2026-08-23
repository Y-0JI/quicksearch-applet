# Prompt — Build Lightweight Cinnamon Search Applet from Scratch

Buat sebuah **Cinnamon Applet Search** baru dari 0.

Tujuan utama: membuat launcher/search universal yang sangat ringan untuk Cinnamon Linux. Saat applet dibuka, tampil **search box sederhana di tengah layar**, terinspirasi dari konsep **Claude Quick Search**: fokus utama hanya pada input pencarian dan hasil yang muncul setelah user mengetik.

**Jangan menyalin UI atau kode dari project WinSearch.** Ambil hanya prinsip arsitektur dan logika pencariannya.

---

## 1. Tujuan Utama

Applet harus memungkinkan user dengan satu search box untuk mencari:

1. Aplikasi yang terinstall
2. File/folder di komputer
3. Web
4. URL langsung
5. Perhitungan matematika sederhana

Contoh:

```text
firefox
```

→ menemukan aplikasi Firefox.

```text
document
```

→ menemukan file/folder yang relevan.

```text
github
```

→ menemukan hasil web dan/atau menawarkan pencarian web.

```text
https://github.com
```

→ langsung membuka URL.

```text
125*8
```

→ menampilkan hasil kalkulasi.

---

## 2. Prinsip Utama

Prioritaskan:

- sederhana
- ringan
- cepat
- responsif
- mudah dipelihara
- tidak membuat index database sendiri jika sistem Linux sudah menyediakan search index
- jangan menjalankan proses berat di UI thread
- jangan membuat dependency yang tidak diperlukan

Jangan membuat sistem AI.

Jangan membuat database pencarian sendiri.

Jangan membuat crawler web sendiri.

Jangan membuat filesystem indexer sendiri.

Gunakan kemampuan Linux yang sudah tersedia.

---

## 3. Arsitektur

Gunakan arsitektur sederhana seperti:

```text
User Input
    ↓
Query Classifier
    ↓
Search Providers
    ├── Calculator
    ├── URL
    ├── Applications
    ├── Files
    └── Web
    ↓
Result Normalizer
    ↓
Simple Ranking
    ↓
Results
```

Setiap provider bertanggung jawab hanya terhadap jenis pencariannya sendiri.

Contoh:

```text
ApplicationProvider
FileProvider
WebProvider
CalculatorProvider
URLProvider
```

Jangan membuat semuanya berada dalam satu function besar.

---

## 4. Application Search

Cari aplikasi yang terinstall menggunakan API/komponen Cinnamon/GIO yang sudah tersedia.

Jangan menjalankan command shell untuk mencari aplikasi jika API Cinnamon/GIO sudah bisa digunakan.

Ambil informasi minimal:

```text
name
application id
description/keywords jika tersedia
icon
launch action
```

Gunakan scoring sederhana.

Contoh:

```text
exact name match       → sangat tinggi
name starts with query → tinggi
name contains query    → sedang
keyword match          → lebih rendah
description match      → lebih rendah
```

Contoh:

```text
query: firefox

Firefox
Firefox Developer Edition
```

harus berada di atas hasil yang hanya kebetulan mempunyai kata "firefox" di description.

Batasi jumlah hasil yang ditampilkan agar UI tetap ringan.

---

## 5. File Search

Ini bagian yang paling penting.

Jangan membuat filesystem indexer sendiri.

Gunakan sistem search yang sudah tersedia.

Prioritas:

```text
1. plocate
2. locate/mlocate
3. find sebagai fallback
```

Saat applet pertama kali dijalankan:

- cek command yang tersedia
- pilih provider terbaik
- simpan hasil detection tersebut
- jangan melakukan pengecekan command berulang-ulang setiap query

Jika `plocate` tersedia:

```text
query
 ↓
plocate
 ↓
candidate paths
```

Jika tidak tersedia:

```text
locate/mlocate
```

Jika semuanya tidak tersedia:

```text
find
```

Untuk `find`, batasi lokasi pencarian dan kedalaman agar tidak membuat komputer berat.

Default search location:

```text
$HOME
```

Jangan otomatis mencari seluruh `/`.

---

## 6. File Search Harus Async

File search tidak boleh membuat Cinnamon UI freeze.

Gunakan subprocess asynchronous.

Konsepnya:

```text
User mengetik
      ↓
debounce
      ↓
jalankan search subprocess
      ↓
UI tetap responsif
      ↓
hasil kembali
      ↓
validasi query generation
      ↓
tampilkan hasil
```

Jangan menggunakan synchronous subprocess untuk pencarian file.

---

## 7. Debounce

Gunakan debounce sekitar:

```text
100–200 ms
```

Jangan menjalankan search setiap karakter secara langsung.

Contoh:

```text
f
fi
fir
fire
firef
firefo
firefox
```

Search hanya dijalankan setelah user berhenti mengetik sebentar.

---

## 8. Stale Search Protection

Ini wajib.

Gunakan mekanisme generation/request ID.

Contoh:

```text
query "fire"
generation = 1

query "firefox"
generation = 2
```

Jika hasil pencarian `"fire"` selesai setelah `"firefox"`:

```text
hasil generation 1
    ↓
discard
```

Hanya hasil dari query terbaru yang boleh masuk ke UI.

Tujuannya agar hasil asynchronous lama tidak menimpa hasil query terbaru.

---

## 9. File Search Cache

Buat cache sederhana.

Cache key minimal:

```text
query + search location + provider
```

Contoh:

```text
firefox|/home/user|plocate
```

Simpan hasil sementara.

Gunakan cache terbatas agar memory tidak terus bertambah.

Tidak perlu membuat database cache permanen.

---

## 10. Web Search

Web search harus sederhana.

Jangan membuat search engine sendiri.

Gunakan provider web yang sederhana dan tidak membutuhkan API key jika memungkinkan.

Default:

```text
DuckDuckGo
```

Jika scraping HTML digunakan, buat parser sesederhana mungkin dan tangani kemungkinan response berubah.

Alternatif paling aman:

Jika hasil web tidak bisa diperoleh secara langsung, tampilkan:

```text
Search the web for "<query>"
```

dan buka browser menggunakan search URL.

Contoh:

```text
Search the web for:
best linux terminal
```

→ buka browser ke search engine.

Web search tidak boleh membuat Cinnamon freeze.

---

## 11. URL Detection

Sebelum melakukan search biasa, cek apakah query merupakan URL.

Contoh:

```text
https://github.com
```

→ langsung buka.

Juga dukung:

```text
github.com
```

→ otomatis tambahkan:

```text
https://
```

Jangan menganggap text yang mempunyai spasi sebagai URL.

---

## 12. Calculator

Tambahkan calculator sederhana.

Contoh:

```text
2+2
10*5
100/4
(10+5)*2
```

Jika query valid sebagai expression:

```text
125
```

tampilkan sebagai hasil langsung.

Jangan menjalankan arbitrary shell command.

Hati-hati terhadap penggunaan `eval`.

Jika memungkinkan gunakan parser matematika sederhana atau batasi expression secara ketat sebelum evaluasi.

---

## 13. Query Classification

Sebelum menjalankan semua provider, lakukan classification sederhana.

Contoh:

```text
"2+2"
    ↓
Calculator

"https://github.com"
    ↓
URL

"firefox"
    ↓
Apps + Files + Web

"document.pdf"
    ↓
Files + Apps + Web
```

Jangan memaksa semua provider bekerja untuk semua query jika tidak diperlukan.

Namun untuk query umum, aplikasi + file + web boleh dijalankan paralel/asynchronous.

---

## 14. Result Format

Semua provider harus mengembalikan format result yang seragam.

Gunakan konsep seperti:

```javascript
{
    type: "app",
    title: "Firefox",
    description: "Web Browser",
    icon: ...,
    score: 200,
    action: ...
}
```

Untuk file:

```javascript
{
    type: "file",
    title: "document.pdf",
    description: "/home/user/Documents",
    icon: ...,
    score: 120,
    action: ...
}
```

Untuk web:

```javascript
{
    type: "web",
    title: "...",
    description: "...",
    url: "...",
    score: ...
}
```

Provider tidak boleh bertanggung jawab terhadap layout UI.

Provider hanya menghasilkan data.

---

## 15. Ranking

Gunakan ranking sederhana.

Tidak perlu machine learning.

Contoh prinsip:

```text
Exact application match      → highest
Application prefix match     → very high
Application contains match   → high

Exact filename match         → high
Filename prefix              → high
Filename contains            → medium

Settings/metadata match      → lower

Web result                   → lower than strong local match
```

Tujuannya:

Jika user mengetik:

```text
firefox
```

hasil lokal yang jelas harus muncul lebih dulu daripada hasil web.

---

## 16. Result Sections

Walaupun UI sangat sederhana, hasil boleh dikelompokkan:

```text
Applications
Files
Web
```

Contoh:

```text
                ┌───────────────────────┐
                │ firefox               │
                └───────────────────────┘

APPLICATIONS
  Firefox
  Firefox Developer Edition

FILES
  firefox-config
  firefox.desktop

WEB
  Search Firefox on DuckDuckGo
```

Jangan membuat terlalu banyak section.

---

## 17. Keyboard First

Search harus bisa digunakan tanpa mouse.

Minimal:

```text
↑ ↓
```

untuk memilih result.

```text
Enter
```

untuk membuka result.

```text
Esc
```

untuk menutup search.

```text
Ctrl+A
```

untuk select all.

```text
Backspace
```

normal.

Jika result sedang dipilih, Enter harus menjalankan action result tersebut.

---

## 18. Launch Behavior

Application result:

```text
Enter
 ↓
launch application
```

File result:

```text
Enter
 ↓
open file dengan default application
```

Folder:

```text
Enter
 ↓
open folder di file manager
```

URL/web:

```text
Enter
 ↓
open browser
```

---

## 19. Recent Searches

Tambahkan recent searches secara sederhana.

Simpan sedikit saja, misalnya:

```text
10–20 query terakhir
```

Simpan ke konfigurasi user.

Jangan membuat database.

Recent search hanya muncul ketika search box kosong atau sesuai kebutuhan.

---

## 20. UI

UI **bukan prioritas**.

Buat sesederhana mungkin.

Ketika applet dibuka:

```text
                ┌──────────────────────────────┐
                │ Search...                    │
                └──────────────────────────────┘
```

Posisi:

```text
center screen
```

Fokus otomatis berada di search box.

Tidak perlu:

- dashboard
- sidebar
- settings panel kompleks
- banyak tombol
- card berlebihan
- animasi berat
- visual decoration yang tidak diperlukan

Yang penting terasa seperti:

```text
Quick Search
```

bukan aplikasi besar.

Hasil muncul tepat di bawah search box.

---

## 21. Applet Integration

Applet harus bisa:

```text
click applet
    ↓
open search overlay
    ↓
focus search box
```

Tambahkan keyboard shortcut Cinnamon jika memungkinkan.

Misalnya:

```text
Super + Space
```

Tetapi shortcut jangan hard-code jika Cinnamon menyediakan konfigurasi shortcut.

---

## 22. Dependencies

Prioritaskan dependency bawaan Cinnamon/Linux.

Gunakan:

```text
Cinnamon
GJS
GIO
GLib
St
Mainloop
Soup
```

sesuai kebutuhan.

Jangan menggunakan Node.js.

Jangan menggunakan Python.

Jangan menggunakan Electron.

Jangan menggunakan framework web.

Tujuan utama adalah:

```text
native Cinnamon applet
+
GJS
+
Linux tools
```

sehingga ringan.

---

## 23. Error Handling

Semua provider harus gagal secara graceful.

Contoh:

```text
plocate tidak tersedia
    ↓
gunakan locate

locate tidak tersedia
    ↓
gunakan find

web search gagal
    ↓
tampilkan "Search on Web"

file hilang sebelum result dibuka
    ↓
abaikan/error toast sederhana

aplikasi gagal launch
    ↓
jangan crash applet
```

Satu provider gagal **tidak boleh membuat seluruh search mati**.

---

## 24. Hard Reliability Requirements

Bagian ini wajib dipatuhi. Jangan mengorbankan reliability demi fitur tambahan.

### A. Cancellation + Generation

Generation ID saja tidak cukup.

Setiap query baru harus:

```text
query baru
   ↓
batalkan pekerjaan lama yang masih berjalan
   ↓
increment generation ID
   ↓
jalankan query baru
```

Untuk file search:

```text
query A
    ↓
subprocess A

query B masuk
    ↓
cancel subprocess A
    ↓
generation++
    ↓
subprocess B
```

Hasil dari generation lama tetap harus diabaikan jika somehow masih kembali.

### B. Lifecycle Cleanup

Saat overlay ditutup atau applet dihapus, bersihkan semua resource:

- debounce timeout
- suggestion timeout
- subprocess
- subprocess timeout
- HTTP/network request
- keybinding
- signal/event handler
- temporary state

Jangan meninggalkan process atau callback aktif setelah applet dihancurkan.

Implementasikan cleanup melalui lifecycle Cinnamon yang sesuai, misalnya `on_applet_removed_from_panel()` dan fungsi cleanup terpusat.

### C. Async Rule

Semua operasi yang berpotensi blocking harus asynchronous:

```text
subprocess
filesystem search
network request
```

Tidak boleh ada synchronous search/network operation yang bisa membuat Cinnamon UI freeze.

Operasi metadata filesystem kecil yang benar-benar diperlukan untuk memvalidasi satu hasil boleh synchronous hanya jika aman dan sangat ringan.

### D. Result Deduplication

Gabungkan hasil dari provider dengan deduplikasi.

Contoh:

```text
Firefox
Firefox
Firefox
```

harus menjadi satu result.

Gunakan identifier yang stabil jika tersedia:

```text
application id
absolute file path
canonical URL
```

Untuk web, normalisasi URL sederhana sebelum deduplication jika memungkinkan.

### E. Result Limits

Tetapkan limit yang jelas.

Default awal boleh:

```text
Applications → 5
Files        → 15
Web          → 5
```

Total result yang benar-benar dirender harus tetap terbatas.

Jangan menambahkan ratusan actor UI sekaligus.

### F. Search Location Safety

Default file search hanya:

```text
$HOME
```

Jangan mencari seluruh filesystem.

Gunakan configurable search locations bila diperlukan.

Untuk fallback `find`:

- gunakan timeout
- gunakan cancellation
- gunakan depth limit
- hindari direktori yang diketahui sangat besar/tidak berguna
- jangan membuat daftar exclusion yang terlalu agresif sampai file user normal ikut hilang

Exclusion harus dipikirkan sebagai optimisasi, bukan sebagai syarat utama correctness.

Contoh directory yang boleh dipertimbangkan:

```text
.git
node_modules
.cache
```

Tetapi jangan mengecualikan seluruh hidden directory secara otomatis.

### G. File Validation

Hasil dari `plocate`, `locate`, atau `find` adalah candidate path, bukan jaminan file masih ada.

Sebelum membuka result:

```text
candidate path
    ↓
validasi keberadaan
    ↓
launch
```

Jika sudah hilang:

```text
jangan crash
hapus/abaikan result
```

### H. Web Fallback Separation

Web provider harus dipisahkan antara:

```text
WebProvider
   ├── direct web-result retrieval
   └── browser-search fallback
```

Jika direct retrieval gagal, jangan membuat seluruh search gagal.

Minimal fallback:

```text
Search "<query>" on DuckDuckGo
```

yang membuka browser.

Web search tidak boleh menjadi dependency kritis bagi local search.

### I. Provider Isolation

Setiap provider harus gagal secara independen.

Contoh:

```text
AppProvider gagal
    ↓
FileProvider tetap jalan
WebProvider tetap jalan
Calculator tetap jalan
```

Satu exception tidak boleh menghentikan aggregation pipeline.

Gunakan error handling per provider.

### J. Result Normalization

Search engine hanya menggabungkan result yang sudah dinormalisasi.

Pipeline:

```text
Provider
   ↓
raw result
   ↓
normalize
   ↓
deduplicate
   ↓
score
   ↓
sort
   ↓
limit
   ↓
render
```

Provider jangan mengatur UI.

### K. Stable Action

Setiap result harus memiliki action yang aman dan jelas.

Contoh:

```text
app  → launch app
file → open file/folder
web  → open browser URL
calc → display/copy result
url  → open browser
```

Action error tidak boleh crash applet.

### L. No Hidden Global State

Hindari state global yang tidak perlu.

State utama sebaiknya dimiliki `SearchEngine`/applet instance dan dibersihkan saat lifecycle berakhir.

### M. No Over-Abstraction

Jangan membuat abstraction framework sendiri.

Provider abstraction cukup sederhana dan harus menyelesaikan kebutuhan nyata.

Jika sebuah helper tidak dipakai oleh lebih dari satu tempat dan tidak meningkatkan kejelasan, jangan membuatnya hanya demi modularitas.

---

## 25. Configuration

Tambahkan konfigurasi minimal yang benar-benar berguna.

Minimal:

```text
keyboard shortcut
search engine
enable/disable web search
enable/disable file search
file search locations
result limits
```

Opsional:

```text
debounce duration
show recent searches
```

Jangan membuat settings UI kompleks.

Default harus sudah masuk akal tanpa user perlu mengubah apa pun.

---

## 26. Cinnamon/GJS Compatibility

Sebelum implementasi:

1. Deteksi versi Cinnamon yang sedang digunakan.
2. Deteksi versi GJS/GI yang tersedia.
3. Gunakan API yang benar-benar tersedia di environment.
4. Jangan mengasumsikan API dari versi Cinnamon lain.
5. Jika API memiliki variasi antar versi, buat compatibility helper kecil.

Semua compatibility code harus memiliki alasan yang jelas.

Jangan membuat polyfill besar jika tidak diperlukan.

---

## 27. Applet Packaging & Installation

Pastikan hasil akhir benar-benar merupakan Cinnamon applet yang bisa dipasang.

Wajib memiliki metadata Cinnamon yang benar, termasuk:

```text
uuid
name
description
version
```

Gunakan UUID yang unik untuk applet baru.

Pastikan struktur instalasinya sesuai dengan Cinnamon.

Setelah implementasi:

```text
install applet
    ↓
Cinnamon mengenali applet
    ↓
applet dapat ditambahkan ke panel
    ↓
klik/shortcut membuka search
```

Agent harus menguji bukan hanya source code, tetapi juga **install/load/reload lifecycle**.

---

## 28. Testing Matrix

Selain functional testing normal, wajib test kondisi berikut:

### Search race

```text
query cepat berturut-turut:
f
fi
fir
fire
firefox
```

Pastikan hasil query lama tidak pernah menimpa query terbaru.

### Cancellation

Mulai file search besar, lalu segera ganti query.

Pastikan subprocess lama dihentikan atau setidaknya tidak lagi memengaruhi UI.

### Provider failure

Test:

```text
plocate unavailable
locate unavailable
find available
```

dan juga:

```text
web provider gagal
```

Local search harus tetap bekerja.

### Missing files

Cari file lalu hapus sebelum menekan Enter.

Applet tidak boleh crash.

### Duplicate results

Pastikan aplikasi/file yang sama hanya muncul satu kali.

### Applet removal

Tambahkan applet, gunakan search, lalu remove applet.

Pastikan tidak ada error dari callback/timeout/process lama.

### Repeated open/close

Buka-tutup overlay berkali-kali.

Pastikan tidak terjadi:

```text
memory leak
duplicate keybinding
duplicate callback
stale results
```

### Empty query

Query kosong harus cepat dan tidak memulai filesystem/web search.

### Long query

Query sangat panjang harus diproses dengan aman dan tidak menyebabkan command injection atau URL construction error.

### Special characters

Test:

```text
spaces
quotes
symbols
unicode
slashes
dots
hyphens
```

Pastikan argumen subprocess dibuat menggunakan argument array, bukan string shell mentah.

---

## 29. Security / Input Handling

Jangan pernah membuat command shell dari query user seperti:

```javascript
"find ... " + query
```

dan mengeksekusinya lewat shell.

Selalu gunakan argv/argument array:

```text
Gio.Subprocess({
    argv: [...]
})
```

Query user harus dianggap untrusted input.

Untuk URL:

```text
encodeURIComponent(query)
```

atau mekanisme URL encoding yang sesuai.

Calculator harus memakai parser/validator yang ketat dan tidak boleh memberikan kemampuan arbitrary code execution.

Jangan mengevaluasi input user secara bebas menggunakan `eval()` tanpa parser/whitelist expression yang ketat.

---

## 30. Implementation Order

Kerjakan bertahap:

### Phase 1 — Applet shell

Pastikan:

```text
applet muncul
click → search overlay
focus → search box
Esc → close
cleanup → tidak ada error
```

### Phase 2 — Application search

Implement:

```text
query → apps → ranking → deduplication → launch
```

### Phase 3 — File search

Implement:

```text
query
 ↓
provider detection
 ↓
plocate/locate/find
 ↓
async subprocess
 ↓
cancellation
 ↓
generation protection
 ↓
normalize
 ↓
deduplicate
 ↓
results
```

### Phase 4 — Calculator + URL

Implement local instant actions.

### Phase 5 — Web search

Implement web provider + browser fallback.

### Phase 6 — Ranking + result aggregation

Gabungkan seluruh provider.

### Phase 7 — Cache + recent searches

Tambahkan optimisasi setelah core functionality stabil.

### Phase 8 — Reliability pass

Sebelum dianggap selesai:

```text
cleanup
race-condition test
cancellation test
fallback test
provider failure test
installation/reload test
```

---

## 31. Performance Requirements

Target:

```text
Applet startup
→ ringan

Search input
→ tidak freeze Cinnamon

Application search
→ cepat

File search
→ asynchronous

Web search
→ asynchronous

Memory
→ rendah
```

Jangan melakukan recursive filesystem traversal dari JavaScript setiap query.

Jangan melakukan synchronous network request.

Jangan melakukan synchronous subprocess search.

Jangan merender terlalu banyak hasil sekaligus.

Utamakan first useful result secepat mungkin tanpa menunggu provider yang lambat.

---

## 32. Definition of Done

Project hanya dianggap selesai jika semua ini terpenuhi:

```text
[ ] Applet dapat di-install di Cinnamon
[ ] Applet dapat dibuka dengan mouse
[ ] Search box otomatis mendapat focus
[ ] Keyboard navigation bekerja
[ ] Application search bekerja
[ ] File search bekerja
[ ] plocate/locate/find fallback bekerja
[ ] File search async
[ ] Cancellation bekerja
[ ] Generation protection bekerja
[ ] Web search bekerja atau fallback browser tersedia
[ ] URL detection bekerja
[ ] Calculator bekerja aman
[ ] Result deduplication bekerja
[ ] Result ranking bekerja
[ ] Recent searches bekerja
[ ] Applet cleanup bekerja
[ ] Reopen/close berulang tidak menimbulkan error
[ ] Provider failure tidak mematikan provider lain
[ ] Tidak ada shell command injection dari query
[ ] Cinnamon tetap responsif selama search
```

Jangan menambahkan fitur besar baru sebelum semua item di atas stabil.

---

## 33. Project Structure

Buat struktur sederhana seperti:

```text
search-applet/
├── applet.js
├── searchEngine.js
├── providers/
│   ├── appProvider.js
│   ├── fileProvider.js
│   ├── webProvider.js
│   ├── calculatorProvider.js
│   └── urlProvider.js
├── result.js
├── utils.js
├── metadata.json
└── stylesheet.css
```

Jika implementasi ternyata lebih sederhana tanpa beberapa file tersebut, boleh disederhanakan.

**Jangan membuat file hanya demi terlihat modular.**

---

## 34. Development Process

Sebelum coding:

1. Inspect environment Cinnamon/GJS yang tersedia.
2. Inspect contoh applet Cinnamon yang sederhana jika diperlukan.
3. Tentukan API yang kompatibel dengan versi Cinnamon user.
4. Pastikan API yang dipakai memang tersedia.
5. Buat architecture sederhana.
6. Implement core search terlebih dahulu.
7. Baru implement UI.

Jangan langsung membuat UI kompleks.

---

## 35. Important Rule

**Jangan over-engineer.**

Kalau suatu masalah dapat diselesaikan dengan:

```text
20 baris
```

jangan membuat:

```text
200 baris abstraction
```

Prioritaskan solusi paling sederhana yang kompatibel dengan arsitektur Cinnamon.

---

## 36. Testing

Setelah implementasi, test minimal:

```text
firefox
chrome
terminal
```

→ application search.

```text
document
pdf
jpg
```

→ file search.

```text
2+2
100/5
(10+5)*2
```

→ calculator.

```text
github.com
https://github.com
```

→ URL.

```text
latest linux mint
```

→ web search.

Test juga:

```text
ketik cepat
```

untuk memastikan stale async results tidak muncul.

Test:

```text
plocate tersedia
plocate tidak tersedia
locate tersedia
hanya find tersedia
```

dan pastikan fallback bekerja.

---

## 37. Final Requirement

Jangan mencoba mereplikasi WinSearch.

Buat **produk baru yang lebih kecil** dengan filosofi:

```text
                    SEARCH
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
      LOCAL           WEB          INSTANT
        │              │              │
   ┌────┴────┐         │        ┌─────┴─────┐
   Apps     Files      Web      Calculator  URL
```

UI:

```text
                Search Box
                    ↓
             Search Results
```

Core philosophy:

> **One search box, multiple lightweight providers, asynchronous execution, simple ranking, minimal dependencies.**

Sebelum menyelesaikan pekerjaan, pastikan applet benar-benar dapat di-install dan dijalankan di Cinnamon tanpa error JavaScript/GJS.

Jika ada pilihan antara fitur tambahan dan kestabilan core search, **pilih kestabilan core search**.
