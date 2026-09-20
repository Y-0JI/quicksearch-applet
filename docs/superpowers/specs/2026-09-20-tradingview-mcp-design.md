# TradingView MCP — Financial Market Data Source — Design Doc

Date: 2026-09-20
Status: REVISED-3 (final 3 corrections, no code, no commit)
Plan: A (isolated `ai/marketData/*`, injected transport, mock-first, read-only)

Revision note (2026-09-20, review result): P0 protocol-version awareness,
P1 DCR unverified params, P1 market-data-native source model, P1 price-tool
discovery, P1 per-tool timeframe validation, P2 financial false-positive guard,
P2 screener-columns caching, P2 expanded test list. No implementation yet.

Revision note 3 (2026-09-20, final 3 corrections): server/discover treated as
capability behavior, NOT a guaranteed TradingView endpoint (verified at
authenticated QA); session-id expectation made protocol-dependent (missing id =
error on session-based, normal on stateless); "quote call" terminology removed
in favor of "market-price data call". No code, no commit.

Scope guard: ADDITIONAL financial data source. Search UI, ranking, renderer,
normal Search, SearXNG transport, web retrieval, Generative UI, Markdown
renderer: untouched.

## 0. Verified facts (probe 2026-09-20, not assumptions)

- `GET https://mcp.tradingview.com/mcp` → `401`, header
  `WWW-Authenticate: Bearer resource_metadata="https://mcp.tradingview.com/.well-known/oauth-protected-resource/mcp"`,
  body `{"detail":"This server requires OAuth authentication"}`.
- `POST /mcp initialize` without token → same `401`. Auth is mandatory, fail closed.
- Protected-resource metadata (working):
  `GET /.well-known/oauth-protected-resource/mcp` →
  `{"resource":"https://mcp.tradingview.com/mcp","authorization_servers":["https://www.tradingview.com"],"bearer_methods_supported":["header"]}`.
  The non-path variant is deprecated (server says so explicitly).
- Authorization-server metadata `GET https://www.tradingview.com/.well-known/oauth-authorization-server`:
  - `issuer`: `https://www.tradingview.com`
  - `authorization_endpoint`: `https://www.tradingview.com/mcp/oauth/authorize`
  - `token_endpoint`: `https://www.tradingview.com/mcp/oauth/token`
  - `jwks_uri`: `https://www.tradingview.com/mcp/oauth/jwks.json`
  - `revocation_endpoint`: `https://www.tradingview.com/mcp/oauth/revoke`
  - `response_types_supported`: `["code"]`
  - `grant_types_supported`: `["authorization_code","refresh_token"]`
  - `token_endpoint_auth_methods_supported`: `["none","client_secret_basic","client_secret_post"]`
  - `code_challenge_methods_supported`: `["S256"]`
  - `scopes_supported`: `["mcp:read","mcp:tools"]`
  - `registration_endpoint`: `https://www.tradingview.com/mcp/oauth/register`
- `GET authorize` with dummy `client_id` → `400` (expected, no valid client).
- DCR `POST register` with real body NOT probed (would create a client); deferred
  to implementation phase against live metadata.
- Docs (fetched): endpoint `https://mcp.tradingview.com/mcp`, OAuth 2.1 via
  browser sign-in, rate limit ~100 req/min/user, beta, data may be delayed.
- Secret storage: `gnome-keyring-daemon` running (secrets component),
  `Secret-1.typelib` present, `gi.repository.Secret` verified working.
  BUT: zero existing applets in repo use `gi.Secret`; GJS-side access
  unverified. No plaintext-token setting will be created as final design.

## A. MCP lifecycle (protocol-version aware, P0)

No authenticated protocol negotiation has been observed yet: unauthenticated
probes return 401 BEFORE any `initialize` exchange, so the status of BOTH the
legacy handshake path and the modern path is NOT YET OBSERVED /
UNVERIFIED. Neither path is assumed present or absent — both are
capability-gated at runtime, fail closed otherwise.

Legacy path (capability-gated, never assumed):
1. `POST /mcp` `initialize` `{protocolVersion, capabilities, clientInfo}`.
2. `notifications/initialized` (notification, no reply expected).
3. `tools/list` → cache; filter to read-only allowlist.
4. `tools/call` per planner need.

