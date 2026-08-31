# Test Report — quicksearch@yoji v1.0.0 (2026-08-30)

Scope: **search-only**. AI/tool/agent/vision/control phases dihapus dari codebase; histori dipindah ke `archive/test-report-phase4-13-ai.md`.

Environment: Cinnamon 6.6.9+zena · mozjs-115 · plocate/locate(→plocate)/find · Soup-3.0

## Unit tests (`node --test`): 133/133 PASS
`calculator` · `url` · `backend picker + sanitizeGlob` · `result pipeline (classify/normalize/dedupe/rank/limits)` · `file icon (folder/file/symlink/broken/MIME)` · `web backends (DDG/Google/Bing/SearXNG)` · `P1/P2 gate (Best Match/show_recent/selection, icon cache/signal/locations)` · `lifecycle/async`

## Live matrix (via dbus Eval against running Cinnamon)

| # | Test | Hasil |
|---|------|-------|
| 1 | Race typing f→fi→…→firefox | ✅ final rows = firefox only; app top, limits 5/15/5 |
| 2 | Cancellation | ✅ SIGTERM+force_exit on timeout/cancel; 0 orphan find; cb exactly-once |
| 3 | Provider failure chain | ✅ forced-find → 187 hasil; no-backend → [] instan tanpa hang |
| 4 | Missing file sebelum Enter | ✅ query_exists guard, no crash |
| 5 | Dedup | ✅ Firefox app 1×; stable ids (appid/path/canonical-url) |
| 6 | Applet removal | ✅ instance GONE, hotkey unbound, 0 error log |
| 7 | Re-add | ✅ REINSTALLED_OK |
| 8 | Open/close ×10 | ✅ state CLOSED, tanpa error |
| 9 | Empty query | ✅ cb instan ([]), tidak spawn fs/web |
| 10 | Long/special chars & injection | ✅ argv array; nasty string settled aman |
| 11 | NUL output regression | ✅ newline protocol (GJS truncates at \0) |
| 12 | Settings disable web/files | ✅ provider null; guard enabled.* |
| 13 | Recent persistence | ✅ JSON via settings; show_recent=false → 0 locals |
| 14 | Calc activation | ✅ clipboard = result |
| 15 | Web backends | ✅ DDG/Google/Bing/SearXNG per engine |
| 16 | Focus otomatis + caret blink | ✅ stage focus = entry clutter_text |

## Guardrails
1. find limit reader-side ✅ (slice MAX_CANDIDATES, no -quit)
2. engine tanpa pending counter; flush per completion selama gen valid ✅
3. cancellable baru per query efektif, dipakai konsisten file+web ✅
4. argv diverifikasi per tool; locate=plocate-symlink terdeteksi ✅
5. icon cache bounded (500) + file cache key = JSON.stringify(locations) ✅
6. Enter tanpa selection → global Best Match (`_sortedResults[0]`) ✅

## Known behavior (bukan bug)
- "Ikon tidak muncul di panel": panel autohide `intel` — ikon di pojok kiri bawah, alternatif **Super+F`.
- `Super+Space` lama bentrok dengan `next-input-source`; default kini `<Super>f`.

## Archive
Phase 4-13 AI journal (ASK AI, conversational, tool/agent/vision/control) → [`archive/test-report-phase4-13-ai.md`](archive/test-report-phase4-13-ai.md) — bukan fitur aktif.
