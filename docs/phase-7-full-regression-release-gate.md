# PHASE 7 — FULL REGRESSION & RELEASE GATE

## Status sebelum Phase 7

Phase 6 sekarang sudah mencapai checkpoint penting:

- AI request berhasil.
- AI Tool Call berhasil memanggil Web Search.
- Provider SearXNG berhasil digunakan.
- Web search berhasil mendapatkan hasil.
- Hasil berhasil diparse dan dinormalisasi.
- Grounding context berhasil dikirim kembali ke AI.
- AI berhasil menghasilkan jawaban berdasarkan hasil pencarian.
- Sources berhasil ditampilkan di UI.

Contoh flow yang sudah terbukti:

```text
User Query
    ↓
AI Request
    ↓
AI Tool Call
    ↓
Web Search Provider
    ↓
SearXNG
    ↓
Parse Results
    ↓
Normalize Results
    ↓
Grounding Context
    ↓
Second AI Request
    ↓
AI Answer
    ↓
Sources UI
```

Phase 7 bukan phase untuk menambah fitur besar.

Tujuan Phase 7 adalah memastikan seluruh fitur yang sudah dibangun dari Phase 1 sampai Phase 6 tetap bekerja bersama dan tidak memiliki regression sebelum melanjutkan ke phase pengembangan berikutnya.

---

# 1. FULL REGRESSION AUDIT

Lakukan audit seluruh production flow, bukan hanya AI Search.

Cakupan minimum:

- applet initialization
- settings loading
- search lifecycle
- application search
- file search
- URL search
- calculator search
- context actions
- AI request
- AI streaming
- AI cancellation
- AI error handling
- Web Search Tool
- provider loading
- SearXNG integration
- result parsing
- result normalization
- grounding context
- source rendering

Jangan melakukan refactor besar pada audit ini.

Tujuan utama:

```text
Find regression
→ identify root cause
→ minimal fix
→ regression test
```

---

# 2. AI SEARCH END-TO-END REGRESSION

Buat regression coverage untuk flow AI Search yang sekarang sudah berhasil.

Contract utama:

```text
User Query
→ AI detects search intent
→ AI requests web_search
→ provider initializes
→ search backend returns results
→ results parsed
→ results normalized
→ sources injected into grounding context
→ AI receives grounded context
→ final answer generated
→ sources displayed
```

Tambahkan test atau verification untuk:

## 2.1 Provider initialization

Pastikan:

```text
provider module resolved
provider imported
provider constructed
provider ready
```

Tidak boleh ada silent fallback yang membuat web search terlihat aktif padahal provider gagal dimuat.

## 2.2 HTTP response handling

Verifikasi:

- HTTP 200 JSON valid.
- HTTP 200 HTML valid.
- HTTP 403 ketika JSON diharapkan tetapi HTML fallback tersedia.
- invalid response.
- backend unavailable.
- connection refused.
- timeout.

Diagnostic harus menunjukkan stage yang tepat.

## 2.3 Search result parsing

Verifikasi:

```text
response
→ parser
→ parsed_results
```

Pastikan parser tidak menghasilkan silent empty result ketika fixture sebenarnya memiliki hasil.

## 2.4 Result normalization

Verifikasi:

```text
parsed_results > 0
→ normalized_results > 0
```

untuk hasil yang valid.

Pastikan compatibility Node test dan Cinnamon/GJS tetap terjaga.

## 2.5 Grounding handoff

Verifikasi bahwa hasil web search benar-benar masuk ke request AI berikutnya.

Contract:

```text
retrieved sources > 0
→ grounding context > 0
→ second AI request receives sources
```

Jangan hanya memastikan Sources UI muncul.

AI request kedua harus benar-benar menerima context hasil search.

## 2.6 Final answer

Verifikasi AI tidak hanya menampilkan raw source list.

Jawaban harus dapat menggunakan hasil pencarian sebagai grounding context.

---

# 3. REGRESSION TEST: AI NON-WEB FLOW

Web Search tidak boleh merusak AI normal.

Verifikasi query yang tidak membutuhkan web search:

```text
halo
buat ringkasan singkat
jelaskan konsep X
buatkan contoh
```

Expected:

```text
AI Request
→ no unnecessary web_search
→ normal streaming response
→ final answer
```

Web Search Tool tidak boleh dipanggil untuk setiap query.

---

# 4. CANCELLATION & RACE CONDITION REGRESSION

Audit seluruh asynchronous AI flow.

Scenario minimum:

## 4.1 Cancel during first AI request

```text
AI request
→ cancel
→ no late UI update
```

## 4.2 Cancel during web search

```text
AI tool call
→ web search in progress
→ cancel
→ request cleanup
→ no second AI request
```

