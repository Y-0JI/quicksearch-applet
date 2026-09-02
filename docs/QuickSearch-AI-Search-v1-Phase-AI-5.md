# QuickSearch AI Search v1 — Phase AI-5
## Rich Answer Rendering, Sources & Grounding Result UX

**Status:** Planning  
**Prerequisite:** Phase AI-4 FINAL PASS  
**Scope:** AI answer presentation only

## 1. Goal
Phase AI-5 focuses on what happens after the grounded AI answer arrives. QuickSearch remains one-query → one-result, using the existing overlay and existing searchbox.

Target flow:

```text
AI mode → Enter → AI Search/Grounding → Loading → Readable Answer → Optional Sources
```

Do not add a second window, second searchbox, chat history, or a new backend.

## 2. In Scope

### A. Safe rich answer rendering
Support a minimal presentation subset:
- paragraphs
- line breaks
- simple headings
- bullet-like lists
- numbered-like lists

AI responses remain plain text. Do not render arbitrary HTML and do not add WebKit/browser views.

### B. Grounding source extraction
Provider/gateway citation metadata must be normalized before reaching UI.

Recommended normalized result:

```js
{
    text: 'AI answer text',
    sources: [
        {
            title: 'Source title',
            url: 'https://example.com/article',
            domain: 'example.com'
        }
    ],
    grounded: true
}
```

Rules:
- `text` always string
- `sources` always array
- no sources is valid
- successful answer without sources is valid
- raw provider payload must not reach `applet.js`

### C. Sources UI
Only show Sources when `sources.length > 0`.

Source row:
- title
- optional domain
- click opens normalized URL safely

### D. Backward compatibility
Inspect current AI-3/AI-4 callback contract first. Use the smallest compatible migration.

If current result is string-based, normalize internally to:

```js
{
    text,
    sources: [],
    grounded: false
}
```

Do not create parallel incompatible callback APIs.

## 3. Architecture

```text
9routerProvider
    ↓ raw API response
aiProvider / normalization boundary
    ↓ normalized result
aiSearchEngine
    ↓
applet.js
    ↓
AI answer + optional Sources UI
```

Provider-specific source schemas stay below the UI boundary.

## 4. Source Normalization

Different providers can return citation metadata differently. Build a small normalization layer that:

1. extracts answer text using existing success flow
2. detects supported source structures
3. validates URLs
4. removes invalid entries
5. deduplicates by normalized URL
6. creates stable `{title,url,domain}` objects

### URL rules
Only HTTP/HTTPS URLs are clickable.

Reject:
- `javascript:`
- `data:`
- `file:`
- empty values
- malformed URLs

Never pass unvalidated provider strings directly to a shell opener.

### Missing title fallback

```text
provider title
→ domain
→ URL
```

### Duplicate URLs
Keep one source and preserve the first useful title.

## 5. Answer Rendering

Rendering principle:
- minimal local formatting
- no arbitrary HTML
- no code execution
- no shell command generation

Suggested behavior:
- blank lines create paragraph spacing
- preserve intentional line breaks
- recognize `-`, `*`, `•` as simple bullets
- recognize `1.`, `2.` as simple numbered items
- unknown syntax remains plain visible text

Do not add a full Markdown parser.

## 6. UI Integration

Keep exactly:

```text
existing overlay
existing searchbox
existing AI mode toggle
```

Recommended AI states:

```text
idle
loading
answer
error
```

Answer state:

```js
{
    state: 'answer',
    result: {
        text,
        sources,
        grounded
    }
}
```

Layout:

```text
[ AI Answer ]

answer content

[ Sources ]   ← only when sources exist
source row 1
source row 2
```

Sources must remain visually secondary to the answer.

## 7. Keyboard Behavior

Preserve AI-4 behavior.

Enter:
- submits a non-empty AI query in AI mode
- must not unexpectedly open a source after an answer arrives

Do not redesign Normal Search keyboard navigation.

Mouse-clickable sources are sufficient for AI-5 MVP if keyboard source navigation requires a large architectural change.

## 8. Lifecycle / Stale Safety

All AI-4 guards remain mandatory.

