# QUICKSEARCH — AI ORCHESTRATION & NATURAL RESPONSE PHASE

## Purpose

Dokumen referensi dan instruksi implementasi untuk AI agent.

Phase ini berfokus pada peningkatan AI orchestration, kualitas jawaban, context handling, conversation memory, dan penggunaan hasil Web Search sebagai evidence.

> Prioritas utama: perbaiki cara QuickSearch memahami konteks dan menghasilkan jawaban sebelum menambah fitur AI action/execution baru.

---

# 1. OBJECTIVE

QuickSearch sudah memiliki fondasi:

- Search mode
- AI mode
- Web Search
- Follow-up conversation
- Multi-turn conversation
- Sources UI
- Copy / Edit
- Error-only Resend
- Lifecycle / cancel handling

Masalah yang ingin diselesaikan:

- Jawaban terasa seperti hasil scraping atau data dump.
- AI terlalu kaku dan literal.
- Hasil Web Search dapat ditempel mentah ke jawaban.
- Follow-up belum tentu memanfaatkan context secara optimal.
- Context perlu dikontrol agar tidak terus membesar.
- Parameter model belum tentu cocok untuk semua jenis pertanyaan.
- Current date/time perlu tersedia untuk pertanyaan yang bergantung waktu.

Target akhir:

> QuickSearch harus terasa seperti AI assistant yang memahami pertanyaan, memahami percakapan sebelumnya, menggunakan Web Search sebagai evidence, lalu menjelaskan hasil dengan bahasa natural.

---

# 2. NON-GOALS

Phase ini bukan untuk:

- Redesign UI besar.
- Mengubah arsitektur Search provider yang sudah PASS tanpa alasan.
- Menambah kemampuan AI menjalankan aplikasi.
- Menambah shell execution baru.
- Mengubah security boundary yang sudah ada.
- Menghapus fitur yang sudah lolos regression.

Fokus phase ini adalah AI orchestration dan response quality.

---

# 3. TARGET ARCHITECTURE

Alur lama secara konseptual:

```text
User
  ↓
Web Search
  ↓
Raw Search Results
  ↓
AI
  ↓
Answer
```

Target:

```text
User Question
      ↓
Conversation Context
      ↓
Mode Detection
      ↓
Current Context Injection
      ↓
Web Search (jika diperlukan)
      ↓
Search Result Filtering / Ranking
      ↓
Prompt Construction
      ↓
AI Answer Generation
      ↓
Natural Response
      ↓
Source Mapping
      ↓
Existing Sources UI
```

Prinsip:

> AI tidak boleh memperlakukan raw search results sebagai jawaban final.

Search result adalah:

```text
evidence / reference material
```

bukan:

```text
final answer template
```

---

# 4. P1 — SYSTEM PROMPT / AI PERSONA

Semua request AI harus memiliki system-level instruction yang konsisten.

AI harus memahami dirinya sebagai:

- QuickSearch AI
- Desktop assistant
- Natural conversational assistant
- Context-aware assistant
- Factual when evidence is available
- Clear and concise by default

## Behavioral requirements

AI harus:

1. Menjawab langsung inti pertanyaan.
2. Menggunakan bahasa natural.
3. Tidak terdengar seperti search engine.
4. Tidak menyalin raw search snippets secara mentah.
5. Menjelaskan informasi penting dalam kalimat yang mudah dibaca.
6. Memahami follow-up berdasarkan conversation context.
7. Menyesuaikan panjang jawaban dengan kompleksitas pertanyaan.
8. Mengakui ketidakpastian jika evidence tidak cukup.
9. Tidak mengarang fakta yang tidak didukung context atau search evidence.

## Avoid

Jangan menghasilkan pola seperti:

```text
Harga: X
Open: X
High: X
Low: X
Volume: X
```

jika user tidak secara eksplisit meminta data mentah.

Lebih baik:

```text
Harga saat ini berada di sekitar X. Sepanjang perdagangan hari ini,
pergerakannya berada dalam rentang Y–Z. Untuk arah jangka pendek,
volume dan sentimen pasar masih perlu diperhatikan.
```

Data mentah tetap boleh digunakan jika user meminta:

- tabel
- angka lengkap
- statistik
- raw data
- ringkasan teknikal
- daftar

---

# 5. P1 — NATURAL RESPONSE SYNTHESIS

## Core rule

Raw evidence harus terlebih dahulu dipahami, lalu disintesis:

```text
Search snippets
      ↓
Fact extraction
      ↓
Relevance selection
      ↓
Natural synthesis
      ↓
Final answer
```

Bukan:

```text
Search snippets
      ↓
Copy into answer
```

## Response style

Default:

- Direct
- Natural
- Clear
- Helpful
- Not overly formal
- Not robotic
- Not unnecessarily verbose

## Adaptive answer length

### Simple factual question

Jawaban singkat dan langsung.

### Informational question

Ringkasan + penyebab utama + dampak bila relevan.

### Complex analysis

Penjelasan lebih terstruktur dengan reasoning yang jelas.

Jangan membuat semua pertanyaan memiliki panjang jawaban yang sama.

---

# 6. P2 — DYNAMIC CONTEXT INJECTION

Setiap AI request harus dapat menerima runtime context yang relevan.

Minimal:

- Current date
- Current time
- Timezone
- Current mode
- Whether Web Search was used

Contoh:

```text
Current date: 4 September 2026
Current time: 15:30
Timezone: Asia/Jakarta

Current mode: Web Search
```

Tujuannya membantu AI memahami:

- hari ini
- besok
- minggu ini
- terbaru
- malam ini
- sekarang

## Important rule

Context injection harus:

- Dinamis.
- Dibuat saat request.
- Tidak di-hardcode.
- Tidak mengubah message history yang tersimpan.

Runtime metadata harus dibedakan dari actual user conversation.

---

# 7. P2 — CONVERSATION MEMORY

Follow-up harus memahami percakapan sebelumnya.

Contoh:

```text
User:
Siapa pemain Chelsea sekarang?

Assistant:
...

User:
Nomor punggungnya?
```

AI harus menggunakan conversation context untuk memahami referensi pertanyaan terbaru.

Recommended structure:

```text
system

runtime context

user message 1
assistant message 1

user message 2
assistant message 2

current user message
```

History:

- Harus mempertahankan urutan.
- Tidak boleh memasukkan orphan messages.
- Tidak boleh memasukkan cancelled partial response sebagai completed assistant turn.
- Tidak boleh memasukkan failed request sebagai assistant success response.

Gunakan lifecycle rules yang sudah ada.

---

# 8. P2 — CONTEXT WINDOW MANAGER

Jangan mengirim seluruh history tanpa batas.

Buat context manager yang:

1. Memprioritaskan recent conversation.
2. Menjaga system instruction.
3. Menjaga runtime context.
4. Menghapus turn lama ketika limit context tercapai.
5. Tidak memotong struktur message secara sembarangan.

Target awal:

```text
System prompt
+ runtime context
+ recent complete conversation turns
+ current user message
```

Jangan:

- Memotong current user message.
- Menyisakan orphan assistant message.
- Merusak pasangan user/assistant saat trimming.

---

# 9. P3 — WEB SEARCH ORCHESTRATION

Web Search harus diposisikan sebagai evidence pipeline:

```text
User question
      ↓
Search query
      ↓
Provider results
      ↓
Deduplicate
      ↓
Ranking
      ↓
Relevant evidence
      ↓
AI synthesis
```

Gunakan ranking/dedupe logic yang sudah PASS jika tersedia.

AI harus menerima evidence yang:

- Relevan.
- Tidak terlalu banyak.
- Tidak duplicate.
- Memiliki source metadata.

Jangan membanjiri AI dengan semua result jika hanya beberapa yang relevan.

---

# 10. P3 — SOURCE / ANSWER SEPARATION

