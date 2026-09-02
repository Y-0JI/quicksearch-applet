# QuickSearch AI Search — Phase AI-4
## UI Integration: Normal Search + AI Search dalam Satu Searchbox

**Project:** QuickSearch Cinnamon Applet  
**Status sebelum phase:** AI-3B FINAL PASS  
**Scope phase:** Integrasi UI AI Search ke overlay QuickSearch yang sudah ada  
**Prinsip utama:** Searchbox utama tidak diganti. Normal Search tetap bekerja seperti sekarang. AI Search menjadi mode tambahan di dalam searchbox/overlay yang sama.

---

# 1. Tujuan Phase AI-4

Phase AI-1 sampai AI-3B telah membangun fondasi AI secara terpisah:

```text
AI Provider Layer
      ↓
9router Provider
      ↓
AI Search Engine
      ↓
Grounding / Web Search Tool
      ↓
Single-Round Orchestration
      ↓
Cancellation + Stale Guards
      ↓
Regression Tests
```

Phase AI-4 mulai menghubungkan fondasi tersebut ke UI QuickSearch.

Target akhirnya:

```text
┌──────────────────────────────────────────────┐
│ Search...                           [ AI ]   │
└──────────────────────────────────────────────┘
                 ↓ klik / toggle
┌──────────────────────────────────────────────┐
│ Ask AI...                           [ Search]│
└──────────────────────────────────────────────┘
```

Namun ini **bukan membuat dua popup** dan **bukan mengganti searchbox QuickSearch yang sekarang**.

Satu overlay tetap dipakai.

---

# 2. Prinsip UI Utama

## 2.1 Satu Searchbox / Satu Overlay

Tetap gunakan:

- overlay QuickSearch saat ini
- search entry saat ini
- lifecycle open / close saat ini
- global hotkey saat ini
- keyboard navigation saat ini

Jangan membuat:

- popup AI kedua
- window terpisah
- modal dialog baru
- applet baru

Struktur:

```text
QuickSearch Overlay
│
├── Search Entry
│   └── mode-aware placeholder
│
├── Normal Search Results
│   └── existing result flow
│
└── AI Search Response Area
    └── hanya aktif saat AI mode
```

---

# 3. Search Mode

Phase AI-4 memperkenalkan dua mode eksplisit.

## Mode A — Normal Search

Mode default.

Flow tidak berubah:

```text
User query
    ↓
Existing Search Engine
    ↓
calc / url / app / file / web
    ↓
Existing grouped results
```

Semua behavior Search-only existing harus tetap kompatibel.

## Mode B — AI Search

AI mode hanya mengubah jalur submit/query.

```text
User query
    ↓
AI Search Engine
    ↓
Provider #1
    ├── direct answer
    │
    └── web_search tool
             ↓
        WebSearchTool
             ↓
        Provider #2
             ↓
        grounded answer
```

UI tidak boleh mengimplementasikan ulang logic grounding.

UI hanya:

```text
send query
receive loading
receive answer/error
render
```

---

# 4. Mode Toggle

## 4.1 Scope

Tambahkan control kecil untuk berpindah mode di dalam area searchbox yang sudah ada.

Konsep:

```text
┌──────────────────────────────────────────────┐
│ Search...                           ✦ AI     │
└──────────────────────────────────────────────┘
```

Saat AI aktif:

```text
┌──────────────────────────────────────────────┐
│ Ask AI...                        ✦ AI ACTIVE │
└──────────────────────────────────────────────┘
```

Implementasi visual final boleh menyesuaikan Cinnamon/St.Widget existing, tetapi jangan memperbesar atau merombak layout overlay secara drastis.

## 4.2 State

Gunakan state eksplisit:

```js
this._searchMode = 'normal';
```

Allowed values:

```text
normal
ai
```

Jangan gunakan:

```text
isAI
isNormal
aiEnabled
showAI
```

yang berpotensi menghasilkan state ambigu.

## 4.3 Default

Setiap overlay dibuka:

```text
default → normal
```

AI mode tidak harus dipersist di Phase AI-4.

Alasan:

- menghindari user membuka QuickSearch lalu tidak sadar masih berada di AI mode
- mode default existing tetap Search
- persistence dapat dievaluasi pada phase polish/settings

