# QuickSearch AI Search — Phase AI-3A
## Web Search Grounding Contract & Source Pipeline

**Status:** PLAN / Specification  
**Prerequisite:** AI-0, AI-1, AI-2 Final Gate PASS  
**Scope:** AI-3A only — contracts and boundaries. No real grounding orchestration yet.

---

# 1. Purpose

Phase AI-3A establishes the **data contracts and architectural boundaries** required for Web Search Grounding in QuickSearch AI Search.

AI-2 currently supports:

```text
User query → AI Search Mode → AISearchEngine → AIProvider → NineRouterProvider / 9router → AI answer
```

AI-3 will eventually allow:

```text
User query
    ↓
AIProvider decides current information is needed
    ↓
web_search tool request
    ↓
WebSearchTool
    ↓
Search backend
    ↓
Normalized web results
    ↓
Grounding context
    ↓
AIProvider
    ↓
Final answer + sources
```

AI-3A does **not** implement the full flow. It only defines stable contracts before orchestration and UI are added.

---

# 2. Phase Goal

At the end of AI-3A, the repository must have a clear, testable contract for:

1. Web search request input.
2. Normalized web search results.
3. Grounding context passed back to AI.
4. Source metadata returned with a grounded answer.
5. Tool-call and tool-result boundaries.
6. Cancellation and stale-result compatibility.
7. Future UI source rendering without changing provider contracts.

---

# 3. Mandatory Architecture

```text
applet.js
    │ UI state only
    ▼
AISearchEngine
    │
    ├──────────────► AIProvider
    │                    ▼
    │              NineRouterProvider
    │
    ▼
WebSearchTool
    ▼
Web Search Backend / Adapter
```

## Boundary rules

### applet.js
Responsible only for UI state, query submission, loading, answer rendering, future source rendering, cancel/close lifecycle.

Must not call a web backend directly, parse raw search responses, build grounding prompts, decide tool rounds, or construct provider-specific web-search payloads.

### AISearchEngine
Owns future orchestration: recognizing supported tool calls, invoking WebSearchTool, forwarding grounding context, enforcing max rounds, and preserving cancellation/generation safety.

Full orchestration belongs to AI-3B.

### WebSearchTool
Accepts normalized search requests, calls an injected backend, normalizes results, and returns a stable tool result.

Must not render UI, call applet.js, execute system commands, or know Cinnamon UI objects.

### AIProvider / NineRouterProvider
Own AI transport and response normalization.

Must not know Cinnamon UI or concrete web backend details.

---

# 4. Canonical Web Search Request

```js
{
    query: String,
    maxResults: Number
}
```

Rules:

- `query` must be non-empty after trim.
- `maxResults` must be bounded.
- No UI object may be passed.

Recommended:

```js
DEFAULT_MAX_RESULTS = 5
MAX_RESULTS = 10
```

---

# 5. Canonical Web Source

Every backend result must normalize into:

```js
{
    id: String,
    title: String,
    url: String,
    snippet: String
}
```

Rules:

- `id` stable within one result set.
- Recommended IDs: `web-1`, `web-2`, etc.
- `title` must be human-readable; hostname may be fallback.
- `url` must be valid HTTP/HTTPS.
- Invalid or empty URLs must be rejected.
- `snippet` is a short description and may be empty only when necessary.

---

# 6. Web Search Tool Result Contract

`WebSearchTool.search()` must resolve to:

```js
{
    type: 'tool_result',
    tool: 'web_search',
    query: String,
    sources: [
        {
            id: String,
            title: String,
            url: String,
            snippet: String
        }
    ]
}
```

Zero results:

```js
{
    type: 'tool_result',
    tool: 'web_search',
    query: String,
    sources: []
}
```

No results are not automatically an error.

---

# 7. Tool Error Contract

Operational failures normalize to:

```js
{
    type: 'tool_error',
    tool: 'web_search',
    code: String,
    message: String
}
```

Initial codes:

```text
invalid_query
backend_unavailable
request_failed
cancelled
invalid_response
```

Raw backend stack traces must not reach the applet UI.

---

# 8. Grounding Context Contract

AI receives normalized data:

```js
{
    type: 'grounding_context',
    query: String,
    sources: [
        {
            id: String,
            title: String,
            url: String,
            snippet: String
        }
    ]
}
```

Bridge:

```text
WebSearchTool
    ↓
canonical sources
    ↓
Grounding Context
    ↓
AISearchEngine
    ↓
AIProvider
```

AI-3A does not yet define final provider-specific payload syntax.

---

# 9. Grounded Answer Contract

Reserve the final answer structure:

```js
{
    type: 'answer',
    text: String,
    grounded: Boolean,
    sources: Array
}
```

Non-grounded:

```js
{
    type: 'answer',
    text: '...',
    grounded: false,
    sources: []
}
```

Grounded:

```js
{
    type: 'answer',
    text: '...',
    grounded: true,
    sources: [
        {
            id: 'web-1',
            title: 'Example',
            url: 'https://example.com',
            snippet: '...'
        }
    ]
}
```

AI-3A does not yet require source-card UI.

---

# 10. Tool Call Contract

Future providers may return:

```js
{
    type: 'tool_call',
    tool: 'web_search',
    arguments: {
        query: String
    }
}
```

