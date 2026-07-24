# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Web Councile is a Chrome extension (Manifest V3) that broadcasts one prompt to your open ChatGPT, Claude, and Gemini sessions at the same time, shows all three answers side by side in a popup "council" window, and can have one of the three (the "judge") synthesize a single consolidated answer from the others.

Repo layout:
- `web-councile/` — the extension itself (unpacked, no build step, no bundler)
- `docs/index.html` — a static marketing/landing page served via GitHub Pages; unrelated to the extension's runtime behavior

## Running / testing

There is no `package.json`, no build step, and no automated test suite — this is a plain unpacked MV3 extension.

- Load it: `chrome://extensions` → enable Developer Mode → "Load unpacked" → select the `web-councile/` folder.
- After any code change: click the reload icon for the extension on `chrome://extensions`. Chrome's "Load unpacked" watches one fixed folder path with zero awareness of git — it only ever re-reads whatever folder was originally loaded.
- If you're working in a git worktree, Chrome is still pointed at whatever folder was loaded — you must load that exact worktree's `web-councile/` path for a reload to reflect your changes. A symlink-based "point Chrome at whichever worktree is active" workaround was tried and abandoned: it's a single global pointer, so multiple concurrent worktree sessions fight over it invisibly to each other. Default to editing/testing directly against the checkout the user names; don't introduce indirection here.
- Logs are console-based and prefixed by context, viewable from the relevant devtools:
  - Background service worker: `chrome://extensions` → this extension's "service worker" inspect link → `[WebCouncile:background]`
  - Content scripts: devtools on the actual chatgpt.com/claude.ai/gemini.google.com tab → `[WebCouncile:<service>]`
  - Council window: devtools on the popup window itself → `[WebCouncile:council]`
- Manifest permissions: `scripting`, `tabs`, `storage`, `unlimitedStorage`, plus host permissions scoped only to `chatgpt.com`, `claude.ai`, and `gemini.google.com`.

## Architecture

### Three execution contexts sharing one message-passing spine

- **`council/council.html` + `council.js`** — the UI. A `chrome.windows.create({type:"popup"})` window opened by `background.js` when the toolbar icon is clicked. Owns the composer (with paste/drag file attachments), the transcript render, and council/session management (multiple saved "councils," each with its own pinned session links and history). Talks to the background service worker over a long-lived `chrome.runtime.connect` port (`PORT_COUNCIL`), reconnecting lazily before every send since the port silently goes stale whenever the service worker is killed.
- **`background.js`** — the MV3 service worker. Orchestrates finding/opening tabs, injecting content scripts, relaying status updates back to the council window, and pinning/persisting session URLs.
- **`content-scripts/{chatgpt,claude,gemini}.js`** — injected on demand via `chrome.scripting.executeScript` (not declared statically in the manifest) into whichever tab is chosen for that round. Each finds the site's composer/send button through best-effort CSS selectors, types the prompt, submits it, watches the DOM for the reply to appear and settle, and reports back via one-shot `chrome.runtime.sendMessage` status updates. `shared/content-helpers.js` holds the logic shared across all three: `setComposerText` (dispatches real input events so framework-controlled composers pick up the change), `waitForNewNode`/`watchUntilSettled` (MutationObserver-based, not polling — `requestAnimationFrame` is paused for background tabs, which polling would silently hang on), and best-effort model-picker/file-attach helpers.
- **`shared/constants.js`** — single source of truth for message type strings, the `SERVICES` registry (url, urlPattern, content script file per service), and the `STATUS` enum. Loaded as a plain classic script (not an ES module) by all three contexts via `importScripts`/`<script src>`/`executeScript`'s `files` array, so they share identical constants without duplicating them.

### Message flow for one broadcast round