---

# 5. Placeholder Behavior

Mode normal:

```text
Search...
```

Mode AI:

```text
Ask AI...
```

Placeholder harus berubah berdasarkan `_searchMode`.

Tidak boleh membuat entry kedua.

---

# 6. Mode Switching Behavior

Saat user berpindah mode:

```text
normal → ai
```

harus:

1. Cancel normal async search jika ada
2. Clear current normal results
3. Reset keyboard selection
4. Clear AI response area lama
5. Entry tetap fokus
6. Placeholder berubah

Saat:

```text
ai → normal
```

harus:

1. Cancel active AI request
2. Hide/clear AI response area
3. Reset selection
4. Entry tetap fokus
5. Placeholder kembali `Search...`
6. Normal Search Engine siap menerima query berikutnya

Tidak boleh ada hasil dari mode lama muncul setelah mode baru aktif.

Contoh bug yang harus dicegah:

```text
AI mode
Query A pending
      ↓
switch normal
      ↓
AI callback A datang
      ↓
AI answer muncul di Normal Search
```

Harus dicegah melalui:

- existing AI cancel
- existing stale generation guard
- UI mode guard

---

# 7. AI Query Submission

## 7.1 Jangan auto-send setiap keystroke

Normal Search saat ini dapat menggunakan debounce/live search.

AI Search pada Phase AI-4 **tidak boleh mengirim request provider setiap keystroke**.

AI request hanya dimulai saat explicit submit.

Primary trigger:

```text
Enter
```

Optional UI trigger boleh ditambahkan nanti, tetapi tidak wajib di AI-4.

Flow:

```text
AI mode
User mengetik
    ↓
tidak ada request
    ↓
Enter
    ↓
aiSearchEngine.search(query)
```

Ini penting untuk:

- API cost
- rate limit
- menghindari cancellation request beruntun
- menjaga UX

---

# 8. Enter Behavior

## Normal Mode

Pertahankan behavior existing.

Misalnya:

```text
selected result → activate
no selection → Best Match
```

Jangan ubah ranking atau behavior P1 yang sudah diperbaiki.

## AI Mode

Enter harus:

```text
non-empty query
    ↓
submit AI request
```

Jika query kosong:

```text
jangan kirim request
```

Tidak boleh:

```text
Enter AI mode
→ activate normal result lama
```

---

# 9. AI Response UI

Tambahkan area response di overlay yang sama.

State minimum:

```text
idle
loading
answer
error
```

Tidak perlu membuat state machine kompleks di UI jika engine sudah menangani orchestration.

## 9.1 Idle

Tidak ada AI request aktif.

Area AI dapat hidden atau menampilkan empty state ringan.

## 9.2 Loading

Setelah Enter:

```text
Ask AI...
      ↓
Loading
```

Gunakan indicator sederhana dan native-friendly.

Contoh:

```text
Thinking...
Searching...
```

Jangan membuat fake progress percentage.

UI tidak boleh mengklaim provider sedang melakukan web search jika sebenarnya belum diketahui dari callback engine.

Jika engine belum mengirim status granular, gunakan generic:

```text
Thinking...
```

## 9.3 Answer

Jawaban AI ditampilkan sebagai text content.

Phase AI-4 fokus:

- plain text
- multi-line support
- scroll jika jawaban panjang

Belum wajib:

- Markdown renderer penuh
- clickable citation UI
- code syntax highlighting
- source cards

Jangan memaksakan fitur tersebut ke AI-4.

## 9.4 Error

Error harus user-friendly.

Jangan menampilkan:

```text
raw stack trace
raw JSON
API key
Authorization header
```

Gunakan error boundary yang sudah disediakan AI layer.

Contoh konsep:

```text
Unable to get an AI response.
```

Detail internal tetap untuk log/debug, bukan UI user.

---

# 10. AI Result Model

UI harus memakai boundary response yang stabil.

Jangan membuat `applet.js` memahami:

- provider-specific payload
- OpenAI response shape
- tool_call internals
- 9router response details

UI idealnya menerima hasil yang sudah dinormalisasi oleh AI layer.