AI-3A supports only one future tool:

```text
web_search
```

Explicitly unsupported:

- shell
- terminal
- system_command
- file_write
- app_control
- browser_control

Unknown tools must become:

```js
{
    type: 'unsupported_tool',
    tool: String
}
```

No fallback execution.

---

# 11. Cancellation Contract

Existing AI-2 lifecycle remains mandatory.

These actions must cancel or invalidate a search chain:

- overlay close
- new query
- mode switch away from AI
- AI engine rebuild
- applet destroy

Future AI-3B:

```text
AI request
    ↓
tool_call
    ↓
web search pending
    ↓
user cancels
    ↓
generation invalid
    ↓
late web result ignored
```

AI-3A must not introduce a separate unrelated cancellation mechanism.

---

# 12. Limits and Deduplication

Initial limits:

```text
DEFAULT_MAX_RESULTS = 5
MAX_RESULTS = 10
MAX_TOOL_ROUNDS = 1 (reserved for AI-3B)
```

Normalization flow:

```text
backend results
    ↓
validate
    ↓
normalize
    ↓
deduplicate
    ↓
limit
    ↓
canonical sources
```

Deduplicate by normalized URL.

Recommended rules:

- trim whitespace
- reject empty URL
- require HTTP/HTTPS
- first valid duplicate wins
- do not aggressively rewrite destination semantics

---

# 13. WebSearchTool API

Recommended API:

```js
const tool = createWebSearchTool({
    backend
});

tool.search({
    query: 'latest Linux Mint news',
    maxResults: 5
}, cancellable, onDone);
```

`backend` is injected.

This keeps the tool independent from Serper, SearXNG, DuckDuckGo, or another backend.

AI-3A must not hard-code a new search service unless existing repository architecture requires it.

---

# 14. Backend Adapter Boundary

Conceptual adapter:

```js
backend.search(query, maxResults, cancellable, onDone)
```

Preferred flow:

```text
Concrete backend
    ↓
raw/semi-normalized results
    ↓
WebSearchTool validation
    ↓
canonical sources
    ↓
tool_result
```

Backend-specific fields must not leak into AISearchEngine or applet.js.

---

# 15. Expected Files

Possible production files:

```text
ai/webSearchTool.js
ai/groundingTypes.js
```

Modify only if necessary:

```text
ai/aiSearchEngine.js
```

Do not modify during AI-3A unless strictly required:

```text
applet.js
searchEngine.js
providers/appProvider.js
providers/fileProvider.js
providers/urlProvider.js
providers/calculatorProvider.js
```

`providers/webProvider.js` may be evaluated as a future backend adapter, but Normal Search behavior must not change.

---

# 16. Required Tests

## Request validation
- normal query accepted
- whitespace query rejected
- invalid maxResults normalized
- maxResults capped

## Source normalization
- valid result
- missing title fallback
- missing URL rejected
- invalid protocol rejected
- malformed item ignored safely

## Deduplication
- duplicate URL appears once
- first valid result retained
- result count limited

## Tool result
Verify canonical `tool_result` shape.

## Tool errors
Test:

- invalid_query
- backend_unavailable
- request_failed
- invalid_response
- cancelled

## Cancellation
- cancel before backend response
- late callback ignored
- cancelled callback cannot produce active result

## Regression
AI-3A must not break:

- AI-2 direct answers
- Normal Search
- App/File/Web/URL/Calculator providers
- mode switching
- AI engine rebuild lifecycle

---

# 17. Explicit Non-Goals

Do not implement:

- real AI tool orchestration loop
- automatic web search triggering
- provider tool-call round trip
- second AI request with grounding context
- source cards
- citations UI
- streaming
- chat history
- agent loop
- system commands
- terminal execution
- page scraping
- browser automation

---

# 18. Completion Criteria

AI-3A is PASS only when:

```text
[ ] Canonical Web Search Request exists
[ ] Canonical Web Source exists
[ ] Tool Result contract exists
[ ] Tool Error contract exists
[ ] Grounding Context contract exists
[ ] Grounded Answer contract reserved
[ ] URL validation works
[ ] Deduplication works
[ ] Result limit works
[ ] Cancellation behavior is defined/tested
[ ] No UI change required
[ ] No Normal Search regression
[ ] No real grounding orchestration added
[ ] node --check passes
[ ] full node --test passes
```

---

# 19. Next Phase

After AI-3A PASS:

## Phase AI-3B — Grounding Orchestration

```text
User query
    ↓
AIProvider
    ↓
tool_call: web_search
    ↓
WebSearchTool
    ↓
Grounding Context
    ↓
AIProvider final request
    ↓
Grounded answer + sources
```

Only AI-3B activates the actual one-round tool flow.

---

# 20. Final Scope Summary

AI-3A is infrastructure-first:

```text
Search Request
    ↓
WebSearchTool
    ↓
Canonical Sources
    ↓
Grounding Context
    ↓
Future Grounded Answer
```

It does not yet activate:

```text
AI → Search → AI
```

That separation is intentional. AI-3A stabilizes contracts first so AI-3B orchestration and later source UI can be added without repeatedly changing data structures or leaking backend-specific formats into the Cinnamon applet.
