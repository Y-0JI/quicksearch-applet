# PHASE 8 — AI CHAT UX & INTERACTION LIFECYCLE

## Background

Phase 7 regression and manual verification confirmed that the core system is working:

```text
Core Search → PASS
AI Request → PASS
AI Streaming → PASS
AI Tool Call → PASS
Web Search → PASS
SearXNG Integration → PASS
Search Result Parsing → PASS
Search Result Normalization → PASS
Grounding Context → PASS
Grounded AI Response → PASS
Sources UI → PASS
```

However, manual runtime verification identified two important UX gaps:

1. User cannot stop/cancel an active AI request from the UI.
2. AI interaction behaves as a single-response view; when the user sends a new message, the previous answer disappears.

Phase 8 closes these interaction gaps before adding more advanced Agent/Tool capabilities.

---

# PHASE 8 GOAL

Transform:

```text
Single Query
→ Single Response
→ Response Replaced by Next Query
```

into:

```text
Conversation
→ Message History
→ Multi-turn Context
→ Active Request Lifecycle
→ User Stop/Cancel Control
```

At the end of Phase 8, the user must be able to:

- see previous messages and AI responses;
- continue a conversation with follow-up questions;
- allow AI to receive relevant conversation history;
- stop an active AI request;
- stop a Web Search / Tool execution belonging to the active request;
- stop the second grounded AI request after Web Search;
- immediately start a new request after cancellation without stale output.

---

# 1. CONVERSATION MESSAGE MODEL

Introduce a canonical conversation message model.

Minimum structure:

```text
{
    id,
    role,
    content,
    timestamp,
    status
}
```

Roles:

```text
user
assistant
system (internal only if required)
```

Assistant status:

```text
streaming
complete
cancelled
error
```

Do not use raw UI rows as the source of truth.

Architecture:

```text
Conversation State
        ↓
Message Model
        ↓
UI Rendering
```

The message model must be independent from visual representation.

---

# 2. PRESERVE CONVERSATION HISTORY IN UI

Change current behavior:

```text
User A
→ AI Answer A

User B
→ replace AI Answer A
```

to:

```text
User A
AI A

User B
AI B
```

Previous messages must remain visible.

Example:

```text
User:
Halo

AI:
Halo, ada yang bisa saya bantu?

User:
Bisa jelaskan lebih detail?

AI:
...
```

Avoid:

- flicker;
- duplicate messages;
- old messages disappearing;
- streaming content resetting.

Prefer incremental rendering.

---

# 3. MULTI-TURN AI CONTEXT

The next user message must be able to reference the previous conversation.

Example:

```text
User:
Apa itu Linux?

AI:
Linux adalah ...

User:
Siapa pembuatnya?

AI:
Linus Torvalds ...
```

The AI request must receive relevant previous context.

Conceptually:

```text
System Context
+
Conversation History
+
Current User Message
```

Do not rely only on the latest user input.

---

# 4. HISTORY WINDOW / CONTEXT LIMIT

Conversation history must not grow indefinitely.

Implement a bounded context strategy:

```text
Recent conversation messages
→ included in AI context

Older messages
→ excluded when context limit reached
```

Requirements:

- current user message always included;
- recent messages prioritized;
- configured/request context limits respected;
- UI history may remain visible even when older messages are no longer sent;
- context trimming must preserve role ordering.

Do not implement complex long-term memory or summarization in this phase unless already supported.

A bounded recent-history window is sufficient.

---

# 5. STREAMING MESSAGE LIFECYCLE

When the user sends a message:

```text
User Message
↓
append user message
↓
create empty assistant message
↓
status = streaming
↓
AI chunks arrive
↓
append chunks to same assistant message
↓
complete
```

Do not create one assistant message per stream chunk.

Do not replace the full conversation during streaming.

The same assistant message transitions:

```text
empty
→ streaming
→ complete
```

---

# 6. STOP / CANCEL UI CONTROL

