# NEXT PHASE --- AI ORCHESTRATION + NATURAL RESPONSE QUALITY

## TUJUAN

Sekarang fokus pada peningkatan **kualitas jawaban AI dan
orchestration**, bukan UI besar atau fitur eksekusi aplikasi.

QuickSearch saat ini sudah memiliki fondasi:

-   Search mode
-   AI mode
-   Web Search
-   Follow-up conversation
-   Multi-turn conversation
-   Sources UI
-   Copy
-   Edit
-   Error-only Resend
-   Cancel
-   New Chat
-   Streaming
-   Request lifecycle

Masalah utama yang ingin diperbaiki:

-   Jawaban AI masih terasa kaku.
-   Jawaban kadang seperti hasil search dump.
-   AI belum selalu menyusun informasi secara natural.
-   Follow-up perlu memastikan benar-benar memakai context sebelumnya.
-   History tidak boleh terus membesar tanpa kontrol.
-   Web Search harus menjadi **evidence**, bukan jawaban mentah.
-   Parameter AI perlu bisa berbeda antara AI conversation dan Web
    Search.
-   Jawaban panjang tidak boleh terpotong karena output budget/provider
    setting.

Target akhirnya:

> QuickSearch harus terasa seperti AI assistant yang memahami
> pertanyaan, memahami percakapan sebelumnya, menggunakan Web Search
> sebagai evidence, lalu menyusun jawaban natural seperti conversational
> AI.

Referensi utama implementasi phase ini adalah:

`QuickSearch-AI-Orchestration-Natural-Response-Phase.md`

------------------------------------------------------------------------

# ATURAN PENTING SEBELUM IMPLEMENTASI

## WAJIB

1.  Audit flow AI yang sekarang terlebih dahulu.
2.  Jangan langsung rewrite `applet.js`.
3.  Gunakan architecture existing jika masih bisa dipakai.
4.  Pisahkan orchestration dari UI dan provider adapter.
5.  Pertahankan semua baseline yang sudah PASS.
6.  Jangan mengubah fitur yang tidak berhubungan tanpa alasan.
7.  Jangan claim PASS tanpa menjalankan command test.

## JANGAN

-   Jangan redesign UI besar.
-   Jangan mengubah Search provider yang sudah PASS.
-   Jangan menambah shell execution.
-   Jangan menambah AI application execution.
-   Jangan menghapus lifecycle protection.
-   Jangan merusak Cancel.
-   Jangan merusak Copy/Edit/Resend.
-   Jangan membuat full rewrite hanya untuk prompt improvement.

------------------------------------------------------------------------

# P1 --- AUDIT AI REQUEST FLOW

Sebelum melakukan perubahan, trace seluruh flow saat ini:

``` text
User Input
→ Mode Detection
→ Conversation History
→ Web Search (jika digunakan)
→ Provider Request
→ Streaming
→ Final Answer
```

Cari dengan jelas:

-   Di mana request AI dibangun.
-   Di mana system prompt sekarang dibuat.
-   Bagaimana history disimpan.
-   Bagaimana follow-up mengambil history.
-   Bagaimana Web Search result dikirim ke AI.
-   Bagaimana source dipetakan ke request.
-   Bagaimana streaming menyelesaikan assistant turn.
-   Bagaimana cancel menangani partial response.
-   Bagaimana provider/model parameter diterapkan.

### Output audit sebelum perubahan

Agent harus bisa menjelaskan ownership saat ini:

``` text
UI ownership:
...

Conversation ownership:
...

AI orchestration ownership:
...

Web Search ownership:
...

Provider adapter ownership:
...

Lifecycle ownership:
...
```

Jangan mulai refactor besar sebelum ownership jelas.

------------------------------------------------------------------------

# P2 --- SYSTEM PROMPT / AI PERSONA

Buat atau rapikan layer khusus untuk **system-level instruction**.

AI harus memahami dirinya sebagai:

-   QuickSearch AI
-   Desktop assistant
-   Natural conversational assistant
-   Context-aware assistant
-   Factual jika evidence tersedia
-   Clear dan concise secara default

## Behavioral requirements

AI harus:

1.  Menjawab inti pertanyaan terlebih dahulu.
2.  Menggunakan bahasa natural.
3.  Tidak terdengar seperti search engine.
4.  Tidak menyalin snippet mentah.
5.  Tidak terdengar seperti dokumentasi mekanis.
6.  Menjelaskan informasi dalam kalimat yang nyaman dibaca.
7.  Memahami follow-up.
8.  Menyesuaikan panjang jawaban.
9.  Mengakui jika evidence tidak cukup.
10. Tidak mengarang fakta.

### Contoh yang harus dihindari

