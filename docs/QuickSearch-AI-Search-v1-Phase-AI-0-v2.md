# QuickSearch Applet --- AI Search v1

## Phase AI-0 --- Architecture & Isolation Plan

**Status:** Planning\
**Scope:** Architecture only --- no real AI provider and no UI
integration yet\
**Baseline:** Existing Search-only system remains unchanged

------------------------------------------------------------------------

## 1. Objective

Add a new **AI Search** capability to QuickSearch without restoring the
old AI/agent architecture.

The applet will eventually have two modes inside the **same existing
searchbox**:

``` text
                 EXISTING SEARCHBOX
                         │
                ┌────────┴────────┐
                │                 │
             SEARCH             AI SEARCH
                │                 │
          SearchEngine       AISearchEngine
                │                 │
 Apps / Files / Web       AI Provider
                                  │
                         Web Search Tool
                                  │
                            Grounding
                                  │
                         Answer + Sources
```

The existing normal Search system remains the foundation and must not
depend on AI.

------------------------------------------------------------------------

## 2. Core Design Principles

### 2.1 Search and AI Search must be isolated

Normal Search continues to use the existing:

-   `SearchEngine`
-   App provider
-   File provider
-   URL provider
-   Calculator provider
-   Web provider
-   Existing ranking
-   Existing keyboard behavior

AI Search uses a separate orchestration layer:

``` text
AISearchEngine
    ├── AI Provider
    ├── Web Search Tool
    ├── Prompt Builder
    └── Source Formatter
```

Do not merge AI logic into `searchEngine.js`.

------------------------------------------------------------------------

### 2.2 This is AI Search, not an AI Agent

The v1 architecture must remain intentionally limited.

Allowed:

-   Single-turn AI query
-   AI response
-   Controlled web search
-   Search grounding
-   Source attribution
-   Cancellation
-   Error handling

Not allowed:

-   Unlimited agent loops
-   Computer control
-   Screen capture
-   Shell execution
-   Filesystem access for AI
-   Browser automation
-   Arbitrary tool execution
-   Generic tool registry
-   Multi-agent system
-   Persistent conversation memory

The only planned external tool in v1 is:

``` text
web_search
```

------------------------------------------------------------------------

### 2.3 Provider independence

The AI orchestration layer must not depend directly on a specific
vendor.

Future providers may include different APIs, models, or endpoints, but:

``` text
AISearchEngine
       │
       ▼
AI Provider Interface
       │
       ▼
Specific Provider
```

The engine should not contain vendor-specific request or response
parsing.

------------------------------------------------------------------------

### 2.4 Web search independence

The AI layer must not know which search backend is used.

``` text
AI
 │
 ▼
WebSearchTool
 │
 ▼
Search Backend
```

The backend can later be changed without rewriting the AI engine.

------------------------------------------------------------------------

## 3. New Directory Structure

Create a dedicated AI module directory:

``` text
ai/
├── aiSearchEngine.js
├── aiProvider.js
├── webSearchTool.js
├── promptBuilder.js
└── sourceFormatter.js
```

No existing production module should be moved during Phase AI-0.

------------------------------------------------------------------------

# 4. Module Contracts

## 4.1 `ai/aiSearchEngine.js`

### Responsibility

This module is the orchestrator for AI Search.

It manages:

1.  Query lifecycle
2.  Generation/stale protection
3.  Cancellation
4.  Provider calls
5.  Controlled tool calls
6.  Web grounding
7.  Final answer delivery
8.  Error delivery

Conceptual flow:

``` text
User query
    │
    ▼
AISearchEngine
    │
    ▼
AI Provider
    │
    ├── Final answer ───────────────► deliver answer
    │
    └── web_search request
             │
             ▼
        WebSearchTool
             │
             ▼
        Search results
             │
             ▼
        AI Provider
             │
             ▼
        Grounded final answer
```

### Required lifecycle API

The exact implementation may vary, but the module should expose a small
API equivalent to:

``` js
search(query, cancellable, callbacks)
cancel()
destroy()
```

The engine must own a generation counter or equivalent stale-response
mechanism.

Conceptually:

``` text
Request A starts
    ↓
Generation = 1

Request B starts / overlay closes
    ↓
Generation increments
    ↓
Request A becomes stale

Response A arrives
    ↓
Ignore
```

A stale response must never update the current UI.

------------------------------------------------------------------------

## 4.2 `ai/aiProvider.js`

### Responsibility

Defines the normalized AI provider contract.

This Phase does not need a real remote provider.

A mock provider is sufficient for tests.

### Provider output contract

The provider must normalize its output into one of two outcomes.

#### Final answer

``` js
{
    type: 'answer',
    text: 'Answer text'
}
```

#### Tool call

``` js
{
    type: 'tool_call',
    tool: 'web_search',
    arguments: {
        query: 'search query'
    }
}
```

Do not expose raw vendor response objects outside the provider
implementation.

### Provider input

Conceptually:

``` js
{
    query,
    systemPrompt,
    messages,
    tools
}
```

The exact internal shape can remain minimal in Phase AI-0.

### Strict tool boundary

Only this tool is valid:

``` text
web_search
```

Unknown tools must result in a controlled error and must never trigger
arbitrary execution.

------------------------------------------------------------------------

## 4.3 `ai/webSearchTool.js`

### Responsibility

Provides a normalized web search interface.

Conceptual API:

``` js
search(query, cancellable, onDone)
```

Normalized result:

``` js
[
    {
        title: 'Source title',
        url: 'https://example.com',
        snippet: 'Relevant source text'
    }
]
```

### Requirements

-   No AI logic inside this module.
-   No arbitrary URL fetching in Phase AI-0.
-   No browser automation.
-   No HTML scraping pipeline.
-   Cancellation must be respected.
-   Errors must be normalized for the engine.

The real search backend is not required during Phase AI-0.

A mock implementation is acceptable.

------------------------------------------------------------------------

## 4.4 `ai/promptBuilder.js`

### Responsibility

Builds the system instructions and grounding context.

The grounding rules should establish:

``` text
- Answer the user's question directly.
- Use web search when current or external information is required.
- Do not invent search results.
- When search results are supplied, ground factual claims in them.
- If the supplied information is insufficient, say so.
- Never claim web search was performed when it was not.
- Only the web_search tool is available.
- Do not request or execute arbitrary tools.
```

The prompt builder should not contain network logic or UI logic.

------------------------------------------------------------------------

## 4.5 `ai/sourceFormatter.js`

### Responsibility

Normalize sources used by an AI response.

Conceptual output:

``` js
[
    {
        title: 'Source title',
        url: 'https://example.com',
        snippet: 'Relevant snippet'
    }
]
```

The UI can later consume this output directly to render source cards.

The formatter should:

-   Ignore malformed source entries.
-   Preserve valid title and URL information.
-   Avoid exposing arbitrary provider metadata to the UI.

------------------------------------------------------------------------

# 5. AI Search Lifecycle

The intended lifecycle is:

``` text
1. User submits AI query
        │
        ▼
2. AISearchEngine creates generation
        │
        ▼
3. AI Provider receives query
        │
        ├── answer
        │      │
        │      ▼
        │   deliver answer
        │
        └── tool_call:web_search
                 │
                 ▼
4. Validate tool name and query
                 │
                 ▼
5. WebSearchTool.search()
                 │
                 ▼
6. Normalize search results
                 │
                 ▼
7. Send grounding context back to provider
                 │
                 ▼
8. Receive final answer
                 │
                 ▼
9. Deliver answer + normalized sources
```

Phase AI-0 only establishes the contract and testable architecture.

------------------------------------------------------------------------

# 6. Cancellation and Stale Protection

AI requests may take longer than existing local Search providers.

Therefore cancellation is mandatory.

The following events must invalidate the current AI request:

-   New AI query replaces old query.
-   User changes mode away from AI Search.
-   Search overlay closes.
-   Applet is destroyed.

Required behavior:

``` text
AI Request A
     │
     ├── user starts Request B
     │
     ▼
Request A cancelled / marked stale
     │
     ▼
Late response from A
     │
     ▼
Ignored
```