Modern path (capability-gated, never assumed — server/discover NOT guaranteed):
`server/discover` is a MODERN MCP protocol capability, NOT a verified
TradingView endpoint. Whether TradingView exposes/accepts it is UNVERIFIED
until first authenticated QA. Rules:
1. If the negotiated protocol/capabilities advertise a discovery mechanism
   (e.g. `server/discover`), follow exactly what the server advertises —
   discovery response determines the valid capability/tool flow, and the
   client MUST NOT jump straight to `tools/list` when discovery is required.
2. If the negotiated protocol uses another discovery mechanism, follow the
   actual server capability contract as observed — never a pre-baked
   TradingView-specific flow.
3. If required discovery is unavailable/unsupported → fail closed
   (`unsupported_protocol` / `invalid_response` per actual server response).
4. No TradingView-specific discovery flow is invented in this doc; the first
   authenticated QA records what was actually observed and narrows this section.

Version-aware rules (fail closed):
- Transport takes its `SUPPORTED_PROTOCOL_VERSIONS` from injected
  configuration, NOT a frozen constant. Proposed shipped default (newest-first):
  `["2026-07-28", "2025-11-25", "2025-06-18"]`. No entry is treated as
  confirmed: which version TradingView accepts with a real authenticated
  request is UNVERIFIED — first authenticated QA MUST log and pin the accepted
  version before any further work, and the default list is then narrowed to
  what was actually observed.
- The negotiated version determines the flow: legacy versions →
  `initialize`/`notifications/initialized` + session id per that version's
  contract; modern versions → follow ONLY the discovery mechanism the server
  actually advertises (verified at authenticated QA — never a pre-baked
  `server/discover`-first assumption).
  Flows are NEVER mixed (no `server/discover` + `notifications/initialized`
  hybrid unless the server explicitly advertises it).
- `Mcp-Session-Id` expectation is PROTOCOL/CAPABILITY-DEPENDENT, never global:
  session-based protocol (legacy handshake) → a session id is EXPECTED when
  the server's contract requires one; if the server requires it but provides
  none, that is a protocol/session error (`invalid_response` with the actual
  server response recorded), NOT silently tolerated. Stateless modern
  protocol → no session id is expected and its absence is normal operation.
  The transport captures the header (case-insensitive) only when actually sent
  and sends it only when the negotiated contract calls for it — never assumed,
  never sent blind.
- Unknown/unsupported negotiated version → `unsupported_protocol` error,
  no calls attempted, surfaced honestly (never silently downgraded).
- Session invalidation (stale session id rejected mid-session, session-based
  contracts only) → single re-`initialize` then one retry of the failed call;
  still failing → error to user. Stateless contracts: failed call retried once
  without session handling.
- Cancel via `Gio.Cancellable` (existing engine pattern); `destroy()` drops
  negotiated version + session id; no logout call (no such tool in scope).

## B. OAuth discovery (no invented endpoints)

Discovery order at runtime, all values from live metadata only:

1. `GET /mcp` (no auth) → read `WWW-Authenticate: resource_metadata=...`.
2. `GET <resource_metadata>` → `authorization_servers[]`.
3. `GET <as>/.well-known/oauth-authorization-server` → authorization/token/
   registration endpoints, PKCE methods, scopes (all confirmed above on 2026-09-20,
   but re-fetched at runtime — never baked in as constants except as fallback).
4. Dynamic Client Registration (`RFC 7591`) at `registration_endpoint`.
   UNVERIFIED CONTRACT — the following are OPEN QUESTIONS, not defaults:
   (a) whether a loopback `redirect_uri` (`http://127.0.0.1:<port>/callback`)
   is accepted (custom-scheme alternative also unverified);
   (b) whether `token_endpoint_auth_method: "none"` (public client) is accepted;
   (c) which `scope` value to request (`"mcp:read"` vs `"mcp:tools"` — both
   advertised, neither confirmed for this client type).
   Implementation MUST first verify the DCR contract against live metadata
   and server responses. Any trial registration must use the minimum
   necessary client configuration and must not assume automatic deletion
   unless the server exposes and accepts an unregistration mechanism.

   Until the DCR contract is verified, DCR remains `unverified`, and
   `beginAuthorization` stays a stub. `client_id` returned is stored, never hardcoded.
5. Authorization request: parameters built ONLY from the verified DCR contract
   + live authorization-server metadata (`response_type=code` confirmed;
   everything else per verification). Open via
   `Gio.AppInfo.launch_default_for_uri_async` (existing browser-launch
   mechanism in `applet.js`/`webProvider.js`).
