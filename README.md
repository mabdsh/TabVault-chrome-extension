# TabVault — Tabs & Bookmarks Workspace

A professional Chrome MV3 extension that unifies tab management, bookmark organisation, session saving, and broken-link scanning into a single sidebar and popup.

---

## Features

| Feature | Description |
|---------|-------------|
| 🗂 **Tab Manager** | Search, group, pin, suspend and close tabs. Supports multiple windows. |
| 💾 **Sessions** | Save your open tabs as named sessions and restore them in a new window or merge into the current one. Auto-recovery snapshot saved every 5 minutes. |
| 🔖 **Bookmarks** | Browse, tag, annotate, search and export your Chrome bookmarks. |
| 🔗 **Broken Link Scanner** | Batch-scans all bookmarks (5 at a time) and surfaces dead URLs for quick cleanup. |
| 💤 **Tab Suspender** | Automatically suspends idle tabs to free memory. Configurable timeout and allowlist. |
| 🔍 **Unified Search** | Fuzzy-search across open tabs and bookmarks simultaneously (powered by Fuse.js). |
| ↩️ **Undo** | 5-second undo toast on tab close, session delete, and bookmark delete. |

---

## Project structure

```
tabvault/
├── manifest.json                 # Extension manifest (MV3)
├── README.md
├── CHANGELOG.md
├── .gitignore
│
├── icons/                        # Extension icons (PNG required)
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
│
├── background/                   # Service worker
│   └── background.js
│
├── popup/                        # Toolbar popup (380 × 560 px)
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
│
├── sidebar/                      # Side panel (full height)
│   ├── sidebar.html
│   ├── sidebar.js
│   └── sidebar.css
│
├── options/                      # Settings page
│   ├── options.html
│   └── options.js
│
├── pages/
│   └── suspended/                # Suspended-tab restore page
│       ├── suspended.html
│       └── suspended.js
│
└── shared/                       # Shared across all pages
    ├── common.js                 # Utilities: el(), send(), toast(), modals, etc.
    ├── shared.css                # Design tokens & base styles
    └── lib/
        └── fuse_min.js           # Fuse.js fuzzy-search library
```

---

## Installation (development)

1. Clone or download this repository.
2. Add PNG icon files to `icons/` (16, 32, 48, 128 px).
3. Open Chrome and navigate to `chrome://extensions`.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the `tabvault/` folder.
6. The TabVault icon appears in your toolbar.

---

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Open popup | `Ctrl+Shift+Y` / `Cmd+Shift+Y` |
| Open sidebar | `Ctrl+Shift+U` / `Cmd+Shift+U` |
| Save session | Configurable at `chrome://extensions/shortcuts` |

---

## Permissions explained

| Permission | Reason |
|------------|--------|
| `tabs` | Read tab URLs, titles, and favicons; switch, pin, move, close tabs |
| `tabGroups` | Create and update Chrome tab groups |
| `bookmarks` | Read, create, update and delete Chrome bookmarks |
| `storage` + `unlimitedStorage` | Persist sessions, bookmark metadata and settings |
| `alarms` | Run periodic tasks (suspender check, broken-link scan, auto-recovery) |
| `contextMenus` | Right-click menu: Save to TabVault, Suspend this tab, Save session |
| `sidePanel` | Register and open the sidebar panel |
| `scripting` | Reserved for future content-script features |
| `notifications` | Notify on context-menu session save |
| `<all_urls>` | Fetch bookmark URLs (HEAD requests) for broken-link scanning |

---

## Development notes

- **No build step required.** All JS uses native ES modules (`type="module"`).
- `shared/common.js` exports every shared utility (`el`, `send`, `toast`, `showUndoToast`, etc.). Import from `../shared/common.js` in any page script.
- The background service worker is an ES module (`"type": "module"` in manifest). Top-level `await` is supported.
- Fuse.js is loaded as a classic (non-module) script so it attaches to `window.Fuse`.

---

## Contributing

1. Fork the repo and create a feature branch.
2. Make your changes; keep each commit focused on one fix or feature.
3. Test in Chrome with `Load unpacked` — reload the extension after every background.js change.
4. Open a pull request with a clear description and screenshots if UI changed.