Add an explicit user-visible Stop/Cancel control.

Recommended interaction:

```text
Idle
→ Send action visible

Request Active
→ Stop action visible

Cancelled / Complete / Error
→ Send action restored
```

The visual design must match the existing QuickSearch UI.

Do not create a second cancellation system if cancellation already exists internally.

The UI Stop action must call the active-request cancellation lifecycle.

---

# 7. UNIFIED REQUEST LIFECYCLE

Stop must work for the complete AI lifecycle:

```text
IDLE
  ↓
AI_REQUEST_1
  ↓
TOOL_EXECUTION (optional)
  ↓
WEB_SEARCH (optional)
  ↓
GROUNDING
  ↓
AI_REQUEST_2 (optional)
  ↓
COMPLETE
```

At any active stage:

```text
STOP
  ↓
CANCEL
  ↓
cleanup active request
  ↓
invalidate stale callbacks
  ↓
UI returns to IDLE
```

## 7.1 First AI Request

```text
AI starts streaming
→ user presses Stop
→ stream stops
→ no late chunks appear
```

## 7.2 Tool / Web Search

```text
AI requests web_search
→ backend pending
→ user presses Stop
→ no search result continues into grounding
→ no second AI request starts
```

## 7.3 Grounded Second AI Request

```text
Web Search complete
→ grounded AI request starts
→ user presses Stop
→ stream stops
→ no late response appears
```

---

# 8. CANCELLED MESSAGE STATE

Do not silently delete the assistant message when cancellation happens.

Recommended behavior:

```text
User:
Explain ...

AI:
partial response...
[Stopped]
```

Requirements:

- partial content may remain visible;
- assistant status becomes `cancelled`;
- request is no longer active;
- Stop control disappears;
- user can immediately send a new message.

No late chunk may be appended after `cancelled`.

---

# 9. ERROR MESSAGE STATE

Errors must preserve conversation history.

Example:

```text
User:
...

AI:
Unable to complete this request.
[Error details if appropriate]
```

Do not clear previous messages.

Error belongs to the current assistant interaction, not the entire conversation.

Existing diagnostic stage information must remain available without exposing secrets.

---

# 10. WEB SEARCH SOURCES PER MESSAGE

Sources must belong to the assistant message that produced them.

Do not maintain a single global Sources UI that can be replaced by the next message.

Concept:

```text
Assistant Message A
  content
  sources

Assistant Message B
  content
  sources
```

Expected:

```text
User A
AI A
Sources A

User B
AI B
Sources B
```

Previous Sources remain attached to the correct response.

---

# 11. RACE CONDITION PROTECTION

Conversation mode adds stale-output risks:

```text
Request A
→ user sends Request B
→ late A chunk arrives
```

Late A must never modify:

- Request B assistant message;
- Request B sources;
- active UI state.

Use stable request/message identity.

Do not rely only on the currently visible row.

---

# 12. RAPID SEND BEHAVIOR

Choose one deterministic contract.

Recommended initial contract:

```text
New Send while active
→ cancel current request
→ preserve partial response as cancelled
→ append new user message
→ start new request
```

Do not allow uncontrolled concurrent AI requests.

The selected contract must be documented and tested.

---

# 13. CONVERSATION RESET

Add a deterministic way to reset the current conversation:

```text
Reset Conversation
→ cancel active request if needed
→ clear conversation model
→ clear conversation UI
→ next request starts fresh
```

Do not leave:

- old sources;
- stale request IDs;
- old streaming state;
- old cancellation state.

The UI trigger should follow existing QuickSearch conventions.

---

# 14. SETTINGS / CONFIGURATION

Avoid unnecessary settings expansion.

Only add settings if required.

Possible optional setting:

```text
Conversation history limit
```

Defaults must be safe.

Do not add persistent long-term AI memory in Phase 8.

---

# 15. TEST COVERAGE

Add regression tests for the conversation lifecycle.

