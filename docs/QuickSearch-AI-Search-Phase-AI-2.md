# QuickSearch AI Search — Phase AI-2
## AI Search UI Integration & Mode Routing

**Project:** QuickSearch Cinnamon Applet  
**Phase:** AI-2  
**Status:** Ready for Implementation  
**Depends on:** Phase AI-1 FINAL PASS

---

## 1. Purpose

Phase AI-1 completed the provider/transport foundation:

```text
AISearchEngine
      ↓
AIProvider
      ↓
NineRouterProvider
      ↓
9router Gateway
```

Phase AI-2 integrates that foundation into the existing QuickSearch UI.

The goal is **not** to create a second search window, a separate AI applet, or a chat application.

Target:

```text
One existing QuickSearch overlay
        ↓
One existing searchbox
        ↓
Two modes inside the same searchbox

Normal Search
AI Search
```

The existing Normal Search experience must remain intact.

---

## 2. Core UX Requirement

Keep the existing searchbox and its layout.

Conceptually:

```text
┌──────────────────────────────────────────────────────┐
│  🔎  Search...                           ✨ Mode AI  │
└──────────────────────────────────────────────────────┘
```

AI active:

```text
┌──────────────────────────────────────────────────────┐
│  ✨  Ask AI...                              AI ON    │
└──────────────────────────────────────────────────────┘
```

Rules:

- Do not create a second searchbox.
- Do not redesign the existing QuickSearch overlay.
- Do not significantly change searchbox position or dimensions.
- The AI mode control must live inside the existing searchbox area.
- Preserve the existing rounded searchbox visual identity.

---

## 3. AI-2 Scope

### Included

1. AI mode control inside the existing searchbox.
2. Two explicit modes: `search` and `ai`.
3. Default mode remains Normal Search.
4. Query routing based on active mode.
5. Basic loading state.
6. Basic AI answer rendering.
7. Basic error rendering.
8. Safe mode switching.
9. Cancellation when switching mode, closing overlay, or replacing a request.
10. Stale response protection.
11. Keyboard integration.
12. Full Normal Search regression protection.

### Explicitly Not Included

Do NOT implement in AI-2:

- Web Search Tool / Search Grounding
- sources or citations UI
- streaming
- chat history
- follow-up conversation
- complex markdown renderer
- tool calling
- agent workflow
- system commands
- terminal execution
- Local Actions
- screen capture
- computer control

AI-2 is strictly:

```text
Existing Search UI
        +
Mode selection
        +
AI request routing
        +
Basic response display
```

---

## 4. Architecture

### Normal Search

```text
User Input
    ↓
applet.js
    ↓
SearchEngine
    ↓
App / File / URL / Calculator / Web
    ↓
Existing result UI
```

### AI Search

```text
User Input
    ↓
applet.js
    ↓
AISearchEngine
    ↓
AIProvider
    ↓
NineRouterProvider
    ↓
9router
    ↓
AI response
    ↓
AI result UI
```

### Mandatory boundary

`applet.js` must NOT contain direct 9router HTTP logic.

Forbidden:

```text
applet.js
    ↓
HTTP/fetch/Soup
    ↓
9router
```

Required:

```text
applet.js
    ↓
AISearchEngine
    ↓
AIProvider
    ↓
NineRouterProvider
    ↓
9router
```

The UI layer only knows:

```text
start AI query
receive answer
receive error
cancel query
```

---

## 5. Mode State

Use only:

```js
'search'
'ai'
```

Recommended conceptual state:

```js
this._mode = 'search';

this._aiLoading = false;
this._aiAnswer = '';
this._aiError = null;
```

Do not add unrelated modes:

```text
chat
agent
tool
thinking
followUp
computer
```

---

## 6. Default Behavior

When QuickSearch opens:

```text
Mode = search
```

Existing behavior remains:

```text
Typing
    ↓
SearchEngine
    ↓
Apps / Files / URL / Calculator / Web
```

AI mode must not become the automatic default.

---

## 7. Searchbox Mode Control

The control must be inside the existing searchbox.

Concept:

```text
[ Search icon ] [ Input text................ ] [ ✨ Mode AI ]
```

Switch:

```text
search
   ↓
toggle
   ↓
ai
```

The active mode must be visually clear.

Acceptable indicators:

- search icon changes to AI icon
- placeholder changes
- mode label changes
- subtle active styling

Do not use an oversized control that changes the existing layout.

---

## 8. Placeholder

Normal mode retains the existing search placeholder behavior.

AI mode may use:

```text
Ask AI...
```

Changing the placeholder is only a mode indicator.

Do not recreate the search entry actor unnecessarily.

---

## 9. Query Routing

### Search mode

```text
mode === 'search'
      ↓
SearchEngine
```

Existing behavior remains unchanged.

### AI mode

```text
mode === 'ai'
      ↓
AISearchEngine
```

Do not run Normal Search and AI Search in parallel for the same query.

AI-2 behavior:

```text
AI mode
    ↓
AISearchEngine only
```

---

## 10. Enter Behavior

In AI mode:

```text
Type query
    ↓
Press Enter
    ↓
Submit to AISearchEngine
```

Enter must not activate a stale Normal Search row.

Conceptual priority:

```js
if (this._mode === 'ai')
    submitAIQuery();
else
    existingNormalSearchEnterBehavior();
```

---

## 11. Loading State

When AI request starts:

```text
AI request
    ↓
_aiLoading = true
    ↓
Render basic loading state
```

Example:

```text
Thinking...
```

AI-2 does not require token streaming.

Loading must clear on:

```text
success
error
cancel
mode switch
overlay close
```

---

## 12. Answer Rendering

AI-2 only needs a basic text answer.

Flow:

```text
AI response
      ↓
clear loading
      ↓
store answer
      ↓
render answer
```

Plain text is sufficient.

Do not introduce a complex markdown system unless already required by existing code.

---

## 13. Error Rendering

On request failure:

```text
error
    ↓
_aiLoading = false
    ↓
_aiError = error
    ↓
render concise error
```

Example:

```text
Unable to get an AI response.
```

Never expose:

- API keys
- authorization headers
- secret provider details

Cancellation caused by switching mode, closing the overlay, or replacing a request should not appear as a normal user-facing error.

---

## 14. Mode Switch Lifecycle

### Search → AI

```text
Search active
      ↓
Switch to AI
      ↓
Stop obsolete Normal Search work if required
      ↓
Clear Normal Search UI state
      ↓
Clear previous AI state
      ↓
Update mode
      ↓
Update placeholder/icon
      ↓
Keep entry focused
```

### AI → Search

```text
AI active
      ↓
Switch to Search
      ↓
AISearchEngine.cancel()
      ↓
Clear AI loading/answer/error
      ↓
Restore Normal Search UI behavior
      ↓
Keep entry focused
```

An old AI response must never overwrite the new Normal Search UI.

---

## 15. Stale Response Protection

Mandatory example:

```text
AI mode
    ↓
Request A starts
    ↓
User switches to Search
    ↓
Request A completes late
```

Expected:

```text
Request A MUST NOT render.
```

Also:

```text
Request A
    ↓
Request B starts
    ↓
A completes after B
```

Expected:

```text
Only the current valid request may update the UI.
```

Reuse existing generation/cancellation lifecycle patterns where possible.

---

## 16. Overlay Close

When overlay closes while AI is pending:

```text
overlay close
      ↓
AISearchEngine.cancel()
      ↓
clear loading state
      ↓
late response ignored
```

The next overlay open must not inherit:

```text
old loading
old answer
old error
```

Recommended AI-2 behavior: reopening starts in Normal Search mode.

---

## 17. Keyboard Behavior

### Search mode

Keep existing:

```text
Arrow keys
selection
Enter
Escape
```

### AI mode

Minimum:

```text
Enter → submit AI query
Escape → existing overlay close behavior
```

A stale Normal Search selection must not activate while AI mode is active.

---

## 18. File Responsibilities

### `applet.js`

Responsible for:

```text
UI
mode state
mode switching
query routing
loading state
answer/error rendering
keyboard integration
overlay lifecycle
```

Not responsible for:

```text
9router HTTP details
provider parsing
provider authentication
transport implementation
```

### `ai/aiSearchEngine.js`

Responsible for:

```text
AI query lifecycle
provider invocation
cancellation
stale request protection
```

### `ai/aiProvider.js`

Responsible for:

```text
provider contract
```

### `ai/nineRouterProvider.js`

Responsible for:

```text
9router transport
request serialization
response parsing
timeout
cancellation
secret-safe errors
```

---

## 19. Test Requirements

### Mode

1. Default mode is `search`.
2. Switching to AI sets `ai`.
3. Switching back restores `search`.
4. Mode switch clears obsolete state.

### Routing

5. Search mode calls `SearchEngine`.
6. AI mode calls `AISearchEngine`.
7. AI mode does not submit the same query to Normal Search providers.
8. Search mode does not submit normal queries to AI.

### Lifecycle

9. Closing overlay cancels pending AI.
10. Switching AI → Search cancels pending AI.
11. New AI request invalidates/cancels old request.
12. Late response after mode switch does not render.
13. Late response after overlay close does not render.

### Keyboard

14. Enter in AI mode submits AI.
15. Enter in Search mode retains existing behavior.
16. Escape retains existing behavior.
17. Old Search selection cannot activate in AI mode.

### UI state

18. Pending request shows loading.
19. Success clears loading and renders answer.
20. Error clears loading and renders error.
21. Cancellation from mode switch/close does not show misleading error.

### Regression

22. Existing Normal Search tests remain green.
23. App/File/URL/Calculator/Web remain unchanged.
24. Existing keyboard selection remains unchanged.
25. Existing context-menu/floating action button behavior remains unchanged.

---

## 20. Verification

Run:

```bash
node --check applet.js
node --check ai/aiProvider.js
node --check ai/aiSearchEngine.js
node --check ai/nineRouterProvider.js
```

Then:

```bash
node --test
```

Do not mark AI-2 complete based only on new AI tests.

Full regression must pass.

---

## 21. Manual Test Checklist

### Normal Search

```text
[ ] Open QuickSearch
[ ] Default mode is Search
[ ] Search application
[ ] Search file
[ ] Search URL
[ ] Search calculator
[ ] Search web
[ ] Keyboard navigation works
[ ] Enter behavior works
```

### AI

```text
[ ] Click Mode AI
[ ] Existing searchbox remains the only searchbox
[ ] Visual mode changes
[ ] Placeholder changes
[ ] Entry stays focused
[ ] Type AI question
[ ] Press Enter
[ ] Loading appears
[ ] Answer renders
```

### Cancellation

```text
[ ] Start AI request
[ ] Switch to Search before completion
[ ] No late answer appears

[ ] Start AI request
[ ] Close overlay
[ ] Reopen
[ ] No old loading/answer remains

[ ] Start request A
[ ] Start request B
[ ] A cannot overwrite B
```

### Error

```text
[ ] Failed AI request shows concise error
[ ] UI does not crash
[ ] API key is never shown
```

---

## 22. Scope Guard

Do not expand AI-2 into:

```text
chat application
agent system
tool calling
computer control
terminal automation
web grounding
source cards
streaming
conversation memory
AI vision
```

If a feature is not required for:

```text
Mode AI
    ↓
Submit query
    ↓
Receive basic answer
```

it belongs to a later phase.

---

## 23. Definition of Done

AI-2 is complete only when:

```text
✓ Existing QuickSearch overlay remains intact
✓ Existing searchbox remains the only searchbox
✓ AI mode control exists inside searchbox
✓ Default mode remains Normal Search
✓ Search mode routes to SearchEngine
✓ AI mode routes to AISearchEngine
✓ applet.js does not call 9router directly
✓ Enter in AI mode submits AI
✓ Loading state works
✓ Basic answer rendering works
✓ Basic error rendering works
✓ AI cancels on mode switch
✓ AI cancels on overlay close
✓ Stale responses cannot overwrite current UI
✓ Normal Search keyboard behavior remains intact
✓ Existing Search providers remain unchanged
✓ Full regression passes
✓ No Web Grounding yet
✓ No streaming yet
✓ No Local Actions yet
```

---

## 24. Expected End State

```text
                     QuickSearch
                          │
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
        Normal Search              AI Search
              │                       │
              ▼                       ▼
         SearchEngine            AISearchEngine
              │                       │
              ▼                       ▼
       Existing Providers         AIProvider
                                      │
                                      ▼
                              NineRouterProvider
                                      │
                                      ▼
                                   9router
```

This phase creates the UI and routing foundation for later phases without prematurely adding Web Grounding, sources, streaming, or system-control capabilities.
