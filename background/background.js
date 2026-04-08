// background.js — TabVault MV3 Service Worker
// Handles tab/session/bookmark messaging, alarms, suspension, context menus.

// ---------- Storage helpers ----------
const storage = {
  async get(key, fallback = null) {
    const r = await chrome.storage.local.get(key);
    return r[key] ?? fallback;
  },
  async set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  },
  async getSync(key, fallback = null) {
    const r = await chrome.storage.sync.get(key);
    return r[key] ?? fallback;
  },
  async setSync(key, value) {
    return chrome.storage.sync.set({ [key]: value });
  },
};

const DEFAULT_SETTINGS = {
  defaultView: 'tabs',           // tabs | bookmarks | last
  showToolbarButton: true,
  openOnStart: false,
  suspenderEnabled: true,
  suspendAfterMinutes: 30,
  neverSuspendPatterns: ['*://localhost/*', '*://127.0.0.1/*'],
  duplicateDetection: true,
  showTabBadge: true,
  autoTagBookmarks: false,
  defaultNoteTemplate: '',
  scanSchedule: 'never',         // never | weekly | monthly
  showBookmarkCount: true,
};

// Settings cache — avoids a storage.sync round-trip on every message/alarm
let _settingsCache = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) _settingsCache = null;
});

async function getSettings() {
  if (_settingsCache) return _settingsCache;
  // Primary: sync storage (shared across devices).
  // Fallback: local storage (used when sync quota was exceeded on save).
  let s = await storage.getSync('settings', null);
  if (!s) s = await storage.get('settings', {});
  _settingsCache = { ...DEFAULT_SETTINGS, ...s };
  return _settingsCache;
}

// ---------- Lifecycle ----------
chrome.runtime.onInstalled.addListener(async (details) => {
  // Persist default settings only on a clean install (not updates)
  if (details.reason === 'install') {
    await storage.setSync('settings', DEFAULT_SETTINGS);
    await storage.set('showWelcome', true);
  }

  // Alarms — safe to recreate on every install/update (same-name alarms are replaced)
  chrome.alarms.create('cleanup-duplicates',      { periodInMinutes: 60 });
  chrome.alarms.create('check-suspended-tabs',    { periodInMinutes: 5 });
  chrome.alarms.create('scheduled-bookmark-scan', { periodInMinutes: 60 * 24 });
  chrome.alarms.create(RECOVERY_ALARM,            { periodInMinutes: 5 });

  // Context menus — removeAll first to be idempotent across updates
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.warn('[TabVault] contextMenus.removeAll error:', chrome.runtime.lastError.message);
    }
    const menus = [
      { id: 'tabvault-bookmark',     title: 'Save to TabVault',        contexts: ['page', 'link'] },
      { id: 'tabvault-session-save', title: 'Save current session',    contexts: ['page'] },
      { id: 'tabvault-suspend-tab',  title: 'Suspend this tab',        contexts: ['page'] },
    ];
    for (const m of menus) {
      chrome.contextMenus.create(m, () => {
        if (chrome.runtime.lastError) {
          console.warn('[TabVault] contextMenu create failed:', chrome.runtime.lastError.message);
        }
      });
    }
  });

  // Open side panel from action click
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) { /* not all builds support this */ }
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  if (s.openOnStart) {
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w) chrome.sidePanel.open({ windowId: w.id });
    } catch (e) { console.warn(e); }
  }
});

// ---------- Tab activity tracking (for suspender) ----------
const tabActivity    = new Map(); // tabId -> last active timestamp
const lockedTabIdMap = new Map(); // tabId -> { url, title, pinned }  (lock-and-reopen)
let _tabActivityLoaded = false;
let _activitySaveTimer = null;

async function ensureTabActivity() {
  if (_tabActivityLoaded) return;
  const data = await storage.get('tabActivity', {});
  for (const [k, v] of Object.entries(data)) tabActivity.set(Number(k), v);
  _tabActivityLoaded = true;
}

// Batch storage writes — debounced to at most once every 3 seconds
function scheduleActivitySave() {
  if (_activitySaveTimer) return;
  _activitySaveTimer = setTimeout(async () => {
    _activitySaveTimer = null;
    await storage.set('tabActivity', Object.fromEntries(tabActivity));
  }, 3000);
}