1. `council.js` sends `MSG_BROADCAST_PROMPT` over the port with the current roster (`services`) and prompt/media.
2. `background.js`'s `broadcastPrompt` fires `runForService` concurrently, once per service.
3. `runForService` → `getOrCreateTab` finds or opens the right tab (see below), injects `shared/constants.js` + `shared/content-helpers.js` + the site's own content script, optionally sends `MSG_SET_MODEL` (only for a genuinely fresh chat — a reused/pinned conversation already has its model locked in), then sends `MSG_RUN_PROMPT`.
4. The content script's `run()` submits the prompt and reports status via `WAITING` → `STREAMING`/`DONE`/`ERROR`/`NOT_SIGNED_IN`.
5. `background.js` relays every status update to the council window over the port (`relayToCouncil`); `council.js` updates the in-memory `history` transcript and persists it.
6. Once every member seat reaches a terminal status and at least 2 answered, `council.js` auto-fires `MSG_CONSOLIDATE`, which re-runs the same `runForService` path against one dedicated "judge" seat (`storageKey: "consolidation"`, a session that never touches any member's own conversation). Its status updates get remapped (`consolidationActive`/`remapForConsolidation` in background.js) so they land on the transcript's consolidated-answer slot instead of overwriting that judge service's own member column.
7. `council.js` can also send `MSG_OPEN_SESSIONS` (reopen/focus every seat's pinned tab — used when switching councils) and `MSG_NEW_COUNCIL` (open blank "new chat" tabs for the 3 members to start a fresh council); see `openSessions`/`newCouncil` in background.js.

### Tabs, windows, and session pinning

- Every seat (chatgpt/claude/gemini/consolidation) gets its own dedicated, cascaded, unfocused browser window (`seatWindowBounds`/`SEAT_WINDOW_SIZE` in background.js) rather than sharing one window — Chrome throttles `requestAnimationFrame`-based rendering for any tab that isn't the frontmost one in its own window, which these chat sites' streaming-text UI depends on internally, so 3 tabs sharing a window meant only the last-activated one ever actually finished.
- `isolatedWindowIds` tracks which windows background.js has already moved a tab into, so a seat isn't re-isolated on every call. **Known fragility**: as an in-memory `Set`, it's lost whenever the MV3 service worker restarts (~30s idle) — which can happen well within a normal prompt round-trip — causing an already-isolated seat to look "new" again on the next prompt. A fix persisting this to `chrome.storage.session` (survives worker restarts, clears on browser close) exists on a separate branch; check whether it's landed before treating this as still-open.
- Each **council** (a saved, named set of pinned session links + its own transcript) lives in `chrome.storage.local` under key `councils` (map of `councilId` → `{ name, sessionLinks, history }`), with `activeCouncilId` pointing at the live one. `sessionLinks` pins a seat to a specific conversation URL; once pinned, that exact conversation is reused/reopened instead of falling back to "whichever tab happens to be open." Pins are captured automatically the first time a message is actually sent in a fresh chat (`capturePinnedUrl`/`waitForUrlChange` in background.js) — never configured by hand, though the session-settings modal lets a user override them directly.
- Because `broadcastPrompt` fires all seats concurrently and background.js/council.js each do their own independent read-modify-write against the same `chrome.storage.local` keys, both sides serialize their writes through a promise chain (`sessionLinksWriteQueue` in background.js, `councilsWriteQueue` in council.js) instead of writing directly — otherwise a slower read can land after a faster write and silently revert it.

### CRM export

The council window's "Update CRM" button POSTs the current turn (prompt, consolidated answer, each member's answer) as JSON to a user-configured webhook URL + optional bearer token, stored in `chrome.storage.local` (`crmUrl`/`crmKey`). Independent of the broadcast/consolidation flow — pure client-side `fetch` from council.js.

## Working conventions

- **Selectors are best-effort and, in places, unverified.** Each content script's `SELECTORS` object explicitly comments which selectors (model-picker trigger/options, file input) have never been checked against the live DOM. If a status gets stuck at "Waiting…"/"Sending…" or a feature silently no-ops, the fix is almost always updating one selector in that one file after inspecting the real page — not a redesign.
- **This is a live-tested Chrome extension, not a library.** Most changes here need a human to reload the unpacked extension and click through the real UI before they can be called done; there's no test suite standing in for that.

## Keeping this file current

This file documents current behavior, not intent. Whenever a change alters message flow, storage shape, tab/window handling, or any other architectural point described above — not just a selector tweak or copy change — update the relevant section of this file as part of that same change.
