# QuickSearch UI Rebuild Guide

## Preserve Current Search & AI System --- Rebuild Presentation Layer Only

**Project:** QuickSearch Cinnamon Applet\
**Scope:** UI/UX rebuild based on approved Search Mode and AI Mode
mockups\
**Implementation strategy:** Preserve existing system logic, replace
presentation/layout layer\
**Status:** Planning document for AI Agent

------------------------------------------------------------------------

# 1. Primary Objective

Rebuild the QuickSearch interface so that its visual structure matches
the approved mockup direction while preserving the existing Search and
AI systems.

This is **NOT a search engine rewrite**.

This is **NOT an AI system rewrite**.

The task is:

> **Keep the current functional system. Replace and reorganize the UI
> presentation layer.**

The desired architecture is:

``` text
CURRENT ENGINE / DATA FLOW
        ↓
KEEP
        ↓
CURRENT RESULTS / AI RESPONSE DATA
        ↓
KEEP
        ↓
OLD / MIXED UI RENDERING
        ↓
REBUILD
        ↓
NEW APPROVED QUICKSEARCH UI
```

------------------------------------------------------------------------

# 2. Hard Rules --- Do Not Rewrite the System

The AI agent must treat the existing Search and AI pipelines as
protected.

Do not redesign internal behavior merely because the UI is changing.

## 2.1 Preserve Search System

Keep the existing behavior for:

-   query processing
-   search providers
-   provider orchestration
-   asynchronous search
-   debounce
-   cancellation
-   generation / stale-result protection
-   result normalization
-   deduplication
-   scoring
-   global ranking
-   Best Match selection
-   category grouping
-   keyboard navigation
-   activation behavior
-   context actions
-   web search behavior
-   calculator behavior
-   URL handling

The new UI must consume the existing result data.

### Target relationship

``` text
User types
    ↓
Existing SearchEngine
    ↓
Existing Providers
    ↓
Existing Ranking / Best Match
    ↓
NEW UI Renderer
```

Do not replace this with a new search architecture.

------------------------------------------------------------------------

## 2.2 Preserve AI System

Keep the existing behavior for:

-   AI provider selection
-   AI request pipeline
-   conversation state
-   prompt construction
-   response intent
-   streaming
-   stream parsing
-   markdown processing
-   web grounding
-   source handling
-   source content expansion
-   citations
-   follow-up conversation
-   current AI mode behavior

The new AI interface must display the existing AI data.

### Target relationship

``` text
User asks
    ↓
Existing AI Search Engine
    ↓
Existing AI Provider / Prompt / Tools
    ↓
Existing Streaming + Response Data
    ↓
NEW AI UI Renderer
```

Do not rewrite the AI engine just to match the mockup.

------------------------------------------------------------------------

# 3. Protected Modules

The following modules should be treated as **system modules**.

Do not refactor them unless a verified bug directly prevents the UI
implementation.

``` text
searchEngine.js
result.js
utils.js
```

Providers:

``` text
providers/appProvider.js
providers/fileProvider.js
providers/webProvider.js
providers/calculatorProvider.js
providers/urlProvider.js
```

AI modules:

``` text
ai/aiFactory.js
ai/aiProvider.js
ai/aiSearchEngine.js
ai/conversationState.js
ai/nineRouterProvider.js
ai/promptBuilder.js
ai/responseIntent.js
ai/webSearchTool.js
ai/sourceContentExpander.js
ai/streamParser.js
```

## Important

Do not modify protected modules for:

-   cosmetic reasons
-   layout reasons
-   CSS convenience
-   changing category appearance
-   changing visual state
-   simplifying UI code

If a UI requirement appears difficult, solve it in the presentation
layer first.

------------------------------------------------------------------------

# 4. Primary UI Files

The redesign should focus primarily on:

``` text
applet.js
stylesheet.css
```

Allowed areas of change include:

-   overlay construction
-   Search Mode view layout
-   AI Mode view layout
-   content containers
-   result row rendering
-   result grouping
-   visual state rendering
-   spacing
-   typography
-   sizing
-   selection visuals
-   geometry
-   transitions, if lightweight
-   UI state synchronization

The goal is to improve separation between:

``` text
SYSTEM LOGIC
and
UI PRESENTATION
```

------------------------------------------------------------------------

# 5. Core Product Model

QuickSearch continues to have two separate modes.

They must remain separate.

``` text
QuickSearch
│
├── Search Mode
│   ├── Normal desktop search
│   └── Apps / files / folders / settings / web / etc.
│
└── AI Mode
    ├── Ask questions
    ├── Generate answers
    ├── Show sources
    ├── Show structured content
    └── Continue conversation
```

## Important