async function bumpTabActivity(tabId) {
  await ensureTabActivity();
  tabActivity.set(tabId, Date.now());
  scheduleActivitySave();
}

// Pre-load on SW start so the map is ready before the first alarm fires
ensureTabActivity();

// Rebuild locked-tab tracking after SW restart (tabIds don't survive restarts)
async function rebuildLockedTabIdMap() {
  const lockedUrls = await storage.get('lockedUrls', []);
  if (!lockedUrls.length) return;
  const lockedSet = new Set(lockedUrls);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.url && lockedSet.has(t.url)) {
      lockedTabIdMap.set(t.id, { url: t.url, title: t.title, pinned: t.pinned });
    }
  }
}
rebuildLockedTabIdMap();

chrome.tabs.onActivated.addListener(({ tabId }) => bumpTabActivity(tabId));

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete') {
    bumpTabActivity(tabId);
    // Keep locked-tab map in sync as tabs navigate
    if (tab.url) {
      const lockedUrls = await storage.get('lockedUrls', []);
      if (lockedUrls.includes(tab.url)) {
        lockedTabIdMap.set(tabId, { url: tab.url, title: tab.title, pinned: tab.pinned });
      }
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ensureTabActivity();
  tabActivity.delete(tabId);
  scheduleActivitySave();

  // Reopen if this was a locked tab (skip on window close — user is intentionally closing)
  if (!removeInfo.isWindowClosing) {
    const info = lockedTabIdMap.get(tabId);
    if (info) {
      lockedTabIdMap.delete(tabId);
      // Small delay to avoid Chrome treating it as a pop-up
      setTimeout(() => chrome.tabs.create({ url: info.url, pinned: info.pinned || false }), 120);
    }
  } else {
    lockedTabIdMap.delete(tabId);
  }
});

// ---------- Badge ----------
async function updateBadge() {
  const s = await getSettings();
  if (!s.showTabBadge) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    chrome.action.setBadgeText({ text: String(tabs.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  } catch (e) { /* ignore */ }
}
chrome.tabs.onCreated.addListener(updateBadge);
chrome.tabs.onRemoved.addListener(updateBadge);
chrome.tabs.onActivated.addListener(updateBadge);
updateBadge();

async function saveRecoverySession() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const safeTabs = tabs
    .map((t) => {
      if (t.url?.includes('suspended.html')) {
        try {
          const params = new URLSearchParams(new URL(t.url).search);
          const realUrl = params.get('url');
          if (realUrl && isSafeUrl(realUrl)) return { ...t, url: realUrl };
        } catch {}
        return null;
      }
      return isSafeUrl(t.url) ? t : null;
    })
    .filter(Boolean);

  if (safeTabs.length === 0) return;
  const recovery = {
    id: RECOVERY_SESSION_ID,
    name: '🔄 Last session (auto-saved)',
    createdAt: Date.now(),
    tags: ['auto-recovery'],
    isRecovery: true,
    tabs: safeTabs.map((t) => ({
      url: t.url, title: t.title,
      favIconUrl: t.favIconUrl, pinned: t.pinned,
    })),
  };
  // Store separately from normal sessions so it never counts against the cap
  await storage.set('recoverySession', recovery);
}

// ---------- Alarm handlers ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === RECOVERY_ALARM)              await saveRecoverySession();
  if (alarm.name === 'check-suspended-tabs')      await runSuspenderCheck();
  if (alarm.name === 'cleanup-duplicates')        await flagDuplicates();
  if (alarm.name === 'scheduled-bookmark-scan') {
    const s = await getSettings();
    const last = await storage.get('lastScheduledScan', 0);
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const month = 30 * 24 * 60 * 60 * 1000;
    if (s.scanSchedule === 'weekly' && now - last > week) {
      await scanAllBookmarks();
      await storage.set('lastScheduledScan', now);
    } else if (s.scanSchedule === 'monthly' && now - last > month) {
      await scanAllBookmarks();
      await storage.set('lastScheduledScan', now);
    }
  }
});

