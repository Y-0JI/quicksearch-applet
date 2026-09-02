# QuickSearch AI Search v1 — Phase AI-6
## Streaming AI Response UX

**Status:** Planning  
**Prerequisite:** Phase AI-5 FINAL PASS  
**Current baseline:** AI-5 merged to `main`, 378 tests passing  
**Scope:** Progressive AI response delivery and rendering  
**Primary goal:** Display AI answers progressively while preserving existing cancellation, grounding, source, stale-request, and Normal Search protections.

---

# 1. Why AI-6

AI-5 completed grounded answer presentation:

```text
AI query → complete response → normalized answer → optional sources
```

AI-6 changes the delivery experience:

```text
AI query
   ↓
AI request
   ↓
First chunk arrives
   ↓
Answer appears immediately
   ↓
More chunks append
   ↓
Final completion
   ↓
Optional normalized sources
```

QuickSearch remains:

```text
one query → one AI result
```

This is not a chat/history phase.

---

# 2. Product Goal

Target UX:

```text
Enter
  ↓
Loading
  ↓
First valid text chunk
  ↓
Streaming answer visible
  ↓
Progressive text
  ↓
Complete
  ↓
Final answer + optional Sources
```

Keep:

```text
existing overlay
existing searchbox
existing AI mode toggle
```

Do not add another window or second searchbox.

---

# 3. Scope

## A. Streaming transport

Support OpenAI-compatible streaming through the existing 9router integration.

Conceptual request:

```js
{
    model: selectedModel,
    messages: [...],
    stream: true
}
```

Keep compatibility with the existing provider architecture.

## B. Incremental answer updates

Example:

```text
chunk 1 → "Linux "
chunk 2 → "Mint "
chunk 3 → "is "
```

UI:

```text
Linux
Linux Mint
Linux Mint is
```

## C. Explicit states

```text
idle
loading
streaming
answer
error
```

Transition:

```text
idle → loading → streaming → answer
```

## D. Final sources

Text streams progressively.

Sources should normally be finalized at completion using the existing AI-5 normalized result contract.

Do not rebuild Sources UI for every chunk.

---

# 4. Non-Goals

Do not add:

- chat history,
- multi-turn context,
- full Markdown,
- HTML rendering,
- WebKit/browser,
- animation gimmicks,
- new popup,
- second searchbox,
- system command execution,
- agent loops,
- new backend.

AI-6 is progressive transport and rendering only.

---

# 5. Architecture

Target pipeline:

```text
nineRouterProvider
        ↓ raw stream
aiProvider
        ↓ normalized stream events
aiSearchEngine
        ↓ stable callbacks
applet.js
        ↓
progressive AI UI
```

The UI must not parse raw SSE/provider payloads.

---

# 6. Normalized Streaming Event Contract

Recommended internal events:

```js
{ type: 'start' }
```

```js
{
    type: 'delta',
    text: 'partial text'
}
```

```js
{
    type: 'complete',
    result: {
        text: 'final complete text',
        sources: [...],
        grounded: true
    }
}
```

```js
{
    type: 'error',
    error: {
        code: '...',
        message: '...'
    }
}
```

Raw SSE must stay below the provider boundary.

---

# 7. Provider Streaming Requirements

## 7.1 Explicit streaming path

Only the streaming execution path should send:

```js
stream: true
```

Do not silently break existing non-streaming compatibility.

## 7.2 SSE parsing

Conceptual format:

```text
data: {"choices":[{"delta":{"content":"Hello"}}]}

data: {"choices":[{"delta":{"content":" world"}}]}

data: [DONE]
```

Parser requirements:

- network reads can contain multiple events,
- one event can span multiple reads,
- JSON can span reads,
- empty keepalive events ignored,
- `[DONE]` handled,
- unknown metadata does not crash,
- final text accumulated safely.

Never assume one network read equals one SSE event.

## 7.3 UTF-8 safety

Use persistent decoding appropriate for the Cinnamon runtime.

Do not independently decode arbitrary byte fragments if that can corrupt multi-byte Unicode characters.

---

# 8. Cinnamon / CJS Compatibility

Before implementation, verify runtime capabilities.

Do not assume browser APIs such as:

```text
ReadableStream
EventSource
fetch body reader
AbortController
```

are available exactly as in a modern browser.

Use the smallest transport implementation compatible with the existing Cinnamon/CJS environment.

Possible approaches depend on available runtime support:

- Gio async input streams,
- Soup streaming APIs if compatible,
- existing project-compatible HTTP mechanisms.

Do not add a large dependency only for SSE.

---

# 9. Cancellation and Stale Safety

All AI-4 protections remain mandatory.

## Mode switch

```text
streaming
→ switch Normal
→ cancel
→ no more chunks accepted
```

## Close

```text
streaming
→ close overlay
→ cancel
→ no late UI updates
```

## New query

```text
A streaming
→ submit B
→ retire/cancel A
→ A chunks ignored
```

Every callback must check request generation/current relevance:

- start,
- delta,
- complete,
- error.

Protect every delta, not only completion.

---

# 10. UI Rendering Strategy

## Do not rebuild everything per chunk

Create/update the AI answer actor incrementally.

Do not trigger on every chunk:

- Normal Search rendering,
- provider reranking,
- section regrouping,
- full result actor destruction.

## Optional batching

If chunks are extremely frequent:

```text
incoming chunks
→ append buffer
→ scheduled UI flush
```

Requirements:

- preserve exact order,
- lose no text,
- completion flushes remaining text,
- cancel/stale request clears buffer.

Do not introduce artificial typing delays.

---

# 11. Loading → Streaming

Before visible text:

```text
state = loading
```

After first non-empty text delta:

```text
state = streaming
```