Contoh conceptual callback:

```js
onUpdate({
    type: 'loading'
});
```

```js
onUpdate({
    type: 'answer',
    text: '...'
});
```

```js
onUpdate({
    type: 'error',
    error: ...
});
```

Exact API harus mengikuti existing AI Search Engine architecture. Jangan membuat adapter kedua jika callback/result boundary yang sudah ada cukup.

---

# 11. Engine Ownership

`applet.js` boleh memiliki AI engine instance, tetapi UI tidak boleh mengimplementasikan AI orchestration.

Konsep:

```text
Applet
│
├── normal SearchEngine
│
└── AISearchEngine
       │
       ├── AIProvider
       └── WebSearchTool
```

Jangan:

```text
applet.js
  ├── call provider #1
  ├── parse tool_call
  ├── call web search
  └── call provider #2
```

Semua itu tetap milik:

```text
ai/aiSearchEngine.js
```

---

# 12. Lifecycle Integration

## 12.1 Overlay Close

Saat overlay ditutup:

```text
aiSearchEngine.cancel()
```

harus dipanggil.

Kemudian:

- clear loading UI
- reset temporary AI response
- prevent late delivery

## 12.2 Applet Destroy

Saat applet dihapus/reload:

```text
aiSearchEngine.destroy()
```

atau lifecycle equivalent yang sudah tersedia harus dipanggil.

Tidak boleh meninggalkan:

- active request
- callback ke destroyed actor
- timer baru yang tidak dibersihkan

Gunakan lifecycle existing AI engine, jangan duplicate cancellation mechanism di applet.

---

# 13. Normal Search Isolation

AI mode tidak boleh merusak:

```text
app search
file search
calculator
URL
web search
Best Match
keyboard navigation
context actions
file/app actions
```

Saat mode normal:

```text
AI engine tidak boleh dipanggil
```

Saat mode AI:

```text
normal provider search tidak boleh menjalankan query baru dari AI input
```

---

# 14. Keyboard Scope

## Normal Mode

Existing:

```text
Up
Down
Enter
Escape
```

behavior tetap.

## AI Mode

Minimum:

```text
Enter  → submit AI query
Escape → close existing overlay behavior
```

Up/Down tidak boleh menyebabkan crash ketika AI answer area aktif.

Jika AI response belum memiliki interactive rows:

```text
Up/Down dapat tetap no-op
```

Jangan memaksakan keyboard navigation AI answer pada AI-4.

---

# 15. UI Rendering Safety

AI callback dapat datang setelah:

- overlay ditutup
- mode berubah
- query baru dikirim
- applet destroyed

Sebelum render AI update, UI harus memastikan request masih relevan.

Engine stale guard adalah primary protection.

UI juga harus memastikan:

```text
current mode === ai
```

sebelum menampilkan AI-specific update.

Jangan mengandalkan hanya visibility actor.

---

# 16. Error Boundary

Phase AI-4 harus memastikan UI tidak crash jika:

- AI engine unavailable
- provider error
- web grounding error
- invalid response
- actor sudah destroyed

Expected:

```text
AI request error
    ↓
UI tetap hidup
    ↓
Searchbox tetap bisa digunakan
    ↓
User dapat switch ke Normal Search
```

Normal Search harus tetap berfungsi setelah AI error.

---

# 17. Files Expected to Change

Primary:

```text
applet.js
stylesheet.css
```

Possible if required for clean UI abstraction:

```text
ai/aiSearchEngine.js
```

Tetapi jangan mengubah AI orchestration hanya untuk UI.

Possible tests:

```text
tests/ai-ui-integration.test.js
```

atau focused extension dari existing applet/UI test setup jika sudah ada infrastructure yang lebih cocok.

Do not modify unrelated:

```text
providers/appProvider.js
providers/fileProvider.js
providers/webProvider.js
searchEngine.js
result.js
```

kecuali ditemukan regression nyata.

---

# 18. Tests Required

## A. Default Mode

Assert:

```text
overlay open
→ mode normal
→ placeholder Search...
```

## B. Toggle to AI

Assert:

```text
normal → ai
→ placeholder Ask AI...
→ entry remains focused
```

## C. Toggle Back