// ---------- Suspender ----------
// Implements Chrome's URL match pattern spec:
// <scheme>://<host>/<path>  where scheme/host support * wildcards.
function matchPattern(url, pattern) {
  try {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch { return false; }

    const schemeEnd = pattern.indexOf('://');
    if (schemeEnd === -1) {
      // Plain glob fallback (user typed something non-standard)
      const re = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      return re.test(url);
    }

    const scheme = pattern.slice(0, schemeEnd);
    const rest   = pattern.slice(schemeEnd + 3);
    const slashIdx = rest.indexOf('/');
    const hostPat  = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const pathPat  = slashIdx === -1 ? '*'  : rest.slice(slashIdx);

    // Match scheme ('*' matches http and https only, per Chrome spec)
    const urlScheme = parsedUrl.protocol.replace(':', '');
    if (scheme !== '*' && scheme !== urlScheme) return false;
    if (scheme === '*' && urlScheme !== 'http' && urlScheme !== 'https') return false;

    // Match host ('*' matches any host; '*.foo.com' matches subdomains)
    if (hostPat !== '*') {
      const hostRe = new RegExp(
        '^' + hostPat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      if (!hostRe.test(parsedUrl.hostname)) return false;
    }

    // Match path
    const pathRe = new RegExp(
      '^' + pathPat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    return pathRe.test(parsedUrl.pathname + parsedUrl.search);
  } catch { return false; }
}

async function runSuspenderCheck() {
  const s = await getSettings();
  if (!s.suspenderEnabled) return;
  await ensureTabActivity();
  const cutoff = Date.now() - s.suspendAfterMinutes * 60 * 1000;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.active || tab.pinned || tab.audible) continue;
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('edge')) continue;
    if (tab.url.includes('suspended.html')) continue;
    if (s.neverSuspendPatterns.some((p) => p.trim() && matchPattern(tab.url, p.trim()))) continue;
    const last = tabActivity.get(tab.id) || Date.now();
    if (last < cutoff) {
      await suspendTab(tab);
    }
  }
}

async function suspendTab(tab) {
  try {
    const url =
      chrome.runtime.getURL('pages/suspended/suspended.html') +
      `?url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title || '')}&favicon=${encodeURIComponent(tab.favIconUrl || '')}`;
    await chrome.tabs.update(tab.id, { url });
  } catch (e) {
    console.warn('[TabVault] suspend failed:', e);
  }
}

// ---------- Duplicate detection ----------
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    if (url.pathname.endsWith('/') && url.pathname.length > 1)
      url.pathname = url.pathname.slice(0, -1);
    const params = [...url.searchParams.entries()].sort();
    url.search = '';
    for (const [k, v] of params) url.searchParams.append(k, v);
    return url.toString();
  } catch { return u; }
}

async function findDuplicates() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const map = new Map();
  for (const t of tabs) {
    if (!t.url) continue;
    const k = normalizeUrl(t.url);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  const dups = [];
  for (const [k, arr] of map.entries()) {
    if (arr.length > 1) dups.push({ key: k, tabs: arr });
  }
  return dups;
}

async function flagDuplicates() {
  const dups = await findDuplicates();
  await storage.set('duplicateCount', dups.reduce((a, b) => a + (b.tabs.length - 1), 0));
}

async function closeDuplicates() {
  const dups = await findDuplicates();
  let closed = 0;
  for (const d of dups) {
    for (let i = 1; i < d.tabs.length; i++) {
      try { await chrome.tabs.remove(d.tabs[i].id); closed++; } catch {}
    }
  }
  await flagDuplicates();
  return closed;
}

// Only http/https URLs can be reliably saved and restored
function isSafeUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

// ---------- Sessions ----------
const RECOVERY_SESSION_ID = '__tabvault_recovery__';
const RECOVERY_ALARM      = 'auto-save-recovery';

async function getAllSessions() {
  return await storage.get('sessions', []);
}

