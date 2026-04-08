# Changelog

All notable changes to TabVault are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.1] — Unreleased

### Fixed — Critical bugs
- **Fuse.js never loaded** — filename `fuse.min.js` in HTML didn't match the actual file `fuse_min.js`; fuzzy search was silently broken in both popup and sidebar.
- **Bookmark scanner always returned "unknown"** — `mode:'no-cors'` produces opaque responses with `status 0`; removed it so extension service worker fetches work correctly. Added HEAD→GET/Range fallback for servers that reject HEAD (405).
- **Scan progress bar frozen at 0** — background now writes `scanProgress` to `chrome.storage.local` on every bookmark checked; sidebar reacts via `chrome.storage.onChanged` in real time.
- **DOM content doubled on tab events** — sidebar refresh callback called the view function directly (appending onto existing DOM) instead of `render()` which clears `#main` first.
- **Sidebar/command opened wrong window** — replaced `chrome.windows.getAll()[0]` with `chrome.windows.getLastFocused()` in both `onStartup` and the `open-sidebar` keyboard command.
- **Context menu creation not idempotent on extension update** — each `contextMenus.create` call now has its own `lastError` callback; `removeAll` error is caught and logged.
- **Service worker `tabActivity` Map lost on idle restart** — introduced `ensureTabActivity()` guard called before every Map read; storage writes debounced to once per 3 seconds via `scheduleActivitySave()`.

### Fixed — Moderate bugs
- **`GET_ALL_BOOKMARK_META` loaded all extension storage** — now derives storage keys from the live bookmark tree instead of calling `chrome.storage.local.get(null)`.
- **Session restore opened `chrome://` and `file://` URLs** — added `isSafeUrl()` (http/https only) gating both `saveSession` and `restoreSession`; suspended tabs have their real URL recovered from query params.
- **URL match-pattern matching was incorrect** — replaced naive `*→.*` glob with a full Chrome URL match-pattern parser (scheme, subdomain wildcards, path).
- **`bumpTabActivity` wrote to storage on every tab event** — writes now go through a 3-second debounced `scheduleActivitySave()`.
- **Keyboard `ArrowUp` from empty focus jumped to first row** — fixed: ArrowUp from nothing → last row, ArrowDown from nothing → first row.
- **`importBookmarks` accepted any HTML file** — now validates for `NETSCAPE-Bookmark-file` header before processing.
- **`getSettings()` made a storage round-trip on every call** — added module-level `_settingsCache` invalidated via `chrome.storage.onChanged`.

### Fixed — Security
- **`IMPORT_DATA` wrote arbitrary keys to storage** — now validates against an allowed-prefix whitelist; settings merged against `DEFAULT_SETTINGS` to strip unknown keys.
- **`el()` helper had an `innerHTML` XSS sink** — `html` attribute key removed entirely; content flows through the safe `children` array.
- **`javascript:` bookmarks were exported unfiltered** — `exportBookmarks` now skips any URL whose scheme isn't `http:`, `https:`, or `ftp:`.
- **No Content Security Policy declared** — added `"extension_pages": "script-src 'self'; object-src 'none'; base-uri 'none';"`.
- **`"favicon"` was listed as a permission** — removed (not a real Chrome extension permission).

### Fixed — Architecture
- **No error boundary in view rendering** — `render()` wrapped in try/catch; uncaught view errors show a recoverable error card instead of a blank panel.
- **Popup called Chrome APIs directly** — `chrome.bookmarks.create`, `chrome.sidePanel.open`, `chrome.tabs.create` replaced with `send('CREATE_BOOKMARK')`, `send('OPEN_SIDEBAR')`, `send('OPEN_URL')`.
- **Session list was unbounded** — `MAX_SESSIONS = 50` constant; FIFO eviction on every `saveSession` call.
- **`chrome.storage.sync` quota could silently fail** — `SET_SETTINGS` catches quota errors and falls back to local storage; `getSettings` reads both.
- **Missing `unlimitedStorage` permission** — added to manifest.

### Added — Missing features
- **Undo toasts** — 5-second undo available after closing a tab, deleting a session, or deleting a bookmark.
- **Multi-window support** — Tabs panel now has a window picker (Current / All windows).
- **Session auto-save / crash recovery** — rolling snapshot saved every 5 minutes; appears at the top of the Sessions list as "Last session (auto-saved)".
- **Batched bookmark scanner** — concurrent batches of 5 with a 300ms inter-batch delay replace the sequential fetch loop.
- **First-run onboarding** — feature-tour modal shown once on fresh install.

### Changed — Project structure
- Reorganised from a flat directory into a professional folder layout (`background/`, `popup/`, `sidebar/`, `options/`, `pages/suspended/`, `shared/lib/`).
- All cross-folder import paths and HTML asset references updated accordingly.

## [1.0.0] — Initial release