Final AI answer dan source data harus tetap dipisahkan:

```text
AI Answer
+
Source metadata
```

Bukan:

```text
AI Answer penuh URL mentah
```

atau:

```text
Search snippets sebagai UI answer
```

Source harus tetap kompatibel dengan minimal Sources UI yang sudah dibuat.

Jika existing UI menggunakan:

```text
Sources · N
```

phase ini tidak perlu redesign UI.

Pastikan:

- Source count akurat.
- Source hanya dari request aktif.
- Source tidak bocor dari request sebelumnya.
- Source mapping sesuai answer.
- Popup source tetap dapat membuka daftar link evidence.

---

# 11. P4 — MODEL PARAMETER STRATEGY

Jangan memaksakan satu parameter untuk semua request.

## AI conversational mode

Target:

```text
Lebih natural
Lebih fleksibel
Lebih conversational
```

## Web Search factual mode

Target:

```text
Lebih stabil
Lebih factual
Lebih grounded pada evidence
```

Temperature atau parameter ekuivalen dapat berbeda menurut mode.

Jangan hardcode parameter tanpa mempertimbangkan provider/model compatibility.

Konfigurasi harus:

- Memiliki default.
- Bisa ditimpa jika model/provider mendukung.
- Tidak menyebabkan request gagal pada provider tertentu.

---

# 12. P4 — RESPONSE LENGTH / TOKEN BUDGET

Audit:

- max output token / equivalent provider limit
- provider-specific output settings
- streaming completion handling
- stop/cancel behavior

Pastikan normal response dapat selesai lengkap.

Cancelled response tidak boleh dianggap completed answer.

Jika provider memiliki perbedaan parameter, abstraction layer harus menanganinya.

---

# 13. PROMPT CONSTRUCTION ORDER

Recommended order:

```text
1. System identity and behavior
2. Runtime context
3. Mode-specific instruction
4. Search evidence (if available)
5. Conversation history
6. Current user message
```

Current user message harus tetap jelas sebagai message terbaru.

## Web Search instruction

```text
Use the supplied search evidence as reference material.
Do not copy snippets verbatim as the final answer.
Synthesize the relevant facts into a natural response.
If the evidence is incomplete or conflicting, state that clearly.
Do not invent unsupported details.
```

## AI mode instruction

```text
Answer naturally and directly.
Use conversation context when relevant.
Do not unnecessarily repeat previous information.
Match the response length to the user's question.
```

---

# 14. PRESERVE EXISTING FEATURES

Phase ini tidak boleh merusak:

- First message
- Follow-up
- Multi-turn conversation
- Copy
- Edit
- Error-only Resend
- Cancel
- New Chat
- Sources
- Search mode
- AI mode
- Mode switching
- Request lifecycle
- Streaming
- Existing provider isolation

---

# 15. IMPLEMENTATION RULES

## Rule A — Minimal surface change

Jangan rewrite seluruh applet hanya untuk phase ini.

Prefer:

```text
existing architecture
+ orchestration layer
+ context manager
+ prompt builder
```

daripada:

```text
full rewrite
```

## Rule B — Single responsibility

Pisahkan tanggung jawab:

```text
buildRuntimeContext()
buildSystemPrompt()
buildConversationContext()
prepareSearchEvidence()
buildAiRequest()
```

Jangan membuat satu fungsi besar yang menangani UI, history, prompt, web result, provider payload, dan lifecycle sekaligus.

## Rule C — Provider compatibility

Provider adapter bertanggung jawab atas:

- provider URL
- auth
- provider payload
- provider-specific parameters

Orchestration layer bertanggung jawab atas:

- semantic messages
- context
- evidence
- response strategy

---

# 16. REQUIRED TEST MATRIX

AI agent harus menambahkan atau memperbarui regression test untuk:

## Prompt

- System instruction included.
- Runtime context included.
- Current user message included.
- Search evidence included only when relevant.

## History