async function saveSession(name, tags = []) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const safeTabs = tabs
    .map((t) => {
      // If this tab is a suspended page, recover the real URL from query params
      if (t.url?.includes('suspended.html')) {
        try {
          const params = new URLSearchParams(new URL(t.url).search);
          const realUrl = params.get('url');
          if (realUrl && isSafeUrl(realUrl)) {
            return { ...t, url: realUrl, title: params.get('title') || t.title };
          }
        } catch {}
        return null;
      }
      return isSafeUrl(t.url) ? t : null;
    })
    .filter(Boolean);

  const session = {
    id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: name || 'Session ' + new Date().toLocaleString(),
    createdAt: Date.now(),
    tags,
    tabs: safeTabs.map((t) => ({
      url: t.url,
      title: t.title,
      favIconUrl: t.favIconUrl,
      pinned: t.pinned,
      groupId: t.groupId,
    })),
  };
  const list = await getAllSessions();
  list.unshift(session);
  // FIFO cap — drop the oldest sessions beyond the limit
  if (list.length > MAX_SESSIONS) list.splice(MAX_SESSIONS);
  await storage.set('sessions', list);
  return session;
}

async function deleteSession(id) {
  const list = await getAllSessions();
  await storage.set('sessions', list.filter((s) => s.id !== id));
  return true;
}

async function restoreSession(id, mode = 'new') {
  const list = await getAllSessions();
  const session = list.find((s) => s.id === id);
  if (!session) return false;
  // Only restore safe, navigable URLs
  const safeUrls = session.tabs.map((t) => t.url).filter(isSafeUrl);
  if (safeUrls.length === 0) return false;
  if (mode === 'new') {
    const w = await chrome.windows.create({ url: safeUrls });
    return w;
  } else {
    for (const t of session.tabs) {
      if (!isSafeUrl(t.url)) continue;
      try { await chrome.tabs.create({ url: t.url, pinned: t.pinned }); } catch {}
    }
  }
  return true;
}

// ---------- Auto group by domain ----------
async function autoGroupByDomain() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const byDomain = new Map();
  for (const t of tabs) {
    if (!t.url || t.pinned) continue;
    let host;
    try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!host) continue;
    if (!byDomain.has(host)) byDomain.set(host, []);
    byDomain.get(host).push(t.id);
  }
  const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  let idx = 0;
  let created = 0;
  for (const [host, ids] of byDomain.entries()) {
    if (ids.length < 2) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(groupId, {
        title: host,
        color: colors[idx % colors.length],
      });
      idx++;
      created++;
    } catch (e) {
      console.warn('[TabVault] group failed for', host, e);
    }
  }
  return created;
}

// ---------- Bookmark scanning ----------
async function flattenBookmarks(nodes, out = []) {
  for (const n of nodes) {
    if (n.url) out.push(n);
    if (n.children) await flattenBookmarks(n.children, out);
  }
  return out;
}

async function scanAllBookmarks(progressCb) {
  const tree = await chrome.bookmarks.getTree();
  const all  = await flattenBookmarks(tree);
  let done   = 0;
  const results = [];
  const BATCH  = 5;                 // concurrent requests per batch
  const DELAY  = 300;              // ms between batches — avoids hammering servers

  await storage.set('scanProgress', { done: 0, total: all.length, running: true });

  async function checkOne(bm) {
    let status = 'unknown';
    try {
      const ctrl    = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      // Extension SWs with <all_urls> bypass CORS — do NOT use mode:'no-cors'
      // (opaque responses always have status 0, making alive/broken indistinguishable).
      let res = await fetch(bm.url, { method: 'HEAD', signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.status === 405) {
        // Server doesn't support HEAD — retry with a minimal GET
        res = await fetch(bm.url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          signal: ctrl.signal,
        });
      }
      if (res.ok || res.status === 206)  status = 'alive';
      else if (res.status >= 400)        status = 'broken';
    } catch (e) {
      status = e.name === 'AbortError' ? 'unknown' : 'broken';
    }

    const meta = (await storage.get(`bkm_meta_${bm.id}`)) || {};
    meta.isAlive     = status === 'alive';
    meta.scanStatus  = status;
    meta.lastChecked = Date.now();
    await storage.set(`bkm_meta_${bm.id}`, meta);
    return { id: bm.id, url: bm.url, title: bm.title, status };
  }

  // Process in batches of BATCH with a short pause between each
  for (let i = 0; i < all.length; i += BATCH) {
    const batch   = all.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(checkOne));
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
      done++;
    }
    await storage.set('scanProgress', { done, total: all.length, running: true });
    if (progressCb) progressCb(done, all.length);
    // Brief pause between batches to be polite to remote servers
    if (i + BATCH < all.length) await new Promise((r) => setTimeout(r, DELAY));
  }

  await storage.set('scanProgress', { done, total: all.length, running: false });
  return results;
}