The answer should become visible immediately.

Empty chunks must not transition the state.

---

# 12. Final Completion

On completion:

1. flush pending text,
2. verify generation is current,
3. construct AI-5 canonical result,
4. reconcile accumulated/final text without duplication,
5. normalize/deduplicate sources through existing AI-5 logic,
6. transition:

```text
streaming → answer
```

Final contract remains:

```js
{
    text,
    sources,
    grounded
}
```

Do not create a second incompatible streaming result format.

---

# 13. Text Reconciliation

Streaming text is the primary visible text.

At completion:

- identical final text → keep current text,
- final text has missing content → reconcile safely,
- never duplicate already-rendered content,
- avoid visible full-text flicker.

---

# 14. Grounding Compatibility

Streaming must preserve AI-5 grounding behavior.

Possible flow:

```text
text deltas
→ completion
→ citation/source metadata
```

Therefore:

- text may stream immediately,
- sources may arrive only at completion,
- source normalization/dedup stays AI-5 canonical.

Do not invent sources from URLs merely found inside answer text.

---

# 15. Error Handling

## Error before first text

```text
loading → error
```

Reuse existing AI error UI.

## Error after partial text

Recommended MVP:

```text
partial answer remains visible
+
clear interrupted/error indication
```

Do not erase useful received text automatically.

Do not present interrupted output as a successfully completed grounded answer.

---

# 16. Fallback

Streaming capability can vary by model/provider.

Do not automatically retry every error using non-streaming mode.

Cancellation must never trigger fallback.

Do not create duplicate requests after partial text has already been shown.

If fallback behavior creates ambiguity, defer it and return a clear error. Correctness is more important than hidden retries.

---

# 17. Expected File Scope

Likely:

```text
ai/nineRouterProvider.js
ai/aiProvider.js
ai/aiSearchEngine.js
applet.js
tests/
```

Possible new tests:

```text
tests/ai-stream-parser.test.js
tests/ai-streaming.test.js
```

Do not modify unrelated Normal Search providers/ranking unless a verified dependency requires it.

---

# 18. Automated Test Plan

## A. Stream parser

- one event
- multiple events in one network chunk
- event split across reads
- JSON split across reads
- UTF-8 split across reads
- empty keepalive
- `[DONE]` completion once
- unknown metadata safely ignored

## B. Engine flow

Verify:

```text
start → delta A → delta B → complete
```

produces:

```text
loading → streaming → answer
```

and text order is exact.

## C. Stale stream

```text
A starts
→ B submitted
→ late A delta ignored
→ late A complete ignored
→ late A error ignored
```

## D. Cancellation

- AI → Normal
- overlay close
- new query

All must block old chunks.

## E. Sources

- streaming text + final sources
- no sources → no empty Sources section
- duplicate final sources → AI-5 dedup remains active
- invalid source → answer remains visible

## F. UI batching

If implemented:

- order preserved
- no text lost
- completion flushes buffer
- cancel clears buffer
- stale scheduled flush cannot update new request

## G. Normal Search regression

Verify:

```text
Normal mode
→ streaming path never called
→ existing results unchanged
→ keyboard behavior unchanged
→ Best Match unchanged
```

---

# 19. Manual Cinnamon Smoke Test

## Test 1 — First text latency

Verify:

```text
loading
→ first answer text before full response completes
```

## Test 2 — Progressive answer

Verify:

- answer grows progressively,
- order correct,
- no duplicate segments,
- no full UI flicker.

## Test 3 — Grounded query

Verify:

```text
streaming answer
→ completion
→ Sources appear when metadata exists
```

## Test 4 — New query during stream

```text
A partial answer
→ submit B
```

A must never append into B.

## Test 5 — Switch Normal

AI stream stops and Normal Search remains correct.

## Test 6 — Close overlay

No crash and no late update after closing.

## Test 7 — Long response

Verify Cinnamon/UI remains responsive.

---

# 20. Acceptance Gate

```text
[ ] Existing overlay preserved
[ ] Existing searchbox preserved
[ ] Normal Search unchanged
[ ] Streaming works in supported Cinnamon runtime
[ ] UI does not parse raw SSE
[ ] First valid text changes loading → streaming
[ ] Answer appears progressively
[ ] Text order preserved
[ ] UTF-8 boundaries handled safely
[ ] SSE/network boundaries handled safely
[ ] DONE handled once
[ ] Empty deltas do not corrupt state
[ ] Final result uses AI-5 canonical contract
[ ] Final sources use AI-5 normalization/dedup
[ ] New query blocks stale deltas
[ ] Mode switch blocks stale deltas
[ ] Close blocks stale deltas
[ ] Stale complete ignored
[ ] Stale error ignored
[ ] Completion does not duplicate text
[ ] Pending UI buffer cleared on cancel/stale request
[ ] No full QuickSearch rebuild per chunk
[ ] Normal Search never invokes streaming path
[ ] Existing AI-5 tests remain green
[ ] Full node test suite passes
[ ] Cinnamon manual streaming smoke test passes
```

---

# 21. Definition of Done

AI-6 is complete when:

```text
Question
   ↓
Loading
   ↓
Progressive AI answer
   ↓
Completion
   ↓
Optional normalized Sources
```

works inside the existing QuickSearch UI while preserving:

- AI-4 lifecycle safety,
- AI-5 source/result normalization,
- Normal Search isolation.

No chat architecture is introduced.

---

# 22. Next Phase Preview

After AI-6 is validated with the real 9router deployment and streaming-capable models, choose the next direction:

```text
AI-7 — AI Settings / Model Management UX
AI-7 — AI Response Actions
AI-7 — System Intent / Local Command Architecture
```

Do not lock AI-7 until real AI-6 provider behavior has been tested.