- First message has no fake history.
- Follow-up includes previous turn.
- Multi-turn ordering preserved.
- Cancelled request does not become completed history.
- Failed request does not become successful assistant history.
- History trimming preserves turn structure.

## Search

- Search evidence is deduplicated.
- Only relevant/top results are sent.
- Sources belong to active request.
- Previous request sources do not leak.

## Response

- Normal response can use sufficient output budget.
- Provider parameter differences are respected.
- AI mode and Web Search mode can use different strategies.

## Regression

Run:

```text
syntax checks
unit tests
search/provider regression
AI lifecycle regression
security/runtime scan
```

Do not claim PASS unless commands were actually executed.

---

# 17. MANUAL TEST CHECKLIST

## Natural answer

1. Ask a simple factual question.
2. Confirm answer is direct.
3. Confirm answer is not unnecessarily long.

## Informational answer

1. Ask "kenapa harga RAM naik?"
2. Confirm answer explains cause naturally.
3. Confirm raw snippets are not copied as answer.

## Web Search

1. Ask a current-information question.
2. Confirm search evidence is used.
3. Confirm answer synthesizes facts.
4. Open Sources.
5. Confirm source links match the request.

## Follow-up

1. Ask initial question.
2. Ask a follow-up with pronoun/reference.
3. Confirm previous context is understood.

## Context

Test:

- hari ini
- sekarang
- terbaru
- besok

Confirm current runtime context is available to AI.

## Long response

1. Ask a question requiring a longer answer.
2. Confirm response is not prematurely truncated.
3. Confirm completion is handled correctly.

## Cancel

1. Start a long AI response.
2. Cancel.
3. Confirm partial/cancelled response does not corrupt future follow-up context.

---

# 18. ACCEPTANCE CRITERIA

Phase PASS jika:

## A. Naturalness

Jawaban:

- Tidak terasa seperti raw search dump.
- Lebih conversational.
- Lebih mudah dibaca.
- Tetap factual.

## B. Context

AI dapat:

- Memahami follow-up.
- Memahami recent conversation.
- Memiliki current date/time context.

## C. Web grounding

Web Search:

- Digunakan sebagai evidence.
- Tidak ditempel mentah.
- Tidak mencampur sources antar request.

## D. Stability

Tidak ada regression pada:

- AI/Search mode
- Follow-up
- Cancel
- Copy/Edit/Resend
- Sources
- New Chat
- Streaming

## E. Testing

- Syntax PASS.
- Relevant tests PASS.
- Existing regression tetap PASS.
- No unverified PASS claims.

---

# 19. RECOMMENDED IMPLEMENTATION ORDER

## Step 1 — Audit existing AI request flow

Trace:

```text
user input
→ mode decision
→ history creation
→ search
→ provider request
→ streaming
→ final answer
→ source attachment
```

Do not modify before identifying current ownership.

## Step 2 — Add prompt builder

Dedicated semantic prompt/message construction layer:

- System instruction
- Runtime context
- Mode instruction
- History
- Search evidence
- Current message

## Step 3 — Add context window manager

Implement history selection/trimming while preserving turn structure.

## Step 4 — Add search evidence preparation

Reuse existing ranking/dedupe logic.

Prepare a compact evidence set for AI.

## Step 5 — Add mode-specific generation strategy

Differentiate:

```text
AI mode
Web Search mode
```

without breaking provider abstraction.

## Step 6 — Verify output length

Audit output limits and provider compatibility.

## Step 7 — Regression + manual tests

Run automated checks first, then test:

- natural response
- follow-up
- current information
- cancel
- source mapping

---

# FINAL IMPLEMENTATION PRINCIPLE

QuickSearch should evolve from:

> Search results passed to an LLM.

into:

> A context-aware AI assistant that uses search results as evidence and produces a natural answer.

The key architectural separation is:

```text
UI
≠
AI orchestration
≠
Provider adapter
≠
Search evidence
```

Each layer should have one clear responsibility.

Do not sacrifice the existing PASS baseline for architectural cleanup that is not required by this phase.