### Mode switch

```text
AI request pending
→ switch Normal
→ cancel
→ late answer ignored
→ late sources ignored
```

### Close

```text
AI request pending
→ close overlay
→ cancel
→ late answer ignored
→ late sources ignored
```

### New query

```text
request A
→ submit B
→ A finishes later
→ A must not replace B
```

Answer and sources must be guarded together by the same request relevance/generation logic.

## 9. Error Handling

Invalid source metadata must not turn a valid answer into an error.

```text
valid answer + invalid URL
→ render answer
→ skip invalid source
```

No sources:

```text
valid answer + no metadata
→ render answer normally
→ no Sources section
```

Malformed entire provider response continues using existing AI error behavior.

Do not show raw JSON to users.

## 10. Expected Files

Approximate scope:

```text
ai/nineRouterProvider.js
ai/aiProvider.js
ai/aiSearchEngine.js
applet.js
stylesheet.css
tests/
```

Possible focused tests:

```text
tests/ai-answer-rendering.test.js
tests/ai-source-normalization.test.js
```

Do not modify unrelated Normal Search providers or ranking unless a verified interface dependency requires it.

## 11. Automated Tests

### Normalization
- plain answer → normalized result
- valid source → title/url/domain
- missing title → domain/URL fallback
- invalid URL → removed
- non-http URL → removed
- duplicate URLs → deduplicated
- unknown provider metadata → ignored safely

### Answer UI
- plain answer renders
- no Sources heading when empty
- answer + sources renders correct rows
- malformed source metadata does not hide valid answer

### Lifecycle
- request A then B → A answer/sources ignored
- AI → Normal → late callback ignored
- close overlay → late callback ignored

### Normal Search regression
Verify:
- Normal mode unchanged
- AI answer area absent
- Sources absent
- aiSearchEngine not called

## 12. Manual Cinnamon Smoke Test

1. Plain AI answer:
   - loading appears
   - answer readable
   - no empty Sources section

2. Grounded question:
   - answer renders
   - if provider returns source metadata, Sources appears
   - labels readable

Important: absence of sources is not automatically a UI bug if the provider/gateway does not return citation metadata.

3. Click source:
   - opens URL
   - no crash
   - no duplicate overlay

4. Valid answer + invalid source:
   - answer still visible
   - invalid row absent

5. Switch mode during loading:
   - old answer/sources never return

6. Normal Search:
   - results unchanged
   - Best Match unchanged
   - keyboard navigation unchanged

## 13. Non-Goals

Do not add:
- streaming
- full Markdown renderer
- HTML renderer
- WebKit/browser
- chat history
- conversation memory
- source scraping
- independent crawler
- system command execution
- new popup/window
- second searchbox
- AI model picker UI

## 14. Acceptance Gate

```text
[ ] Single overlay preserved
[ ] Single searchbox preserved
[ ] Normal Search unchanged
[ ] Stable normalized AI result contract
[ ] Raw provider source schema does not reach UI
[ ] Plain answer renders
[ ] Optional sources render
[ ] No empty Sources section
[ ] Invalid URLs rejected
[ ] Only HTTP/HTTPS clickable
[ ] Duplicate sources removed
[ ] Missing title fallback works
[ ] Malformed metadata does not break answer
[ ] Source click opens safely
[ ] New query stale guard works
[ ] AI → Normal cancels/ignores pending result
[ ] Close cancels/ignores pending result
[ ] AI-4 tests remain green
[ ] Normal Search tests remain green
[ ] Full node test suite passes
[ ] Cinnamon manual smoke test passes
```

## 15. Definition of Done

Phase AI-5 is complete when:

```text
Question
   ↓
AI Search / Grounding
   ↓
Readable answer
   ↓
Optional normalized sources
```

works inside the existing QuickSearch UI without changing Normal Search or coupling the UI to one provider's raw citation format.

## 16. Next Phase Preview

After AI-5 is validated in real provider usage, choose AI-6 based on actual needs:

```text
Streaming response UX
OR
AI response actions
OR
AI settings/model management polish
```

AI-6 should not be locked before observing the real 9router/provider source metadata behavior.