Do not merge Search Mode and AI Mode into one result list.

Do not make AI answers appear as a normal search provider.

Do not convert Search Mode into a chatbot.

Do not convert AI Mode into a normal search list.

The two modes should feel visually related but functionally independent.

------------------------------------------------------------------------

# 6. Shared Visual Language

The approved visual direction is:

``` text
Dark
Minimal
Modern
Desktop-first
Focused
High information density without clutter
Rounded panels
Subtle borders
Soft depth
White / neutral primary accents
```

The overall UI should avoid looking overly "AI futuristic".

Do not add:

-   excessive gradients
-   glowing neon effects
-   cyberpunk decoration
-   animated decorative backgrounds
-   unnecessary cards
-   excessive badges
-   large dashboard layouts

The design should feel closer to a modern desktop command/search
interface.

------------------------------------------------------------------------

# 7. Search Mode --- Approved Layout Direction

Search Mode follows the approved mockup structure.

The primary component is a large compact search surface at the top of
the content area.

## Search bar structure

``` text
┌──────────────────────────────────────────────┐
│ 🔍  Search apps, files, settings...     ×  [Search] │
└──────────────────────────────────────────────┘
```

Visual hierarchy:

1.  Search icon
2.  Text input
3.  Clear action
4.  Search action

The search bar should remain visually consistent across states.

Do not redesign its colors independently between states.

------------------------------------------------------------------------

# 8. Search Mode States

Search Mode has six primary visual states.

## 8.1 Idle State

Purpose:

``` text
Quick access before a search is entered.
```

Layout:

``` text
Search Bar

Quick Actions
├── Calculator
├── Browse Files
├── System Settings
└── Screenshot
```

Requirements:

-   compact
-   no unnecessary empty state card
-   quick actions should use the same visual language as search results
-   clear icon + title + optional short description
-   avoid oversized decorative areas

------------------------------------------------------------------------

## 8.2 Typing State

Purpose:

``` text
Show live results while the user types.
```

Layout:

``` text
Search Bar

Best Match
└── Highlighted primary result

Applications
├── Result
├── Result
└── Result
```

The Best Match must visually stand out without creating a completely
different component style.

Use the existing ranking output.

Do not create a new ranking algorithm.

------------------------------------------------------------------------

## 8.3 Category Results

Example categories may include:

``` text
Best Match
Applications
Settings
Files
Folders
Web
```

Requirements:

-   use existing result classification
-   do not change provider logic
-   section labels should be subtle but readable
-   category spacing should clearly separate groups
-   result rows should remain compact

Suggested row structure:

``` text
[Icon]  Title                         [Type]
        Secondary description
```

The type label should remain secondary.

------------------------------------------------------------------------

## 8.4 File Results

Search result filtering may use the existing system/category data.

Visual layout:

``` text
Search Bar

[All] [Apps] [Files] [Folders] [Settings] [Web]

📄 project-report.md
   ~/Documents/Work                         File

📕 report-2025.pdf
   ~/Documents                              File
```

Requirements:

-   preserve existing filtering behavior
-   only change visual presentation
-   active filter should be clear
-   avoid large pill-heavy decoration

------------------------------------------------------------------------

## 8.5 Web Search Results

Layout:

``` text
Search Bar

🌐 Search "query" on Google
   Open in default browser

🌐 Search "query" on YouTube
   Open in default browser

🌐 Search "query" on DuckDuckGo
   Open in default browser
```

Use the existing web provider behavior.

Do not add external search logic unless already required by the current
system.

------------------------------------------------------------------------

## 8.6 No Results

Layout:

``` text
Search Bar

        🔍

     No results found

Try a different keyword or search in specific categories.

[ Search on Google ]
[ Browse Files ]
[ Open System Settings ]
```

Requirements:

-   helpful
-   compact
-   no giant empty card
-   actionable suggestions
-   suggestions must use existing supported actions where possible

------------------------------------------------------------------------

# 9. Search Mode Result Hierarchy

The visual priority must be:

``` text
1. Search input
2. Best Match
3. Result title
4. Secondary description / path
5. Type label
6. Category heading
```

Do not allow decorative elements to compete with actual search results.

------------------------------------------------------------------------

# 10. AI Mode --- Approved Layout Direction

AI Mode is a dedicated AI interface.

It should use the same overall visual language as Search Mode:

-   same dark foundation
-   similar search/input geometry
-   similar border treatment
-   similar spacing rhythm
-   same level of visual restraint

However, AI Mode has different content states.

------------------------------------------------------------------------

# 11. AI Mode States

## 11.1 AI Idle

Layout:

``` text
┌──────────────────────────────────────────────┐
│ ✦  Ask AI anything...                    × [Search] │
└──────────────────────────────────────────────┘

[ Explain Linux permissions ]
[ Summarize this file ]
[ Check stock data ]
```

Important:

-   keep idle state simple
-   do not add a large empty card
-   search/input is the primary focus
-   suggestions are secondary

------------------------------------------------------------------------

## 11.2 AI Typing

While the user is typing:

``` text
AI Input

Suggested queries
├── related query
├── related query
├── related query
└── related query
```

This is a suggestion layer only.

Do not turn it into normal Search Mode results.

------------------------------------------------------------------------

## 11.3 AI Thinking

Layout:

``` text
AI Input


        ◌

   AI is thinking...

This may take a few seconds.

[ Searching knowledge ]
[ Reading sources ]
[ Generating answer ]
```

Requirements:

-   clear progress feedback
-   minimal
-   no fake technical telemetry
-   no excessive animation
-   must reflect real AI pipeline state where available

------------------------------------------------------------------------

## 11.4 AI Answer --- Text

Layout:

``` text
AI Input

✦ AI Answer

Structured answer content

Heading

Explanation...

1. Step one
2. Step two

[ Source ] [ Source ] [ Source ]

┌──────────────────────────────────────────────┐
│ Ask a follow-up...                       ➤ │
└──────────────────────────────────────────────┘
```

Requirements:

-   preserve current markdown rendering
-   preserve citations
-   preserve sources
-   preserve existing AI answer content
-   UI may be reformatted but data must not be lost

------------------------------------------------------------------------

## 11.5 AI Answer With Structured Data / Chart

If the existing AI response contains structured data or a supported
visualization:

``` text
AI Input

✦ AI Answer

Summary

┌────────────────────────────────┐
│ Structured Data / Chart        │
│                                │
│ Existing visualization output  │
└────────────────────────────────┘

Analysis

Sources

Follow-up Input
```

Important:

Do not create a new chart data engine during this UI phase.

The UI must only display visualization data already supported by the
AI/data system.

------------------------------------------------------------------------

## 11.6 AI Answer With File Context

Layout:

``` text
AI Input

Selected Context
📄 project-report.md
   ~/Documents/Work

✦ AI Answer

Structured explanation

Key points

Summary

Follow-up Input
```

Preserve the existing file/context logic.

Only redesign presentation.

------------------------------------------------------------------------

# 12. Shared Input Philosophy

Search Mode and AI Mode should have related input components.

Conceptually:

``` text
SEARCH MODE
🔍 Search apps, files, settings...

AI MODE
✦ Ask AI anything...
```

Both should share:

-   geometry
-   border language
-   dark background treatment
-   clear button placement
-   action button placement
-   typography scale

Only the identity/icon and functional behavior differ.

------------------------------------------------------------------------

# 13. Avoid UI Patch Accumulation

Do not solve the redesign with repeated local overrides such as:

``` text
move this 8px
offset this container
special-case this state
override previous geometry
add another wrapper only for one mode
```

The target is a clean view hierarchy.

Preferred structure:

``` text
QuickSearchOverlay
│
├── Header / Mode Context
│
├── Shared Input Area
│
└── Content Area
    │
    ├── SearchView
    │   ├── Idle
    │   ├── Results
    │   └── Empty
    │
    └── AIView
        ├── Idle
        ├── Thinking
        └── Conversation
```

The exact implementation can differ, but the ownership must be clear.

------------------------------------------------------------------------

# 14. SearchView and AIView Ownership

The project already moved toward:

``` text
ContentArea
├── SearchView
└── AIView
```

Continue this direction.

Do not create competing view ownership.

Avoid situations where:

``` text
SearchView controls AI geometry
AIView hides SearchView children individually
Old renderer adds widgets directly to root
New renderer adds widgets to another parent
```

Each view should own its own visual content.

Mode switching should primarily change:

``` text
VISIBLE VIEW
ACTIVE INPUT MODE
RENDERED CONTENT
```

not repeatedly destroy and rebuild unrelated system logic.

------------------------------------------------------------------------

# 15. Known Issue to Verify Before UI Work

There was an identified UI construction-order risk around SearchView
usage.

The code path should be audited to ensure that UI objects are created
before they are accessed.

Bad pattern:

``` text
this._searchView.add(widget);

// _searchView created later
this._searchView = new ...
```

Required rule:

``` text
Create parent
    ↓
Create children
    ↓
Add children
    ↓
Attach parent to content area
```

The AI agent must verify the construction order before adding new UI
components.

Do not hide initialization bugs with broad `try/catch`.

A `try/catch` should not silently conceal a missing UI component.

------------------------------------------------------------------------

# 16. Phase Plan