Jangan otomatis menjawab seperti:

``` text
Harga: X
Open: X
High: X
Low: X
Volume: X
```

kecuali user memang meminta raw data.

Lebih natural:

``` text
Harga saat ini berada di sekitar X. Sepanjang perdagangan hari ini,
pergerakannya berada dalam rentang Y–Z. Untuk arah jangka pendek,
volume dan sentimen pasar masih perlu diperhatikan.
```

------------------------------------------------------------------------

# P3 --- NATURAL RESPONSE SYNTHESIS

Pastikan AI memperlakukan hasil search sebagai **bahan referensi**.

Target pipeline:

``` text
Search Results
      ↓
Fact Extraction
      ↓
Relevance Selection
      ↓
Natural Synthesis
      ↓
Final Answer
```

Bukan:

``` text
Search Results
      ↓
Copy Snippet
      ↓
Answer
```

## Default response style

Jawaban harus:

-   Direct
-   Natural
-   Clear
-   Helpful
-   Conversational
-   Tidak terlalu formal
-   Tidak robotic
-   Tidak unnecessarily verbose

## Adaptive answer length

### Pertanyaan sederhana

Jawaban langsung dan singkat.

### Pertanyaan informasi

Gunakan:

``` text
Jawaban utama
+
Penyebab / konteks penting
+
Dampak jika relevan
```

### Pertanyaan kompleks

Gunakan struktur yang lebih jelas dan reasoning yang mudah diikuti.

Jangan membuat semua jawaban memiliki format dan panjang yang sama.

------------------------------------------------------------------------

# P4 --- DYNAMIC RUNTIME CONTEXT

Tambahkan runtime context builder.

Minimal context:

-   Current date
-   Current time
-   Timezone
-   Current mode
-   Whether Web Search was used

Contoh:

``` text
Current date: ...
Current time: ...
Timezone: Asia/Jakarta
Current mode: AI / Web Search
```

Tujuannya agar AI memahami:

-   hari ini
-   besok
-   minggu ini
-   terbaru
-   sekarang
-   malam ini

## RULE PENTING

Runtime context:

-   Dibuat saat request.
-   Tidak hardcode.
-   Tidak disimpan sebagai user message.
-   Tidak merusak conversation history.

Pisahkan:

``` text
Runtime Metadata
```

dari:

``` text
Actual Conversation History
```

------------------------------------------------------------------------

# P5 --- CONVERSATION MEMORY

Pastikan follow-up benar-benar menggunakan context sebelumnya.

Struktur target:

``` text
System Prompt

Runtime Context

User Message 1
Assistant Message 1

User Message 2
Assistant Message 2

Current User Message
```

History harus:

-   Menjaga urutan.
-   Tidak membuat orphan assistant turn.
-   Tidak memasukkan cancelled response sebagai completed assistant
    turn.
-   Tidak memasukkan failed request sebagai successful assistant turn.
-   Tidak mengubah lifecycle yang sudah PASS.

Contoh test:

``` text
User:
Siapa pemain Chelsea sekarang?

Assistant:
...

User:
Nomor punggungnya?
```

AI harus memahami referensi pertanyaan kedua tanpa user mengulang
konteks sebelumnya.

------------------------------------------------------------------------

# P6 --- CONTEXT WINDOW MANAGER

Jangan terus mengirim seluruh history tanpa batas.

Buat context manager dengan target:

``` text
System Prompt
+
Runtime Context
+
Recent Complete Conversation Turns
+
Current User Message
```

Prioritas:

1.  System prompt selalu ada.
2.  Runtime context selalu ada.
3.  Current user message tidak boleh dipotong.
4.  Recent conversation lebih diprioritaskan.
5.  Turn lama dapat dihapus jika context terlalu besar.

## JANGAN

-   Memotong current user message.
-   Menyisakan orphan assistant message.
-   Memotong pasangan user/assistant secara sembarangan.
-   Memasukkan failed/cancelled turn sebagai history normal.

------------------------------------------------------------------------

# P7 --- WEB SEARCH ORCHESTRATION

Web Search harus menjadi evidence pipeline:

``` text
User Question
      ↓
Search Query
      ↓
Provider Results
      ↓
Deduplicate
      ↓
Ranking
      ↓
Relevant Evidence
      ↓
AI Synthesis
```

Gunakan kembali ranking/dedupe logic yang sebelumnya sudah PASS.

Jangan membuat ulang logic yang sebenarnya sudah ada.

AI sebaiknya menerima evidence yang:

-   Relevan.
-   Tidak duplicate.
-   Tidak terlalu banyak.
-   Memiliki source metadata.

Jangan mengirim seluruh hasil search ke AI jika hanya beberapa result
yang benar-benar relevan.

