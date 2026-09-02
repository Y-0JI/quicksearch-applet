# QuickSearch AI Search — Phase AI-3B
## Web Grounding Orchestration & Lifecycle Hardening

**Project:** QuickSearch Applet  
**Repository:** `Y-0JI/quicksearch-applet`  
**Phase:** AI-3B  
**Status:** PLAN  
**Prerequisite:** AI-3A — FINAL PASS

---

# 1. Purpose

AI-3A telah menetapkan kontrak grounding canonical:

- normalisasi AI tool call
- canonical WebSearch request object
- canonical `tool_result`
- shared source normalization
- grounding context
- canonical grounded answer

AI-3B tidak merombak kontrak tersebut.

Tujuan AI-3B adalah memperkuat orchestration lifecycle agar alur grounding memiliki perilaku eksplisit untuk:

- direct answer
- one-round web grounding
- empty search results
- provider errors
- web search errors
- cancellation
- stale callbacks
- pencegahan tool loop

Targetnya adalah orchestration yang predictable dan fail-closed sebelum masuk ke UI AI Search.

---

# 2. Canonical Flow

```text
User Query
    ↓
AI Provider Request #1
    ↓
┌───────────────────────┐
│ Provider Response      │
└───────────┬───────────┘
            │
     ┌──────┴──────┐
     │             │
Direct Answer   Tool Call
     │             │
     │             ↓
     │      normalizeToolCall()
     │             ↓
     │   Canonical WebSearch Request
     │      { query, maxResults }
     │             ↓
     │        WebSearchTool
     │             ↓
     │    Canonical tool_result
     │             ↓
     │   createGroundingContext()
     │             ↓
     │    AI Provider Request #2
     │             ↓
     └─────────────┤
                   ↓
      createGroundedAnswer()
                   ↓
              Final Result
```

AI-3B menambahkan lifecycle rules di sekitar flow ini.

---

# 3. Architecture Goals

## 3.1 Preserve canonical boundaries

Jangan mengganti atau menduplikasi boundary AI-3A:

```text
normalizeToolCall()
        ↓
WebSearchTool canonical request
        ↓
tool_result
        ↓
createGroundingContext()
        ↓
createGroundedAnswer()
```

Semua tetap menjadi kontrak authoritative.

## 3.2 Maximum one grounding round

Satu query maksimal:

```text
Provider #1
    ↓
optional Web Search
    ↓
Provider #2
    ↓
Final Answer
```

Provider #2 tidak boleh memicu Web Search kedua.

Multiple tool rounds di luar scope.

## 3.3 Fail closed

Jika canonical grounding boundary menghasilkan data tidak valid, engine harus berhenti.

Contoh:

```text
canonical request
    ↓
raw Array returned
    ↓
invalid_response
```

---

# 4. Lifecycle States

Suggested conceptual states:

```text
IDLE
  ↓
PROVIDER_INITIAL
  ↓
DIRECT_ANSWER
  OR
TOOL_NORMALIZATION
  ↓
WEB_SEARCH
  ↓
GROUNDING_CONTEXT
  ↓
PROVIDER_GROUNDED
  ↓
FINAL_DELIVERY
```

Terminal:

```text
SUCCESS
ERROR
CANCELLED
STALE
```

Tidak wajib membuat state-machine class baru jika implementation sekarang tidak memerlukannya. Yang wajib adalah transition deterministik dan test.

---

# 5. Requirement A — Direct Answer

Jika Provider #1 memberi direct answer:

```text
Provider #1
    ↓
Direct Answer
    ↓
Final Delivery
```

Requirements:

- WebSearchTool tidak dipanggil.
- Tidak membuat grounding context.
- Tidak ada Provider #2.
- Existing behavior tetap kompatibel.

Test:

```text
provider returns direct answer
    ↓
webSearchTool.search = 0 call
provider = 1 call
successful answer delivered
```

---

# 6. Requirement B — Exactly One Grounding Round

Jika Provider #1 memberi valid `web_search`:

```text
Provider #1
    ↓
normalizeToolCall()
    ↓
WebSearchTool.search({ query, maxResults })
    ↓
tool_result
    ↓
createGroundingContext()
    ↓
Provider #2
    ↓
Final Answer
```

Requirements:

- Web search tepat satu kali.
- Provider tepat dua kali.
- Provider #2 tidak boleh memicu WebSearchTool lagi.
- Final result tetap memakai canonical answer boundary.

---

# 7. Requirement C — Tool Loop Guard

Provider #2 adalah tahap final grounded answer.

Jika Provider #2 mengembalikan tool call lagi:

```text
Provider #2 returns tool call
    ↓
STOP
    ↓
explicit deterministic error
```

Tidak boleh:

```text
AI → Search → AI → Search → ...
```

Gunakan existing error convention jika memungkinkan.

---

# 8. Requirement D — Empty Search Results

Contoh:

```text
tool_result {
    type: 'tool_result',
    query: '...',
    sources: []
}
```

Behavior yang direkomendasikan:

```text
valid canonical tool_result
+ sources exists
+ sources.length === 0
        ↓
Provider #2 NOT called
        ↓
explicit grounding no-results error
```

Rules:

- Jangan membuat source palsu.
- Jangan mengirim fake grounding context.
- Jangan diam-diam mengubahnya menjadi direct answer.

Jika project sudah punya error code yang cocok, reuse. Jika belum, tambah satu code yang sempit dan jelas.

---

# 9. Requirement E — Web Search Errors

Cases:

```text
network failure
timeout
backend failure
invalid canonical result
cancellation
```

Normal error:

```text
WebSearchTool error
    ↓
Provider #2 must NOT run
    ↓
error delivered
```

Invalid canonical result:

```text
canonical request
    ↓
invalid/non-tool_result response
    ↓
invalid_response
```

Cancellation:

```text
cancel
    ↓
late callback ignored
    ↓
no Provider #2
    ↓
no final answer
```

---

# 10. Requirement F — Cancellation End-to-End

## F1. Cancel during Provider #1

```text
Provider #1 pending
    ↓
cancel()
    ↓
late callback ignored
```

No WebSearchTool.

## F2. Cancel during Web Search

```text
Web Search pending
    ↓
cancel()
    ↓
late callback ignored
```

No Provider #2.

## F3. Cancel during Provider #2

```text
Provider #2 pending
    ↓
cancel()
    ↓
late callback ignored
```

No final delivery.

Reuse existing cancellation/generation mechanism. Jangan membuat mekanisme kedua yang bersaing.

---

# 11. Requirement G — Stale Callback Protection

Contoh:

```text
Query A starts
    ↓
Query B starts
    ↓
Query B completes
    ↓
Query A callback arrives late
    ↓
Query A ignored
```

Harus berlaku pada:

- Provider #1
- WebSearchTool
- Provider #2

Stale callback tidak boleh:

- memulai Provider #2
- melakukan final delivery
- overwrite hasil query baru

---

# 12. Requirement H — Single Final Delivery Boundary

Successful grounded answer tetap berakhir melalui:

```js
Gt.createGroundedAnswer(text, sources)
```

Jangan membuat final-answer builder baru.

AI-3B tidak boleh memperkenalkan parallel answer contract.

---

# 13. Implementation Scope

Production utama:

```text
ai/aiSearchEngine.js
```

Supporting file hanya jika perlu:

```text
ai/groundingTypes.js
```

Tests:

```text
tests/ai-grounding-contracts.test.js
```

Optional focused test:

```text
tests/ai-grounding-orchestration.test.js
```

Prefer diff sekecil mungkin.

---

# 14. Non-Goals

AI-3B TIDAK mengimplementasikan:

```text
✗ AI Search UI
✗ mode button di searchbox
✗ streaming response
✗ multiple web search rounds
✗ agent loop
✗ autonomous planning
✗ system command execution
✗ membuka aplikasi via AI
✗ terminal execution
✗ computer control
✗ screen capture
✗ vision
✗ conversation memory
✗ chat history UI
✗ provider routing changes
✗ perubahan Normal Quick Search
```

---

# 15. Required Test Plan

## Direct path

1. Direct answer → WebSearchTool tidak dipanggil.
2. Direct answer → Provider dipanggil sekali.

## Grounded path

3. Valid tool call → WebSearchTool sekali.
4. Valid tool call → Provider dua kali.
5. Provider #2 → final answer delivered.
6. Final grounded answer memakai canonical builder.

## Loop guard

7. Provider #2 returns tool call → tidak ada second web search.
8. Tidak ada Provider #3.

## Empty results

9. `sources: []` → deterministic grounding failure.
10. Provider #2 tidak dipanggil.

## Errors

11. Web search error → Provider #2 tidak dipanggil.
12. Invalid canonical result → fail closed.
13. Invalid initial tool call → existing canonical error preserved.

## Cancellation

14. Cancel Provider #1 → late callback ignored.
15. Cancel Web Search → Provider #2 tidak dipanggil.
16. Cancel Provider #2 → final callback ignored.

## Stale protection

17. Old Provider #1 callback ignored.
18. Old WebSearch callback ignored.
19. Old Provider #2 callback ignored.
20. Old request tidak overwrite newer request.

---

# 16. Verification

Syntax:

```bash
node --check ai/aiSearchEngine.js
node --check ai/groundingTypes.js
node --check ai/webSearchTool.js
```

Focused tests:

```bash
node --test tests/ai-grounding-contracts.test.js
node --test tests/ai-grounding-orchestration.test.js
```

Jika test orchestration tidak dibuat terpisah:

```bash
node --test tests/ai-grounding-contracts.test.js
```

Full regression:

```bash
node --test
```

Normal Search harus tetap green.

---

# 17. Acceptance Criteria

```text
✓ Direct answer tidak memanggil WebSearchTool

✓ Valid web_search melakukan tepat satu grounding round

✓ Canonical WebSearch request tetap object-based

✓ Canonical tool_result tetap required

✓ Provider #2 tidak dapat memulai grounding round kedua

✓ Empty sources memiliki behavior eksplisit

✓ Web search error mencegah Provider #2

✓ Invalid canonical grounding fail closed

✓ Cancellation aman pada Provider #1

✓ Cancellation aman pada Web Search

✓ Cancellation aman pada Provider #2

✓ Stale callback tidak dapat overwrite request baru

✓ Final grounded answer memakai createGroundedAnswer()

✓ Tidak ada duplicate answer/grounding contract

✓ Normal Quick Search tidak berubah

✓ Full node test suite pass
```

---

# 18. Phase Exit

```text
AI-3A
Canonical Grounding Contracts
        ✓ COMPLETE
            ↓
AI-3B
Grounding Orchestration & Lifecycle
        ← CURRENT PHASE
            ↓
AI-4
AI Search UI Integration
```

AI-4 hanya dimulai setelah AI-3B lifecycle stabil dan seluruh regression test lolos.