# PHASE 1 --- Search Mode UI Rebuild

## Scope

Rebuild only the Search Mode presentation.

Implement:

``` text
Search Input
Idle State
Quick Actions
Typing Results
Best Match
Category Results
File Results
Web Results
No Results
Selection Styling
Keyboard Navigation Visual State
```

## Must Not Change

``` text
Search engine
Providers
Ranking
Best Match logic
Filtering logic
Activation logic
Context actions
AI engine
AI prompt
AI response handling
```

## Phase 1 Success Criteria

-   Search behaves exactly as before
-   Existing search tests still pass
-   Results still come from existing providers
-   Ranking is unchanged
-   UI matches approved mockup direction
-   No AI regression
-   No duplicate widgets
-   No stale result rendering
-   No geometry glitches after reload

------------------------------------------------------------------------

# PHASE 2 --- AI Mode UI Rebuild

Only start after Phase 1 Search Mode is stable.

## Scope

Rebuild:

``` text
AI Idle
AI Suggestions
AI Typing
AI Thinking
AI Answer
Markdown Presentation
Sources Presentation
File Context Presentation
Follow-up Input
Conversation Layout
Structured Data / Visualization Area
```

## Must Not Change

``` text
AI provider
AI API flow
Prompt builder
Conversation state
Streaming parser
Grounding
Web search tools
Source expansion
Citation data
Response intent logic
```

## Phase 2 Success Criteria

-   Current AI functionality remains intact
-   Streaming still works
-   Sources still work
-   Follow-up conversation still works
-   Markdown remains readable
-   No missing answer content
-   No first-query/reload glitch
-   UI matches approved AI mockup direction

------------------------------------------------------------------------

# 17. Regression Rules

After each significant UI change:

``` text
1. Run syntax validation
2. Run existing tests
3. Check Search Mode manually
4. Check AI Mode manually
5. Reload Cinnamon / applet
6. Test first query after reload
7. Test mode switching
8. Test keyboard navigation
9. Test empty/no-result state
10. Test long result list
```

The first query after reload is mandatory because previous regressions
appeared during initial state initialization.

------------------------------------------------------------------------

# 18. Manual Test Matrix

## Search Mode

``` text
[ ] Open applet
[ ] Idle state appears correctly
[ ] Quick action activation works
[ ] Search application
[ ] Search settings
[ ] Search file
[ ] Search folder
[ ] Search web query
[ ] Calculator query
[ ] URL query
[ ] Best Match is correct
[ ] Category grouping is correct
[ ] Keyboard up/down works
[ ] Enter activates selected result
[ ] Escape behavior works
[ ] Clear button works
[ ] No Results state works
[ ] First query after reload works
```

## AI Mode

``` text
[ ] Switch to AI Mode
[ ] AI idle state works
[ ] First AI query after reload works
[ ] Thinking state appears
[ ] Answer renders completely
[ ] Streaming works
[ ] Markdown works
[ ] Sources work
[ ] File context works
[ ] Follow-up works
[ ] Mode switching during/after answer is safe
[ ] Long answer layout remains stable
```

------------------------------------------------------------------------

# 19. Visual Acceptance Criteria

The final UI should feel:

``` text
Focused
Modern
Minimal
Fast
Desktop-native
Consistent
```

The UI should not feel:

``` text
Overdesigned
Dashboard-like
Overly futuristic
Card-heavy
Patchwork
Inconsistent between modes
```

Search Mode and AI Mode should clearly belong to the same application
while retaining their different purposes.

------------------------------------------------------------------------

# 20. Definition of Done

The redesign is complete only when:

``` text
✓ Existing Search system preserved
✓ Existing AI system preserved
✓ Search Mode matches approved visual direction
✓ AI Mode matches approved visual direction
✓ No duplicate UI components
✓ No initialization-order bugs
✓ No first-query-after-reload glitch
✓ Keyboard navigation preserved
✓ Context actions preserved
✓ Existing tests pass
✓ Syntax checks pass
✓ Search and AI mode switching is stable
✓ No unnecessary protected-module rewrites
```

------------------------------------------------------------------------

# Final Instruction to AI Agent

**Do not solve this task by rewriting working systems.**

The project already has a substantial Search and AI implementation.

Your responsibility is to improve the presentation layer while
preserving functional behavior.

Use this rule for every change:

``` text
Can this be solved in UI?
        ↓
YES
        ↓
Do not modify system logic.
```

Only modify core logic when there is a verified functional defect that
cannot be solved in the UI layer.

The target outcome is:

> **The same QuickSearch system the user already has, presented through
> a cleaner, modern, consistent interface based on the approved Search
> Mode and AI Mode mockups.**