6. Loopback receiver for `?code=`: NOT yet designed — GJS has no HTTP server
   helper in repo. Options (implementation phase): `Gio.SocketService` loopback
   listener, or manual paste of the redirect URL into a settings field as
   interim step WITHOUT storing tokens in plaintext (code is single-use,
   exchanged immediately, never persisted). Decision deferred to implementation
   after `Gio.SocketService` availability check in Cinnamon GJS.
7. Code exchange at `token_endpoint` (`grant_type=authorization_code`,
   `code_verifier`, auth method per verified DCR contract — NOT assumed `none`).
8. Refresh: `grant_type=refresh_token` when `expires_in` nears; on 401 with
   expired token → single refresh → retry once → else status `auth_expired`.
   Refresh behavior itself is unverified until first live token; if the server
   issues non-refreshable tokens, the design falls back to re-authorization
   and documents it.

## C. Authentication abstraction (transport never knows storage)

```text
tradingViewMcpTransport.js  ←  { getAccessToken(), httpRequest() }
                                     ↑
                        authProvider (injected interface)
                        - getAccessToken() -> Promise<string|null>
                        - getAuthStatus()  -> missing|connected|expired|error
                        - beginAuthorization() (browser step, phase 2)
                        - refreshAccessToken() (phase 2, after DCR verified)
```

Phase 1 ships transport + protocol/capability negotiation + mock adapter + this interface ONLY.
`beginAuthorization/refreshAccessToken` are stubs returning
`{code:'auth_unavailable', message:'OAuth browser flow not yet wired'}` —
real OAuth is explicitly NOT marked completed until loopback + DCR verified live.

## D. Token storage decision

- NO `tradingview-access-token` plaintext setting. Rejected as final design.
- Target: `libsecret` via `gi.Secret` (daemon running, typelib present).
  Schema proposal: `org.cinnamon.quicksearch.tradingview` attributes
  `{account: 'default'}`, items: `tv-client-id`, `tv-access-token`,
  `tv-refresh-token`, `tv-token-expiry`.
- Gate: GJS `imports.gi.Secret` async API (`password_store/password_lookup`)
  must be verified under Cinnamon 6.6/mozjs-115 before any real token exists.
  If unavailable/broken → STOP, document constraint, no plaintext fallback.
- Existing hygiene reused: Bearer redaction already in `aiFactory.js`,
  `aiSearchEngine.js`, `nineRouterProvider.js` — MCP transport adopts same
  `_sanitize` helper. Tokens never in `global.log`, errors, or diagnostics.

## E. Streamable HTTP handling (dedicated httpRequest, P1)

Contract verification (2026-09-20, code audit): `webSearchTool._defaultHttpGet`
is `function _defaultHttpGet(url, cancellable, cb)` performing
`Soup.Message.new('GET', url)` — GET-ONLY. It cannot send POST bodies,
custom auth headers, or return status/content-type metadata to the caller.
It MUST NOT be reused for MCP. (Same for the `sourceContentExpander`
variant — also GET-only.)

Dedicated injected abstraction (new, MCP-owned):

```text
httpRequest({ url, method, headers, body, timeoutMs }, cancellable)
  -> Promise<{ status, headers, bodyText, contentType }>
```

- Supports at minimum `POST` (JSON-RPC) + `GET` (metadata discovery);
  headers/body/status/content-type/cancellation are first-class, not bolted on.
- Production implementation reuses existing Soup infrastructure correctly:
  session handling + `Gio.Cancellable` bridging + `GLib.timeout_add` patterns
  from `nineRouterProvider.js`, request-body via
  `soupTextReader.setSoupRequestBodyFromText` (boxed-free rule — no
  `GLib.Bytes`), response text via `soupTextReader.readSoupMessageText`.
  Only the proven PRIMITIVES are reused; no GET-specific helper is misused.
- Transport depends ONLY on the injected `httpRequest` (mirrors the
  `httpFetch` injection pattern in `nineRouterProvider.js`); unit tests inject
  a mock, production injects the Soup-backed implementation.