A provider callback must always be checked against the active generation
before reaching the UI.

------------------------------------------------------------------------

# 7. Error Contract

Errors must not crash the search overlay.

Normalize the following cases:

### Provider failure

``` text
AI provider unavailable
```

### Web search failure

``` text
Web search unavailable
```

### Invalid tool call

``` text
Unsupported AI tool request
```

### Malformed provider response

``` text
Invalid AI response
```

### Cancellation

Cancellation is not shown as a user-facing error when the request was
intentionally superseded or closed.

------------------------------------------------------------------------

# 8. Scope Boundaries for Phase AI-0

## Modify

Create:

``` text
ai/aiSearchEngine.js
ai/aiProvider.js
ai/webSearchTool.js
ai/promptBuilder.js
ai/sourceFormatter.js
```

Create or extend focused tests for the new modules.

------------------------------------------------------------------------

## Read-only verification

Do not refactor these during Phase AI-0:

``` text
applet.js
searchEngine.js
result.js
providers/
stylesheet.css
settings-schema.json
```

Existing Search behavior must remain untouched.

------------------------------------------------------------------------

## Explicit non-goals

Do not implement yet:

-   Real OpenAI/Gemini/DeepSeek requests
-   API keys
-   Provider settings
-   Model settings
-   UI mode switch
-   Streaming UI
-   Source cards
-   Conversation history
-   Persistent memory
-   Web backend integration
-   Computer control
-   Screen capture
-   Generic agent tools

------------------------------------------------------------------------

# 9. Test Plan

Add focused unit tests.

## 9.1 AI Provider contract

Test:

-   Normal answer response.
-   `web_search` tool call.
-   Unknown tool rejected.
-   Malformed response handled.

------------------------------------------------------------------------

## 9.2 AI Search Engine

Test:

-   Query reaches provider.
-   Final answer reaches callback.
-   Valid web tool call invokes WebSearchTool.
-   Search results return to provider for grounding.
-   Unknown tool does not execute.
-   Provider error is normalized.
-   Web search error is normalized.
-   Stale response is ignored.
-   Cancellation prevents old request from updating the active request.

------------------------------------------------------------------------

## 9.3 Source Formatter

Test:

-   Valid source normalization.
-   Invalid source entries ignored.
-   Missing URL handled safely.
-   Multiple valid sources preserved.

------------------------------------------------------------------------

## 9.4 Regression

Existing tests must remain green.

Required:

``` bash
node --check ai/*.js
node --check applet.js searchEngine.js result.js providers/*.js
node --test
```

Phase AI-0 is not complete if existing Search regression tests fail.

------------------------------------------------------------------------

# 10. Acceptance Criteria

Phase AI-0 passes when:

-   [ ] AI modules are isolated under `ai/`.
-   [ ] Existing Search modules are not refactored.
-   [ ] AI provider has a normalized response contract.
-   [ ] Only `web_search` is recognized as a tool.
-   [ ] Unknown tools cannot execute.
-   [ ] AISearchEngine has cancellation/stale protection.
-   [ ] Provider and tool errors are controlled.
-   [ ] Source output has a normalized contract.
-   [ ] Mock implementations make the architecture testable.
-   [ ] Existing Search tests remain green.
-   [ ] No UI changes are made.
-   [ ] No real provider credentials are added.
-   [ ] No old AI agent architecture is restored.

------------------------------------------------------------------------

# 11. Next Phases

## Phase AI-1 --- Basic Real Provider

``` text
query
  ↓
real provider
  ↓
answer
```

Still no UI integration required.

------------------------------------------------------------------------

## Phase AI-2 --- Web Search Grounding

``` text
query
  ↓
AI Provider
  ↓
web_search tool call
  ↓
WebSearchTool
  ↓
search results
  ↓
grounded final answer
```

------------------------------------------------------------------------

## Phase AI-3 --- Sources and Citations

Add normalized source attribution and UI-ready source data.

------------------------------------------------------------------------

## Phase AI-4 --- AI Search Mode UI

Integrate AI Search into the **existing searchbox**.

Important:

-   Do not create a second searchbox.
-   Keep existing searchbox size and position.
-   Keep existing normal Search mode unchanged.
-   AI mode becomes an additional control inside the same searchbox.

------------------------------------------------------------------------

## Phase AI-5 --- Settings

Potential settings:

-   Enable AI Search
-   Provider
-   Model
-   Endpoint
-   API key
-   Web grounding enabled

Only after core architecture is stable.

------------------------------------------------------------------------

## Phase AI-6 --- Final Regression

Verify:

-   Normal Search remains unchanged.
-   AI cancellation works.
-   Stale responses are ignored.
-   Provider failure is safe.
-   Web search failure is safe.
-   Invalid tool responses are safe.
-   API credentials are never logged.
-   Source URLs are validated before UI rendering.

------------------------------------------------------------------------

------------------------------------------------------------------------

# 12. Additional Architecture Input --- 9router Integration

This section incorporates the useful architectural ideas from the
provided **9router Integrated** reference, but does not copy its
architecture wholesale.

## 12.1 Why 9router fits this architecture

9router is suitable as an optional unified gateway because the applet
can keep a single normalized AI client contract while the gateway
handles provider routing.

Target flow:

``` text
AISearchEngine
      │
      ▼
AIProvider (OpenAI-compatible client)
      │
      ▼
9router Gateway
      │
      ├── Cloud providers
      └── Local providers
```

This fits the existing provider-independence principle:

``` text
AISearchEngine
      │
      ▼
AI Provider Interface
      │
      ▼
9router-compatible transport
      │
      ▼
Selected model/provider routing
```

The applet must not become responsible for implementing
provider-specific clients for every AI vendor.

------------------------------------------------------------------------

## 12.2 Recommended transport boundary

Add a conceptual transport layer inside the future real implementation
of `aiProvider.js`.

The public engine contract remains normalized. The
9router/OpenAI-compatible request format stays behind the provider
boundary.

Conceptually:

``` text
AISearchEngine
      │ normalized request
      ▼
AIProvider
      │ OpenAI-compatible request
      ▼
9router endpoint
```

This means the engine must not contain:

-   9router HTTP payload construction
-   provider-specific model parsing
-   provider-specific grounding syntax
-   API authentication logic

Those details belong to the concrete provider implementation.

------------------------------------------------------------------------

## 12.3 Gateway configuration model

The provided reference identifies three configuration values that are
useful for a future settings phase:

-   Base URL
-   API key
-   Selected model

These should **not** be added to the production settings during Phase
AI-0.

However, the architecture should reserve a provider configuration shape
conceptually equivalent to:

``` js
{
    baseUrl,
    apiKey,
    model
}
```

Future settings integration should validate configuration without
exposing the API key in logs, result objects, errors, or UI text.

------------------------------------------------------------------------

## 12.4 Web Search Grounding capability

The reference confirms an important product direction: AI Search should
be able to use a provider's web-search / grounding capability.

This is compatible with the current architecture, but there are two
distinct implementation paths:

### Path A --- Provider-native grounding

``` text
AISearchEngine
      │
      ▼
AIProvider
      │
      ▼
9router
      │
      ▼
Provider-native web search / grounding
```

The applet asks the provider/gateway to use its supported web-search
capability.

### Path B --- Applet-controlled WebSearchTool

``` text
AISearchEngine
      │
      ├── AIProvider
      │
      └── WebSearchTool
```

The applet performs normalized web search itself and supplies the
results as grounding context.

### Architecture decision

Keep the `WebSearchTool` abstraction created in this document.

Do not assume all future models exposed through 9router support the same
native grounding API. A provider-native grounding adapter can be added
later without changing the engine contract.

The engine should eventually support a capability model such as:

``` text
provider-native-grounding
OR
applet-web-search-grounding
```

but Phase AI-0 should not implement either real backend yet.

------------------------------------------------------------------------

## 12.5 Capability negotiation before request

Because 9router may route to different models, not every selected model
should be assumed to support every capability.

Future provider configuration should be able to express capabilities
conceptually:

``` js
{
    supportsWebSearch: true,
    supportsStreaming: false
}
```