------------------------------------------------------------------------

# P8 --- SOURCE / ANSWER SEPARATION

Pertahankan pemisahan:

``` text
AI Answer
+
Source Metadata
```

Jangan:

``` text
Raw URL dump
```

atau:

``` text
Search snippet sebagai answer
```

Sources UI existing tetap dipertahankan.

Format saat ini:

``` text
Sources · N
```

Phase ini tidak perlu redesign UI.

Pastikan:

-   Source count akurat.
-   Source hanya berasal dari request aktif.
-   Source request lama tidak bocor.
-   Source sesuai dengan evidence request.
-   Popup source tetap membuka daftar link yang benar.

------------------------------------------------------------------------

# P9 --- MODE-SPECIFIC GENERATION STRATEGY

Jangan memaksakan parameter yang sama untuk semua mode.

Pisahkan strategi:

## AI Mode

Target:

``` text
Natural
Conversational
Flexible
Context-aware
```

## Web Search Mode

Target:

``` text
Factual
Grounded
Stable
Evidence-aware
```

Parameter seperti:

-   temperature
-   output token budget
-   provider-specific settings

boleh berbeda antar mode jika provider mendukung.

## RULE

Jangan hardcode parameter yang membuat provider tertentu gagal.

Gunakan abstraction:

``` text
Default Strategy
        ↓
Provider Compatibility
        ↓
Provider Payload
```

------------------------------------------------------------------------

# P10 --- OUTPUT LENGTH / RESPONSE COMPLETENESS

Audit seluruh setting yang dapat menyebabkan jawaban terpotong:

-   max tokens
-   max output tokens
-   provider-specific output limits
-   streaming completion handling
-   stop behavior
-   cancel behavior

Target:

> Jawaban normal harus dapat selesai lengkap jika pertanyaan membutuhkan
> jawaban panjang.

Pastikan:

-   Normal completed response masuk history.
-   Cancelled response tidak dianggap completed.
-   Partial response tidak merusak follow-up context.
-   Provider-specific parameter ditangani oleh adapter.

------------------------------------------------------------------------

# P11 --- PROMPT BUILDER

Jangan membuat satu fungsi besar.

Target minimal separation:

``` text
buildSystemPrompt()

buildRuntimeContext()

buildConversationContext()

prepareSearchEvidence()

buildModeInstruction()

buildAiRequest()
```

## Recommended prompt order

``` text
1. System identity and behavior

2. Runtime context

3. Mode-specific instruction

4. Search evidence (if available)

5. Conversation history

6. Current user message
```

Current user message harus tetap menjadi message terbaru.

------------------------------------------------------------------------

# P12 --- WEB SEARCH INSTRUCTION

Untuk Web Search, gunakan instruksi semantic seperti:

``` text
Use the supplied search evidence as reference material.

Do not copy search snippets verbatim as the final answer.

Synthesize the relevant facts into a natural response.

If the evidence is incomplete or conflicting,
state that clearly.

Do not invent unsupported details.
```

Pastikan konsep ini diterapkan sesuai architecture existing, bukan
sekadar menempelkan teks tanpa audit flow.

------------------------------------------------------------------------

# P13 --- AI MODE INSTRUCTION

Untuk AI mode:

``` text
Answer naturally and directly.

Use conversation context when relevant.

Do not unnecessarily repeat previous information.

Match the response length to the user's question.
```

Target:

-   Tidak terlalu panjang untuk pertanyaan sederhana.
-   Tidak terlalu pendek untuk pertanyaan kompleks.
-   Tidak selalu menggunakan template yang sama.

------------------------------------------------------------------------

# P14 --- PRESERVE EXISTING BASELINE

Phase ini TIDAK BOLEH merusak:

-   First message
-   Follow-up
-   Multi-turn conversation
-   Copy
-   Edit
-   Error-only Resend
-   Cancel
-   New Chat
-   Sources
-   Search mode
-   AI mode
-   Mode switching
-   Request lifecycle
-   Streaming
-   Provider isolation

Ini wajib menjadi regression baseline.

------------------------------------------------------------------------

# P15 --- IMPLEMENTATION STYLE

Gunakan pendekatan:

``` text
Existing Architecture
+
Orchestration Layer
+
Context Manager
+
Prompt Builder
```

Bukan:

``` text
Full Rewrite
```

## Single responsibility

Pisahkan:

``` text
UI
≠
AI Orchestration
≠
Provider Adapter
≠
Search Evidence
```

Provider adapter bertanggung jawab:

-   Provider URL
-   Authentication
-   Provider payload
-   Provider-specific parameters

Orchestration bertanggung jawab:

-   Semantic messages
-   Runtime context
-   Conversation context
-   Search evidence
-   Response strategy

------------------------------------------------------------------------

# P16 --- REQUIRED REGRESSION TEST

Tambahkan/update test untuk:

## Prompt

-   System instruction included.
-   Runtime context included.
-   Current user message included.
-   Search evidence hanya saat relevan.

## History

-   First message tidak memiliki fake history.
-   Follow-up membawa previous turn.
-   Multi-turn order benar.
-   Cancelled request tidak menjadi completed assistant turn.
-   Failed request tidak menjadi successful assistant turn.
-   History trimming menjaga struktur turn.

## Search

-   Evidence deduplicated.
-   Hanya top/relevant result yang dikirim.
-   Sources milik active request.
-   Previous source tidak bocor.

## Response

-   Output budget cukup.
-   Provider parameter compatibility terjaga.
-   AI mode dan Web Search mode dapat memiliki strategy berbeda.

## Regression

Jalankan:

``` text
syntax checks
unit tests
search/provider regression
AI lifecycle regression
security/runtime scan
```

Jangan menulis PASS jika command belum benar-benar dijalankan.

------------------------------------------------------------------------

# P17 --- MANUAL TEST CHECKLIST

## Natural Answer

1.  Tanya pertanyaan sederhana.
2.  Pastikan jawaban langsung.
3.  Pastikan tidak terlalu panjang.
4.  Pastikan tidak robotic.

## Informational Answer

Tanya:

``` text
kenapa harga RAM naik?
```

Pastikan:

-   Menjelaskan penyebab.
-   Memberikan konteks.
-   Tidak menyalin raw snippet.

## Web Search

1.  Tanya informasi terbaru.
2.  Pastikan search digunakan.
3.  Pastikan evidence disintesis.
4.  Buka Sources.
5.  Pastikan source sesuai request.

## Follow-up

1.  Tanya pertanyaan awal.
2.  Tanya follow-up dengan referensi singkat.
3.  Pastikan context sebelumnya dipahami.

## Runtime Context

Test:

``` text
hari ini
sekarang
terbaru
besok
```

Pastikan context waktu tersedia.

## Long Response

1.  Tanya pertanyaan yang membutuhkan jawaban panjang.
2.  Pastikan tidak terpotong.
3.  Pastikan completion benar.

## Cancel

1.  Mulai request panjang.
2.  Cancel.
3.  Lakukan follow-up.
4.  Pastikan partial/cancelled response tidak merusak context.

------------------------------------------------------------------------

# FINAL ACCEPTANCE CRITERIA

Phase dinyatakan PASS jika:

## A. Naturalness

Jawaban:

-   Tidak seperti raw search dump.
-   Lebih conversational.
-   Lebih mudah dibaca.
-   Tidak kaku.
-   Tetap factual.

## B. Context

AI dapat:

-   Memahami follow-up.
-   Memahami recent conversation.
-   Memahami current date/time.

## C. Web Grounding

Web Search:

-   Digunakan sebagai evidence.
-   Tidak ditempel mentah.
-   Tidak mencampur source antar request.

## D. Stability

Tidak ada regression pada:

``` text
AI/Search mode
Follow-up
Cancel
Copy
Edit
Resend
Sources
New Chat
Streaming
```

## E. Testing

-   Syntax PASS.
-   Relevant tests PASS.
-   Existing regression PASS.
-   Tidak ada PASS claim tanpa bukti command.

------------------------------------------------------------------------

# IMPLEMENTATION ORDER

Kerjakan dengan urutan:

``` text
1. Audit existing AI request flow

2. Tambahkan / rapikan Prompt Builder

3. Tambahkan Runtime Context Builder

4. Tambahkan Conversation Context Manager

5. Tambahkan History Trimming

6. Rapikan Search Evidence Preparation

7. Tambahkan Mode-specific Generation Strategy

8. Audit Output Token / Response Length

9. Regression Test

10. Manual Test
```

------------------------------------------------------------------------

# FINAL INSTRUCTION UNTUK AGENT

> Jangan fokus pada perubahan UI. Prioritas phase ini adalah membuat
> QuickSearch berubah dari sistem yang sekadar mengirim hasil pencarian
> ke LLM menjadi AI assistant yang memahami konteks, memilih evidence
> relevan, dan menyusun jawaban natural.

> Gunakan perubahan seminimal mungkin terhadap baseline yang sudah PASS.
> Jangan full rewrite. Audit ownership terlebih dahulu, implementasikan
> layer orchestration secara terpisah, lalu jalankan regression lengkap
> setelah perubahan.

Referensi implementasi phase ini:

`QuickSearch-AI-Orchestration-Natural-Response-Phase.md`
