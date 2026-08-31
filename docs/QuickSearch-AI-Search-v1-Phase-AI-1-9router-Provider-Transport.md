# QuickSearch AI Search v1
## Phase AI-1 — 9router Provider Transport

**Status:** Planning / Implementation Specification  
**Depends on:** Phase AI-0 architecture  
**Scope:** Real AI transport only

## 1. Purpose

Phase AI-0 established an isolated AI Search architecture with:

- `AISearchEngine`
- `AIProvider` contract
- `WebSearchTool` contract
- `PromptBuilder`
- `SourceFormatter`
- cancellation
- generation/stale protection
- mock-based tests

Phase AI-1 adds the first real transport implementation:

```text
AISearchEngine
      |
      v
AIProvider contract
      |
      +-- Mock Provider
      |
      +-- NineRouterProvider (NEW)
              |
              v
       OpenAI-compatible HTTP
              |
              v
            9router
              |
              v
           AI Model
```

The objective is to connect QuickSearch AI Search to 9router without coupling HTTP or provider-specific details into `AISearchEngine`.

---

## 2. Strict Scope

### Included

- Real HTTP transport to 9router
- Configurable Base URL
- Configurable API Key
- Configurable Model
- OpenAI-compatible chat request
- Non-streaming response parsing
- Timeout handling
- Cancellation propagation
- HTTP error normalization
- Invalid response handling
- API-key redaction / no secret logging
- Unit tests with mocked HTTP transport
- Full regression tests

### Explicitly excluded

Do not add:

- AI Search UI
- AI button/mode inside search box
- streaming
- real WebSearchTool backend
- provider-native web grounding
- conversation history
- system command execution
- terminal execution
- shell tools
- computer control
- screen capture
- agent framework
- changes to normal Search behavior

---

## 3. File Architecture

```text
ai/
├── aiProvider.js
├── nineRouterProvider.js       ← NEW
├── aiSearchEngine.js
├── webSearchTool.js
├── promptBuilder.js
└── sourceFormatter.js
```

Tests:

```text
tests/
├── ai-provider.test.js
├── ai-search-engine.test.js
├── nine-router-provider.test.js ← NEW
├── prompt-builder.test.js
└── source-formatter.test.js
```

Existing files outside AI remain untouched unless a change is strictly required by the existing contract.

---

## 4. Architectural Boundary

`AISearchEngine` must not know:

- HTTP details
- 9router URL format
- Authorization headers
- API keys
- JSON response layout
- HTTP status codes

Correct dependency direction:

```text
AISearchEngine
      |
      v
AIProvider contract
      |
      v
NineRouterProvider
      |
      v
OpenAI-compatible HTTP
      |
      v
9router
```

Do not move provider-specific logic into the engine.

---

## 5. Provider Construction

Configuration is injected:

```js
new NineRouterProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs
});
```

Responsibilities:

- `baseUrl`: 9router API base
- `apiKey`: authentication only
- `model`: default request model
- `timeoutMs`: transport timeout

No hard-coded credentials or default secret.

---

## 6. Base URL Contract

Support:

```text
http://localhost:3000
http://localhost:3000/
http://localhost:3000/v1
http://localhost:3000/v1/
```

All must resolve consistently to:

```text
.../v1/chat/completions
```

Avoid:

```text
/v1/v1/chat/completions
//chat/completions
/v1//chat/completions
```

URL normalization must be isolated and unit-tested.

---

## 7. Request Contract

Phase AI-1 is non-streaming.

Conceptual payload:

```json
{
  "model": "selected-model",
  "messages": [
    {
      "role": "system",
      "content": "..."
    },
    {
      "role": "user",
      "content": "..."
    }
  ],
  "stream": false
}
```

The provider transports normalized messages and must not redesign prompts.

---

## 8. API Key Security

Requirements:

- Never log API keys
- Never include keys in normalized errors
- Never include keys in thrown messages
- Never include keys in test snapshots
- Never commit real keys
- Never return request headers to `AISearchEngine`

Tests must verify that forced error paths do not expose the secret.

---

## 9. Response Parsing

Flow:

```text
HTTP Response
      |
      v
Validate JSON
      |
      v
Validate choice/message
      |
      v
Extract assistant content
      |
      v
Normalize provider result
      |
      v
AISearchEngine
```

Handle distinctly:

- valid answer
- empty answer
- malformed JSON
- missing choices
- missing message
- missing content
- provider error payload

Malformed success responses must not silently become successful answers unless the existing contract explicitly allows it.

---

## 10. Error Normalization

Use normalized categories:

```text
network_error
timeout
cancelled
auth_error
rate_limited
provider_error
invalid_response
```

Suggested mapping:

| Failure | Normalized result |
|---|---|
| Connection failure | `network_error` |
| Timeout | `timeout` |
| Explicit cancellation | `cancelled` |
| HTTP 401/403 | `auth_error` |
| HTTP 429 | `rate_limited` |
| Other unsuccessful HTTP response | `provider_error` |
| Invalid JSON/response fields | `invalid_response` |

Errors must never expose credentials.

---

## 11. Timeout

Lifecycle:

```text
Request
   |
   +-- normal completion → parse response
   |
   +-- cancelled → cancelled
   |
   +-- timeout → timeout
```

A late response after timeout must not become successful.

---

## 12. Cancellation

Preserve AI-0 semantics:

```text
Search A
   |
   v
HTTP pending
   |
Search B starts
   |
   v
Cancel/invalidate A
   |
   v
Start B
```

Requirements:

- transport receives cancellation
- cancelled request cannot become success
- late response is ignored
- next request remains independent
- `destroy()` during pending HTTP is safe

Do not introduce a competing cancellation model that bypasses `AISearchEngine`.

---

## 13. Stale Response Protection

Generation protection remains authoritative:

```text
Generation 1 → Query A pending
Generation 2 → Query B pending

Late response A → IGNORE
Response B → ACCEPT
```

The provider must not weaken stale protection.

---

## 14. Tool Boundary

AI-1 does not expand tools.

Allowed:

```text
web_search
```

Still forbidden:

```text
exec
shell
terminal
computer_control
screen_capture
file_write
arbitrary tools
```

A real AI connection must not automatically turn QuickSearch into an agent.

---

## 15. Web Search Boundary

`WebSearchTool` remains unchanged.

Do not add:

- Serper implementation
- SearXNG implementation
- provider-native grounding flags
- web API keys
- browser scraping

Those belong to later phases.

---

## 16. No UI Changes

Do not modify:

- search box layout
- AI mode UI
- normal Search sections
- result rows
- keyboard behavior
- floating action buttons
- normal Search settings

There is no user-facing AI UI in this phase.

---

# 17. Testing Strategy

All HTTP unit tests use mock/fake transport.

Tests must not require:

- Internet
- running 9router
- real API key
- paid AI model

## 17.1 Endpoint Tests

Verify all supported Base URL variants produce the correct chat-completion endpoint.

## 17.2 Request Tests

Verify:

- POST method
- correct endpoint
- Authorization header
- Content-Type
- model
- messages
- `stream: false`

## 17.3 Response Tests

Test:

- normal answer
- empty content
- invalid JSON
- missing choices
- missing message
- missing content
- unexpected payload

## 17.4 HTTP Errors

Test:

```text
401 → auth_error
403 → auth_error
429 → rate_limited
500 → provider_error
network exception → network_error
```

## 17.5 Timeout

Test:

```text
pending request
    ↓
timeout
    ↓
timeout result
    ↓
late completion ignored
```

## 17.6 Cancellation

Test:

```text
start request
    ↓
cancel
    ↓
cancelled result
    ↓
no success
```

Also test Request A pending → Request B starts → A stale/cancelled → B succeeds.

## 17.7 Secret Safety

Use a fake secret:

```text
API_KEY_SHOULD_NOT_APPEAR_123
```

Force errors and assert the secret never appears in normalized errors or returned diagnostic objects.

---

## 18. Regression Verification

Syntax:

```bash
node --check ai/aiProvider.js
node --check ai/nineRouterProvider.js
node --check ai/aiSearchEngine.js
node --check ai/webSearchTool.js
node --check ai/promptBuilder.js
node --check ai/sourceFormatter.js
```

Full suite:

```bash
node --test
```

All existing QuickSearch and AI-0 tests must remain green.

---

## 19. Controlled Integration Test

After unit tests pass, optionally test against a real 9router instance:

```text
Question
   ↓
NineRouterProvider
   ↓
9router
   ↓
AI model
   ↓
Normalized answer
```

Verify endpoint, authentication, selected model, answer receipt, and no API-key leakage.

Never commit integration credentials.

---

## 20. Files Allowed to Change

Primary:

```text
ai/nineRouterProvider.js
tests/nine-router-provider.test.js
```

Only if required by the existing AI-0 contract:

```text
ai/aiProvider.js
ai/aiSearchEngine.js
tests/ai-provider.test.js
tests/ai-search-engine.test.js
```

Read-only by default:

```text
applet.js
searchEngine.js
result.js
providers/*
stylesheet.css
settings-schema.json
```

---

# 21. Definition of Done

Phase AI-1 PASS only when:

```text
✓ AI-0 isolation remains intact
✓ Real 9router provider exists
✓ OpenAI-compatible non-streaming request works
✓ Base URL normalization works
✓ Model is configurable
✓ API key is configurable
✓ API key never leaks
✓ Response parsing is validated
✓ HTTP errors are normalized
✓ Timeout works
✓ Cancellation works
✓ Stale protection remains effective
✓ No new executable tools exist
✓ WebSearchTool is unchanged
✓ No AI UI is added
✓ Normal Search is unchanged
✓ All tests pass
✓ Syntax checks pass
```

---

# 22. Next Phase Boundary

```text
AI-0 — Architecture + contracts
        ↓
AI-1 — Real 9router transport
        ↓
AI-2 — AI Search UI inside existing search box
        ↓
AI-3 — Real Web Search / Grounding strategy
        ↓
AI-4 — Sources and answer presentation
        ↓
AI-5 — Settings integration
        ↓
AI-6 — Full regression / final gate
```

Do not merge later-phase functionality into AI-1.

---

# Final Implementation Instruction

Implement only the 9router provider transport layer.

Preserve all Phase AI-0 boundaries.

Do not modify the existing normal Search system.

Do not add UI.

Do not add agent features.

Do not add Local Actions.

Do not add shell or system execution.

Do not add real Web Search yet.

The primary deliverable is a tested, cancellable, safe, OpenAI-compatible 9router transport implementation behind the existing `AIProvider` abstraction.