## 15.1 Conversation model/UI

```text
send User A
→ append User A

receive AI A
→ append/update AI A

send User B
→ User A and AI A remain
→ append User B

receive AI B
→ append/update AI B
```

## 15.2 Multi-turn context

Verify that the AI request/context builder receives relevant prior history, not merely that history is visible in UI.

## 15.3 Streaming

Verify:

```text
one assistant message
→ multiple chunks
→ same message updated
```

No duplicate assistant messages per chunk.

## 15.4 Cancel first AI request

```text
AI request pending
→ Stop
→ cancel
→ late chunk ignored
→ message remains cancelled
```

## 15.5 Cancel Web Search

```text
AI tool call
→ Web Search pending
→ Stop
→ no grounding
→ no second AI request
```

## 15.6 Cancel grounded AI request

```text
Web Search success
→ second AI request pending
→ Stop
→ late chunks ignored
```

## 15.7 Source ownership

Verify:

```text
AI Response A + Sources A
AI Response B + Sources B
```

Sources cannot migrate between messages.

## 15.8 Rapid Query

Verify the selected new-send contract.

Late output from an old request cannot appear in the new message.

## 15.9 Reset Conversation

Verify:

```text
reset
→ no old messages
→ no old sources
→ next request starts clean
```

---

# 16. MANUAL CINNAMON/GJS VERIFICATION

Before Phase 8 is complete, test:

## A. Conversation

```text
Question 1
→ Answer 1 remains visible

Question 2
→ Answer 2 appears

Question 3 referencing Question 1
→ AI receives prior context
```

## B. Streaming

```text
AI streams
→ one assistant message updates
→ no duplicated messages
```

## C. Stop AI

```text
Long AI response
→ Stop
→ partial response remains
→ no late output
→ Send works again
```

## D. Stop Web Search

```text
Web search query
→ Stop during search
→ no grounded answer starts
→ no late Sources appear
```

## E. Stop Grounded Response

```text
Web Search completes
→ AI grounded response starts
→ Stop
→ no late chunks
```

## F. Rapid new message

```text
Request A active
→ send Request B
→ A cannot overwrite B
```

## G. Reset

```text
conversation exists
→ reset
→ conversation cleared
→ next query starts fresh
```

---

# 17. OUT OF SCOPE

Do not implement:

- long-term persistent AI memory;
- multi-agent system;
- additional search providers;
- new external AI providers;
- autonomous background agent;
- tool marketplace;
- complex conversation summarization;
- voice input;
- file attachment chat;
- image/vision chat.

Phase 8 focuses on making the existing AI integration complete and controllable.

---

# ACCEPTANCE CRITERIA

Phase 8 is complete only when:

```text
[ ] Previous conversation messages remain visible.
[ ] User can perform multi-turn conversation.
[ ] Relevant recent history reaches the AI request.
[ ] Streaming updates one assistant message.
[ ] Stop control appears during active AI lifecycle.
[ ] Stop cancels first AI request.
[ ] Stop cancels Tool/Web Search stage.
[ ] Stop prevents second grounded AI request when cancelled before it starts.
[ ] Stop cancels grounded AI response.
[ ] Late chunks/results never appear after cancel.
[ ] Sources belong to the correct assistant message.
[ ] Rapid new request cannot be overwritten by stale output.
[ ] Conversation reset works cleanly.
[ ] Full automated test suite passes.
[ ] Cinnamon/GJS manual verification passes.
```

---

# EXIT CRITERIA

After Phase 8:

```text
QuickSearch AI

Search
+
AI
+
Web Search
+
Grounding
+
Conversation History
+
Multi-turn Context
+
Streaming
+
Stop / Cancel Lifecycle
+
Per-message Sources

= Complete AI Chat Interaction Baseline
```

Only after this interaction baseline is stable should the project proceed to more advanced capabilities such as additional Agent Tools or Agent workflows.