Assert:

```text
ai → normal
→ active AI request cancelled
→ AI UI cleared
→ normal placeholder restored
```

## D. AI Does Not Auto Query

Assert:

```text
AI mode
typing
→ provider call count 0
```

## E. AI Enter Submit

Assert:

```text
AI mode
non-empty query
Enter
→ aiSearchEngine invoked exactly once
```

## F. Empty AI Enter

Assert:

```text
AI mode
empty query
Enter
→ provider call count 0
```

## G. Normal Mode Isolation

Assert:

```text
normal mode query
→ existing SearchEngine path
→ AI engine 0 calls
```

## H. Loading → Answer

Assert:

```text
submit
→ loading visible
→ answer callback
→ answer rendered
→ loading removed
```

## I. Error

Assert:

```text
submit
→ error callback
→ safe error UI
→ overlay remains usable
```

## J. Mode Switch During AI Request

Assert:

```text
AI request pending
→ switch normal
→ late AI callback
→ answer NOT rendered
```

## K. Close During AI Request

Assert:

```text
AI request pending
→ close overlay
→ cancel called
→ late callback ignored
```

---

# 19. Manual Verification

## Normal Search Regression

Test:

```text
calculator
URL
application
file
web search
```

Semua harus tetap bekerja.

## AI Mode

Test:

```text
toggle AI
→ Ask AI...
```

Ketik:

```text
What is Linux Mint?
```

Pastikan:

```text
typing ≠ API request
Enter = API request
loading appears
answer appears
```

## Switch Safety

```text
submit AI query
immediately switch normal
```

Pastikan AI answer lama tidak muncul.

## Close Safety

```text
submit AI query
close overlay
wait
```

Pastikan tidak ada crash atau popup UI lama muncul kembali.

---

# 20. Non-Goals AI-4

Jangan implementasikan pada phase ini:

```text
multi-turn conversation
chat history
conversation persistence
Markdown renderer penuh
source/citation cards
clickable web citations
streaming tokens
system command execution
computer control
screen capture
agent loop
multi-round tool calling
model selector UI
settings redesign
```

AI-4 hanya:

```text
Existing QuickSearch UI
        +
Mode Toggle
        +
AI Query Submit
        +
Loading / Answer / Error UI
        +
Lifecycle Safety
```

---

# 21. Acceptance Gate

AI-4 PASS jika:

```text
✓ Satu overlay tetap digunakan
✓ Satu search entry tetap digunakan
✓ Default tetap Normal Search
✓ AI mode dapat di-toggle di dalam searchbox UI
✓ Placeholder berubah sesuai mode
✓ AI tidak request setiap keystroke
✓ Enter di AI mode mengirim query
✓ Empty query tidak mengirim request
✓ Normal mode tidak memanggil AI
✓ AI mode tidak memulai normal live search
✓ Loading state aman
✓ Answer state aman
✓ Error state aman
✓ Switch AI → Normal membatalkan request aktif
✓ Close overlay membatalkan request aktif
✓ Late callback tidak merender pada mode normal
✓ Normal Search regression tidak terjadi
✓ AI orchestration tetap berada di aiSearchEngine
✓ Full test suite tetap hijau
```

---

# 22. Final Phase AI-4 Flow

```text
                QUICKSEARCH OVERLAY
                        │
                        ▼
                ┌───────────────┐
                │  Search Entry │
                │               │
                │ Normal / AI   │
                └───────┬───────┘
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
         NORMAL MODE           AI MODE
              │                   │
              ▼                   ▼
        SearchEngine        AISearchEngine
              │                   │
              ▼                   ▼
     Existing Results      Loading / Answer
                                 │
                                 ▼
                         Existing AI-3B
                         Grounding Pipeline
```

---

# 23. Next Step After AI-4

Setelah AI-4 stabil, phase berikutnya dapat fokus pada peningkatan AI response UX, misalnya:

```text
AI-5
AI Response Presentation

- streaming jika provider architecture mendukung
- Markdown/plain rich rendering
- source presentation
- copy action
- retry action
```

Tetapi jangan mulai AI-5 sebelum AI-4 UI integration dan Normal Search regression sudah lolos Final Gate.