// ---------- Context menu handler ----------
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'tabvault-bookmark') {
    const url = info.linkUrl || tab.url;
    const title = info.linkUrl ? info.linkUrl : tab.title;
    try {
      await chrome.bookmarks.create({ title, url });
      notify('Bookmark saved', title);
    } catch (e) {
      notify('Error', 'Could not save bookmark');
    }
  } else if (info.menuItemId === 'tabvault-session-save') {
    const s = await saveSession('Quick session ' + new Date().toLocaleString());
    notify('Session saved', s.name);
  } else if (info.menuItemId === 'tabvault-suspend-tab') {
    if (tab) await suspendTab(tab);
  }
});

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message: String(message || ''),
    });
  } catch (e) { /* ignore */ }
}

// ---------- Commands ----------
chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd === 'open-sidebar') {
    try {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w) chrome.sidePanel.open({ windowId: w.id });
    } catch (e) { console.warn(e); }
  } else if (cmd === 'save-session') {
    const s = await saveSession('Session ' + new Date().toLocaleString());
    notify('Session saved', s.name);
  }
});

// ---------- Message router ----------
const handlers = {
  async GET_SHOW_WELCOME() { return await storage.get('showWelcome', false); },
  async DISMISS_WELCOME()  { await storage.set('showWelcome', false); return true; },

  async OPEN_SIDEBAR() {
    const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w) await chrome.sidePanel.open({ windowId: w.id });
    return true;
  },

  async OPEN_URL({ url, pinned = false }) {
    if (!url) return false;
    try {
      const { protocol } = new URL(url);
      if (protocol !== 'http:' && protocol !== 'https:') return false;
    } catch { return false; }
    await chrome.tabs.create({ url, pinned });
    return true;
  },

  async GET_SETTINGS() { return await getSettings(); },
  async SET_SETTINGS(payload) {
    const merged = { ...(await getSettings()), ...payload };
    try {
      await storage.setSync('settings', merged);
    } catch (e) {
      // chrome.storage.sync has an 8KB-per-item limit. If the user's settings
      // (e.g. a very long neverSuspendPatterns list) exceed this, fall back to
      // local storage so the save is never silently dropped.
      console.warn('[TabVault] sync storage quota exceeded, falling back to local:', e.message);
      await storage.set('settings', merged);
    }
    _settingsCache = null;
    return true;
  },

  async GET_ALL_TABS({ windowId } = {}) {
    let tabs;
    if (windowId === 'all') {
      tabs = await chrome.tabs.query({});
    } else if (windowId) {
      tabs = await chrome.tabs.query({ windowId });
    } else {
      tabs = await chrome.tabs.query({ currentWindow: true });
    }
    let groups = [];
    try {
      const gQuery = windowId === 'all' ? {} : { windowId: windowId || chrome.windows.WINDOW_ID_CURRENT };
      groups = await chrome.tabGroups.query(gQuery);
    } catch {}
    const windows = windowId === 'all' ? await chrome.windows.getAll({ windowTypes: ['normal'] }) : [];

    // Attach lastActivity timestamp so the sidebar can show tab-age indicators
    await ensureTabActivity();
    const lockedUrls = new Set(await storage.get('lockedUrls', []));
    const tabsEnriched = tabs.map((t) => ({
      ...t,
      _lastActivity: tabActivity.get(t.id) || null,
      _locked:       lockedUrls.has(t.url),
    }));
    return { tabs: tabsEnriched, groups, windows };
  },
  async SWITCH_TAB({ tabId }) {
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  },
  async CLOSE_TAB({ tabId }) { try { await chrome.tabs.remove(tabId); } catch {} return true; },
  async MOVE_TAB({ tabId, index }) { try { await chrome.tabs.move(tabId, { index }); } catch {} return true; },
  async PIN_TAB({ tabId, pinned }) { try { await chrome.tabs.update(tabId, { pinned }); } catch {} return true; },

  async GROUP_TABS({ tabIds, name, color }) {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title: name, color });
    return groupId;
  },
  async AUTO_GROUP_TABS() { return await autoGroupByDomain(); },

  async FIND_DUPLICATES() { return await findDuplicates(); },
  async CLOSE_DUPLICATES() { return await closeDuplicates(); },

  // ── Recently Closed Tabs ──────────────────────────────────
  async GET_RECENT_TABS() {
    try {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      return sessions
        .filter((s) => s.tab) // tabs only, not windows
        .map((s) => ({
          sessionId:  s.tab.sessionId,
          url:        s.tab.url,
          title:      s.tab.title,
          favIconUrl: s.tab.favIconUrl,
          closedAt:   s.lastModified * 1000, // convert to ms
        }));
    } catch { return []; }
  },
  async RESTORE_RECENT_TAB({ sessionId, url }) {
    if (sessionId) {
      try { await chrome.sessions.restore(sessionId); return true; } catch {}
    }
    // Fallback: open URL directly if session restore fails
    if (url) { await chrome.tabs.create({ url }); return true; }
    return false;
  },

  // ── Tab Lock ──────────────────────────────────────────────
  async LOCK_TAB({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return false;
    // Add to in-memory map for immediate protection
    lockedTabIdMap.set(tabId, { url: tab.url, title: tab.title, pinned: tab.pinned });
    // Persist the URL so the lock survives SW restarts
    const urls = await storage.get('lockedUrls', []);
    if (!urls.includes(tab.url)) {
      urls.push(tab.url);
      await storage.set('lockedUrls', urls);
    }
    return true;
  },
  async UNLOCK_TAB({ tabId, url }) {
    // url can be passed directly when the tabId is no longer valid
    const resolvedUrl = url || lockedTabIdMap.get(tabId)?.url ||
      (await chrome.tabs.get(tabId).catch(() => null))?.url;
    if (resolvedUrl) {
      const urls = await storage.get('lockedUrls', []);
      await storage.set('lockedUrls', urls.filter((u) => u !== resolvedUrl));
    }
    if (tabId) lockedTabIdMap.delete(tabId);
    return true;
  },
  async GET_LOCKED_URLS() {
    return await storage.get('lockedUrls', []);
  },

  // ── Audio Control ─────────────────────────────────────────
  async TOGGLE_MUTE_TAB({ tabId, muted }) {
    await chrome.tabs.update(tabId, { muted });
    return true;
  },
  async MUTE_ALL_AUDIO() {
    const tabs = await chrome.tabs.query({ audible: true, muted: false });
    for (const t of tabs) {
      try { await chrome.tabs.update(t.id, { muted: true }); } catch {}
    }
    return tabs.length;
  },
  async UNMUTE_ALL() {
    const tabs = await chrome.tabs.query({ muted: true });
    for (const t of tabs) {
      try { await chrome.tabs.update(t.id, { muted: false }); } catch {}
    }
    return tabs.length;
  },

  async RESTORE_SAVED_SESSION({ session }) {
    // Re-insert a previously deleted session at the top of the list (undo delete)
    if (!session?.id) return false;
    const list = await getAllSessions();
    if (list.some((s) => s.id === session.id)) return false; // already exists
    list.unshift(session);
    if (list.length > MAX_SESSIONS) list.splice(MAX_SESSIONS);
    await storage.set('sessions', list);
    return true;
  },
  async SAVE_SESSION({ name, tags }) { return await saveSession(name, tags); },
  async GET_ALL_SESSIONS() {
    const [sessions, recovery] = await Promise.all([
      getAllSessions(),
      storage.get('recoverySession', null),
    ]);
    // Prepend recovery snapshot if it exists and isn't already in the list
    if (recovery && !sessions.some((s) => s.id === RECOVERY_SESSION_ID)) {
      return [recovery, ...sessions];
    }
    return sessions;
  },
  async DELETE_SESSION({ id }) { return await deleteSession(id); },
  async RESTORE_SESSION({ id, mode }) { return await restoreSession(id, mode); },

  async SUSPEND_TAB({ tabId }) {
    const t = await chrome.tabs.get(tabId);
    return await suspendTab(t);
  },

  async SCAN_BOOKMARKS() { return await scanAllBookmarks(); },

  async GET_BOOKMARK_TREE() { return await chrome.bookmarks.getTree(); },
  async GET_BOOKMARK_META({ id }) { return await storage.get(`bkm_meta_${id}`, {}); },
  async SET_BOOKMARK_META({ id, meta }) {
    const cur = await storage.get(`bkm_meta_${id}`, {});
    await storage.set(`bkm_meta_${id}`, { ...cur, ...meta });
    return true;
  },
  async GET_ALL_BOOKMARK_META() {
    // Derive keys from the actual bookmark tree to avoid loading all storage
    const tree = await chrome.bookmarks.getTree();
    const ids = [];
    function collectIds(nodes) {
      for (const n of nodes) {
        if (n.url) ids.push(n.id);
        if (n.children) collectIds(n.children);
      }
    }
    collectIds(tree);
    if (ids.length === 0) return {};
    const keys = ids.map((id) => `bkm_meta_${id}`);
    const raw = await chrome.storage.local.get(keys);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k.replace('bkm_meta_', '')] = v;
    }
    return out;
  },
  async CREATE_BOOKMARK({ parentId, title, url }) {
    return await chrome.bookmarks.create({ parentId, title, url });
  },
  async UPDATE_BOOKMARK({ id, changes }) {
    return await chrome.bookmarks.update(id, changes);
  },
  async DELETE_BOOKMARK({ id }) {
    try { await chrome.bookmarks.remove(id); } catch { try { await chrome.bookmarks.removeTree(id); } catch {} }
    return true;
  },
  async MOVE_BOOKMARK({ id, parentId, index }) {
    return await chrome.bookmarks.move(id, { parentId, index });
  },

  async EXPORT_DATA() {
    const all = await chrome.storage.local.get(null);
    const settings = await getSettings();
    return { exportedAt: Date.now(), version: 1, local: all, settings };
  },
  async IMPORT_DATA({ data }) {
    if (!data || typeof data !== 'object') throw new Error('Invalid import: not an object');

    // Whitelist of key prefixes allowed in local storage
    const ALLOWED_PREFIXES = ['bkm_meta_', 'sessions', 'tabActivity', 'scanProgress', 'lastScheduledScan'];
    const ALLOWED_EXACT    = new Set(['sessions', 'tabActivity', 'scanProgress', 'lastScheduledScan']);

    if (data.local && typeof data.local === 'object') {
      const safeLocal = {};
      for (const [k, v] of Object.entries(data.local)) {
        const allowed =
          ALLOWED_EXACT.has(k) ||
          ALLOWED_PREFIXES.some((p) => k.startsWith(p));
        if (!allowed) {
          console.warn('[TabVault] IMPORT_DATA: skipping unknown key', k);
          continue;
        }
        safeLocal[k] = v;
      }
      if (Object.keys(safeLocal).length > 0) {
        await chrome.storage.local.set(safeLocal);
      }
    }

    if (data.settings && typeof data.settings === 'object') {
      // Merge with defaults so unknown/malformed keys are dropped
      const safeSettings = {};
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (key in data.settings) safeSettings[key] = data.settings[key];
      }
      await storage.setSync('settings', { ...DEFAULT_SETTINGS, ...safeSettings });
      _settingsCache = null; // invalidate cache
    }
    return true;
  },
  async CLEAR_ALL_DATA() {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
    await storage.setSync('settings', DEFAULT_SETTINGS);
    return true;
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const fn = handlers[message?.type];
  if (!fn) return false;
  Promise.resolve(fn(message.payload || {}))
    .then((r) => sendResponse({ ok: true, data: r }))
    .catch((e) => {
      console.error('[TabVault] handler error', message.type, e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
  return true; // async
});