The exact capability source is not defined in the supplied reference, so
Phase AI-0 should not invent automatic discovery.

For now, capability handling remains a future provider-level concern.

------------------------------------------------------------------------

## 12.6 Error boundaries for gateway architecture

The gateway introduces an additional failure boundary that should be
represented in the AI error contract:

``` text
Applet
  │
  ├── request validation failure
  │
  ├── network / endpoint failure
  │
  ├── 9router gateway failure
  │
  └── upstream model/provider failure
```

The UI must receive normalized errors rather than raw vendor payloads
where possible.

Examples of internal categories:

``` text
configuration_error
network_error
gateway_error
provider_error
grounding_error
invalid_response
cancelled
```

Raw API keys and sensitive authorization headers must never be included
in error messages.

------------------------------------------------------------------------

## 12.7 What is intentionally NOT imported from the reference

The reference includes **System Command Execution** through:

``` text
GLib.spawn_command_line_async
```

This must **not** be added to AI Search v1 or Phase AI-0.

It conflicts with the architecture decision that this project is:

> AI Search, not an unrestricted AI Agent.

Therefore AI output must not directly execute:

-   shell commands
-   terminal commands
-   arbitrary programs
-   multi-step command chains

The existing application launcher remains separate from AI.

A future, explicitly designed local-action feature would require a
separate architecture, permission model, allowlist, confirmation UI, and
security review. It must not be silently added through AI Search.

------------------------------------------------------------------------

## 12.8 UI reference that is compatible

The reference's concept of an instant overlay/global hotkey is already
compatible with the existing QuickSearch baseline.

For this project:

-   Keep the existing overlay.
-   Keep the existing global shortcut system unless deliberately changed
    later.
-   Do not create a second AI window.
-   AI Search mode will live inside the same existing searchbox.

This reference therefore contributes architecture input, not a
replacement UI.

------------------------------------------------------------------------

# 13. Updated Future Phase Roadmap

## Phase AI-0 --- Architecture & Isolation

-   AI module contracts
-   Mock provider/tool
-   Cancellation and stale protection
-   Normalized errors
-   No real gateway connection
-   No UI changes

## Phase AI-1 --- 9router-Compatible Provider Transport

-   OpenAI-compatible HTTP transport
-   Base URL configuration
-   API key handling
-   Selected model configuration
-   Normalized gateway/provider errors
-   No web grounding yet

## Phase AI-2 --- AI Search UI Mode

-   Add AI mode control inside the existing searchbox
-   Reuse existing overlay
-   Keep normal Search behavior unchanged
-   Route AI-mode submission to `AISearchEngine`

## Phase AI-3 --- Web Search Grounding

Evaluate and implement one controlled backend:

``` text
Provider-native grounding via 9router
        OR
Applet-controlled WebSearchTool
```

Do not couple the engine to one provider-specific grounding format.

## Phase AI-4 --- Sources and Answer Rendering

-   Answer state
-   Loading state
-   Error state
-   Normalized sources
-   Source attribution UI

## Phase AI-5 --- Capability and Provider Settings

Potential settings:

-   Enable AI Search
-   Gateway/base URL
-   API key
-   Selected model
-   Grounding mode/capability where applicable

## Phase AI-6 --- Final Regression and Security Gate

Verify:

-   Existing normal Search unchanged
-   AI cancellation safe
-   Stale responses ignored
-   Gateway errors normalized
-   Grounding errors safe
-   API keys never logged
-   AI cannot execute local commands
-   No unrestricted tool execution

# Final Architecture Decision

The existing Search-only system remains the stable baseline.

AI Search is added as a separate feature layer, with a future
9router-compatible provider transport:

``` text
EXISTING SEARCHBOX
        │
        ├── Normal Search
        │       └── SearchEngine
        │
        └── AI Search
                └── AISearchEngine
                        ├── AI Provider
                        │       └── 9router-compatible gateway transport (future)
                        ├── Web Search Tool
                        ├── Prompt Builder
                        └── Source Formatter
```

**Do not restore the old AI agent system.**

The target is a focused, controlled, grounded **AI Search** feature with
one permitted external capability: **web search**.