## 4.3 Cancel during second grounded AI request

```text
web search completed
→ second AI request started
→ cancel
→ no late response overwrite
```

## 4.4 Rapid consecutive queries

```text
Query A
→ Query B
```

Pastikan hasil Query A tidak muncul setelah Query B menjadi request aktif.

---

# 5. ERROR DIAGNOSTIC REGRESSION

Pastikan setiap major failure memiliki stage yang spesifik.

Contoh kategori:

```text
ai_request
ai_stream
tool_call
web_search_init
web_search_request
web_search_parse
web_search_normalize
grounding
```

Error tidak boleh kembali menjadi:

```text
Stage: unknown
```

jika stage sebenarnya diketahui.

Untuk backend/provider error tampilkan informasi yang berguna:

```text
Stage
Backend/provider
HTTP status jika tersedia
Expected format
Actual format jika tersedia
Original error ringkas
```

Jangan expose secret, API key, atau request authorization header.

---

# 6. CINNAMON/GJS RUNTIME VERIFICATION

Karena sebagian bug sebelumnya muncul akibat perbedaan Node test dan runtime Cinnamon/GJS, lakukan verification nyata di runtime applet.

Minimal:

```text
npm/node tests pass
AND
runtime Cinnamon/GJS verification pass
```

Node test yang hijau sendiri tidak cukup menjadi release gate.

Verifikasi:

- module import
- async cancellation
- provider initialization
- URL handling
- HTTP request
- parser
- normalization
- UI update

---

# 7. FULL TEST SUITE

Jalankan:

```text
syntax check seluruh production JavaScript
full automated test suite
provider-specific tests
AI flow tests
web search tests
manual runtime verification
```

Tidak boleh memperbaiki test dengan menghapus assertion yang sebelumnya menemukan bug.

Jika test gagal:

```text
understand failure
→ fix production cause
→ keep regression coverage
```

---

# 8. SECURITY & CONFIGURATION REGRESSION

Audit agar perubahan AI/Web Search tidak menimbulkan masalah konfigurasi.

Periksa:

- API key tidak masuk log.
- API key tidak masuk error UI.
- API key tidak hardcoded.
- backend URL tidak menghasilkan malformed request.
- invalid settings tidak crash applet.
- provider failure tidak merusak search normal.
- web search disable tetap berfungsi dengan benar.
- AI disable tidak merusak non-AI search.

---

# 9. PERFORMANCE & UI REGRESSION

Verifikasi:

- search UI tetap responsif.
- AI request tidak memblokir UI.
- web search tidak freeze applet.
- cancel tetap responsif.
- source rendering tidak menumpuk.
- query baru membersihkan state query lama.
- error state tidak tersisa pada request berikutnya.

Tidak perlu melakukan optimization besar kecuali ditemukan regression nyata.

---

# 10. RELEASE GATE

Phase 7 dianggap selesai hanya jika seluruh checklist berikut terpenuhi.

## Core Search

- [ ] Application search pass.
- [ ] File search pass.
- [ ] URL search pass.
- [ ] Calculator search pass.
- [ ] Context actions pass.

## AI

- [ ] Normal AI query pass.
- [ ] AI streaming pass.
- [ ] Cancellation pass.
- [ ] AI error handling pass.
- [ ] Consecutive query race condition pass.

## AI Search

- [ ] Search intent dapat memanggil web_search.
- [ ] Provider initialization pass.
- [ ] SearXNG/backend request pass.
- [ ] Results parsed pass.
- [ ] Results normalized pass.
- [ ] Grounding context injected pass.
- [ ] Second AI request receives sources pass.
- [ ] Final answer generated pass.
- [ ] Sources UI pass.

## Runtime

- [ ] Full automated tests pass.
- [ ] Syntax check pass.
- [ ] Cinnamon/GJS runtime verification pass.
- [ ] Tidak ada known blocker P1/P2 yang tersisa.

---

# IMPORTANT RULES FOR PHASE 7

Jangan:

- menambah provider baru.
- mengganti arsitektur AI.
- mengganti tool-call flow yang sekarang sudah bekerja.
- melakukan refactor besar.
- mengubah parser tanpa regression evidence.
- menghapus test hanya untuk membuat suite hijau.

Phase 7 adalah:

```text
Regression
Verification
Minimal Fix
Release Gate
```

Bukan feature phase.

---

# EXIT CRITERIA

Setelah Phase 7 selesai:

```text
Search Engine
+
AI Integration
+
Web Search Grounding
+
Cinnamon/GJS Runtime

= stable regression baseline
```

Baru setelah baseline ini stabil, lanjut ke phase pengembangan berikutnya seperti Tool System / Agent capability.