- POST `https://mcp.tradingview.com/mcp`, headers:
  `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
  `Authorization: Bearer <token>`, `Mcp-Session-Id` ONLY when the negotiated
  protocol/capability contract calls for it (session-based: per server contract;
  stateless: never sent — §A). No `Mcp-Protocol-Version` assumption beyond the
  negotiated version value itself.
- Body shapes: single JSON-RPC object. Response may be:
  1. `application/json` single object, or
  2. `text/event-stream` SSE (`Content-Type` sniffed, not assumed):
     parse `data:` frames, ignore `: ping` comments, correlate by `id`,
     collect `result`, surface `error {code,message}`, tolerate server
     `notifications/*` frames (dropped, logged at debug only).
- Session id captured case-insensitively (`mcp-session-id`) when the negotiated
  contract uses sessions (legacy); on a stateless contract its absence is
  expected and normal. Missing id on a session-based contract where the server
  requires one → `invalid_response` protocol/session error (§A, §K).
- Request/response correlation by JSON-RPC `id` (incrementing int).
- HTTP status handling: `401` → auth flow (`auth_expired`/`auth_missing`,
  one refresh retry when a refresh path is verified); `403` → `auth_forbidden`
  (plan/scope insufficient — honest message, no retry); `429` → `rate_limited`
  with retry-after hint, no silent retry storm.
- Transport injected as `httpRequest` per the dedicated abstraction above
  (NOT `webSearchTool.defaultHttpGet`, which is GET-only).
- Timeouts: `GLib.timeout_add` (existing pattern), default 30s init / 15s calls.
- All covered by mock-transport unit tests (JSON + SSE + 401 + 403 + 429 +
  malformed + missing-session-on-session-based + no-session-on-stateless +
  version mismatch).

## F. tools/list discovery (never hardcoded)

- Legacy: after `notifications/initialized`. Modern: per the discovery mechanism
  the server actually advertises (`server/discover` ONLY if advertised — never
  assumed; otherwise follow the observed capability contract; fail closed if
  required discovery is unavailable). In both cases the next step validates each advertised entry
  `{name, description, inputSchema}` PLUS its annotations/metadata when present.
- Adapter builds call validators FROM `inputSchema` at runtime (required fields,
  types, enums like `interval`). Unknown/missing schema → tool disabled, not guessed.
- Docs tool names are hints only; `tools/list` output is source of truth.
  Expected read-only set (per docs fetch): `search_symbols, get_ohlcv,
  get_technicals_rating, get_symbol_data, get_symbol_data_batch, get_financials,
  get_forecasts, get_news, get_news_story, run_screener, get_screener_columns,
  get_economic_data, get_economic_symbols` (+ `get_financial_history`,
  `get_documents`, calendars observed in docs — admitted only if `tools/list`
  confirms AND read-only).
- Stale cache: re-`tools/list` per transport setup (legacy: per session init);
  mid-session `method not found` → one re-list → retry once.

## G. Read-only tool policy (allowlist + annotations, P2)

- Static capability gate AFTER discovery: name must be in
  `READ_ONLY_ALLOWLIST` AND advertised by server. Anything else
  (`create_alert, update_alert, delete_alert, stop_alerts, restart_alerts,
  *_watchlist`) → adapter refuses with `unsupported_tool`, never forwarded.
- Annotation/metadata gate (P2): when the server provides tool annotations
  or metadata (e.g. `readOnlyHint`, `destructiveHint`, `openWorldHint`, or
  equivalent capability flags), a tool is callable ONLY if it is advertised
  AND allowlisted AND schema-valid AND NOT marked write/destructive by its
  annotations. Annotation absence is tolerated (legacy servers) — annotation
  presence marking write/destructive is a hard veto even for allowlisted names.
- No client-side write emulation. No watchlist/alert UI.
- `get_screener_columns` caching (P2): fetched once per transport setup and cached;
  subsequent screener calls reuse the cache when it already covers the needed
  columns/filters. Re-fetch only on cache-miss (`unknown column/filter` error)
  or new transport setup. Never called blindly on every screener request.
- Rate limit (~100/min): planner minimum-calls + serialize bursts; 429 →
  `rate_limited` error with retry-after hint, no silent retry storm.

## H. Symbol resolution

- NEVER guess `EXCHANGE:TICKER`. `search_symbols` is source of truth.
- Candidates >1 and query lacks exchange context → return `ambiguous_symbol`
  with candidate list → engine asks user clarification (no silent pick).
- Single clear best match (exact ticker + exchange match) → proceed.
- Resolved symbol cached per query only (no persistent ticker map, no hardcoded
  `BTC=BINANCE:BTCUSDT` anywhere).
- Batch compare: resolve each symbol independently; any ambiguous → whole
  request waits for clarification, no partial fabricated comparison.

## I. Financial intent routing (generic, false-positive guarded, P2)

New pure module `financialIntent.js`. Single generic keywords NEVER route
alone — routing requires FINANCIAL CONTEXT: at least one of
(a) a recognized market-instrument signal (ticker-like token resolved via
`search_symbols`, e.g. `BTC/XAUUSD/NVDA/BBCA/EURUSD`, or an asset-class word:
`saham/stock/crypto/forex/pair/indeks`) or
(b) a technical/fundamental indicator term (`rsi/macd/ema/sma/stochastic/
cci/adx/momentum/pe/pb/roe/roa/ebitda/fcf/dividen`) or
(c) an explicit market venue/method term (`tradingview/ohlcv/timeframe/
candlestick/screener/oversold/overbought/support/resistance`) or
(d) an economic-indicator term (`inflasi/gdp/cpi/suku bunga/fed rate/
pengangguran/neraca perdagangan`).
Queries failing this gate stay on the existing web path even when they contain
`berita/harga/data/filter`:
- "Berita terbaru Linux Mint" → web (no instrument/indicator/venue context)
- "harga laptop" → web (product, not instrument)
- "filter file PDF" → web (file operation, not screener)
- "data cuaca Jakarta" → existing live-data fallback (weather domain, not market)
Timeframe tokens (`M1..MN, 1m..1M`) and multi-split (`,`/`dan`/`vs`) are
extracted only AFTER the gate passes.
Intents: `market_price|market_ohlcv|technical_analysis|fundamental_analysis|
market_news|financial_screener|economic_data|symbol_lookup`.
Engine order: financial check BEFORE live-intent web path; non-financial queries
byte-identical to today. Minimum-calls planner per intent:
price=resolve+1 market-price data call (tool per §J discovery, never an invented tool);
TA=technicals (+ohlcv only if user asks bars);
fundamental=financials (+forecasts only if consensus asked); news=news
(+story only if detail asked); screener per §G-cached columns + `run_screener`.

## J. Grounding (market-data-native, P1 — never forced into title/url/snippet)

- Market answers grounded ONLY on MCP results. Pipeline:
  resolve → fetch → `marketDataTool` normalizes to a MARKET-NATIVE structure:
  `{type:'market_data', kind:'market_price|market_ohlcv|technicals|financials|forecasts|
  news|screener|economic', symbols:[...], interval, rows:[...], attribution:
  'TradingView'}` where each row keeps native fields (`open/high/low/close/
  volume/time`, indicator values, fundamentals, screener cells) verbatim.
  A `sources[]` array (`{title,url,snippet}`) is populated ONLY when TradingView
  actually returns a URL (news links, symbol pages); rows without URLs NEVER get
  fabricated URLs. The existing web-grounding path keeps its own contract —
  market data does NOT flow through `normalizeSources` (which would drop
  URL-less rows).
- `market_price` tool mapping (P1): there is NO generic/fictitious `get_quote`
  tool and the planner never assumes one. The market-price data call is selected
  dynamically from live `tools/list` + `inputSchema`:
  first capable candidate wins in order `get_symbol_data` (single-row columns
  e.g. `close/change`) → `get_symbol_data_batch` → `get_ohlcv`
  (`count:1`, last close). Candidates are examples, NOT a guaranteed set —
  the adapter never assumes any specific tool exists.
  If none is advertised, `market_price` fails closed
  with `unsupported_tool` — never invented.
- Timeframe handling (P1): internal canonical tokens (`M1/M5/M15/M30/H1/H4/
  D1/W1/MN`) map to per-tool values VALIDATED against that tool's
  `inputSchema` enum at call time (e.g. `get_ohlcv` accepts `1m..1M`;
  `get_technicals_rating` accepts its own set). No global map is trusted
  blindly: if the user value is absent from the selected tool's schema, the
  call fails closed with `unsupported_timeframe` naming the accepted values.
- Prompt addition (`MARKET_GUIDANCE`, appended only on financial leg):
  delay-aware wording ("Menurut data TradingView yang tersedia…", never
  "real-time" unless tool states it), indicator≠certainty language
  ("indikator menunjukkan… bukan kepastian arah harga"), no profit claims,
  "Data pasar: TradingView" attribution, never emit raw JSON unless asked,
  AI-computed values from OHLCV labelled as AI-computed.
- Multi-timeframe/symbol labelled per section, never mixed without labels.

## K. Failure handling (fail closed)

| Failure | Behavior |
|---|---|
| missing/expired auth (401) | `auth_expired`, honest message, no web-price substitution as "current" |
| forbidden (403, plan/scope) | `auth_forbidden`, honest message, no retry |
| connection/timeout | `network_error`/`timeout`, no stale numbers |
| tool absent/method-not-found | `unsupported_tool`, re-list once |
| unsupported protocol version | `unsupported_protocol`, no calls attempted |
| no-session id on stateless contract | normal operation, never an error |
| missing session id on session-based contract | `invalid_response` protocol/session error, server response recorded |
| session invalidation mid-session (session-based) | one re-init + one retry, then error |
| call failure on stateless contract | one retry without session handling, then error |
| invalid symbol | `no_results` + reason |
| ambiguous symbol | `ambiguous_symbol` + candidates → clarification |
| unsupported timeframe for tool | `unsupported_timeframe` + accepted values |
| 429 | `rate_limited`, no fan-out retry |
| DCR rejection/unsupported flow | `auth_unavailable`, recorded in doc, OAuth stays stubbed |
| empty result | `no_results`, never fill from memory |
| malformed MCP/SSE | `invalid_response`, drop frame |
| web fallback | ONLY for general-context/news intent, labelled as web source |

## L. Tests (mock transport, no real credentials)

New `tests/ai-tradingview-*.test.js` covering spec §21 (15 items): intent,
symbol routing, timeframe map, tool selection, min-calls, ambiguity, failure
matrix, empty data, rate-limit, attribution, multi-timeframe/symbol, screener,
news, fundamental routing. Plus: SSE parser, session lifecycle, allowlist gate,
`inputSchema`-driven validation, Bearer redaction, AND the P2 additions:
legacy lifecycle, protocol-version negotiation/unsupported-version fail-closed,
missing-session-id on session-based contract (error) vs stateless no-session
(normal), DCR rejection/unsupported flow, market-data rows
without URL (no fabricated URLs), per-tool timeframe validation
(accept + reject paths), financial false positives
("Berita terbaru Linux Mint", "harga laptop", "filter file PDF",
"data cuaca Jakarta" → all web path), actual price-tool selection from a
dynamic `tools/list` (including `get_ohlcv count:1` fallback and
none-advertised fail-closed), dynamic schema shape changes, 401/403/429
mapping, session invalidation retry, annotation-vetoed write tool
(allowlisted name but destructive annotations → refused), discovery flow
(advertised mechanism honored — `server/discover` followed ONLY when the server
advertises it, direct-to-`tools/list` rejected when required discovery is
missing, unavailable discovery fails closed), unsupported-version fail-closed. Mock tests prove
transport/planner/adapter logic ONLY.

QA separation (P2) — two independent gates, never conflated:
1. Protocol/tool behavior verification: authenticated QA against live
   TradingView (pins accepted protocol version, records whether
   `server/discover` or another discovery mechanism is actually used,
   records real `tools/list` + schemas). Mock-green is an
   entry ticket to this gate, never a pass.
2. QuickSearch OAuth implementation: DCR contract → browser flow → Secret
   storage → end-to-end (gated on gate 1 findings + Secret GJS verification).
Real MCP integration is marked complete ONLY when both gates pass on live
infrastructure. Until then every status report states which gate is open.
Regression: full `node --test tests/*.js` green.

## M. Search isolation proof

Untouched: `searchEngine.js`, `providers/*`, `result.js`, `utils.js`,
`webProvider`/`searxngProvider` transports, Generative UI, Markdown renderer,
search CSS/layout. Modified: `aiFactory.js` (new optional opt), `aiSearchEngine.js`
(new branch), `promptBuilder.js` (append-only guidance), `responseIntent.js`
(additive), `settings-schema.json`+`applet.js` (new section/keys only —
NO token keys until Secret gate passes). New: `ai/marketData/*` + tests.
Proof: `git status` shows no `searchEngine/providers/result/stylesheet` diff;
full suite green; Search behavior verified unchanged.
