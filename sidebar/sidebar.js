// sidebar.js — TabVault sidebar main module
import {
  send, $, $$, el, debounce, getDomain, favicon, defaultFaviconDataUri,
  formatDate, formatAge, ageClass, escapeHtml, tagColor,
  toast, showUndoToast, modalPrompt, modalConfirm, flatten,
} from '../shared/common.js';

const state = {
  view: 'tabs',
  tabs: [],
  groups: [],
  windows: [],
  windowFilter: null,
  recentTabs: [],
  lockedUrls: new Set(),
  showRecentlyClosed: false,
  readingList: [],
  workspaces: [],
  domainSummary: [],
  analytics: null,
  focusMode: { active: false },  // Focus Mode state
  sessions: [],
  bookmarkTree: [],
  bookmarkMeta: {},
  flatBookmarks: [],
  duplicates: [],
  selectedTabIds: new Set(),
  searchQuery: '',
  activeTag: null,
  scanResults: null,
  scanProgress: null,
  openFolders: new Set(),
  selectionMode: false,
};

// ----- Views router -----
const views = {};

// Single rerender entry point — always clears #main first.
function render() {
  const main = $('#main');
  if (!main) return;
  main.innerHTML = '';
  try {
    if (state.searchQuery) {
      renderSearch(); // intentionally not awaited — renders incrementally
    } else {
      views[state.view]?.(main);
    }
  } catch (err) {
    console.error('[TabVault] render error in view', state.view, err);
    main.appendChild(renderErrorState(err));
  }
}

function renderErrorState(err) {
  const wrap = el('div', { class: 'empty-state' }, [
    el('h3', {}, 'Something went wrong'),
    el('p', {}, 'Failed to render this view. Try refreshing the sidebar.'),
    el('p', { style: { fontFamily: 'monospace', fontSize: '10px', color: 'var(--text-faint)' } },
      String(err?.message || err)),
    el('button', {
      class: 'btn btn-primary',
      style: { marginTop: '12px' },
      onclick: () => { state.searchQuery = ''; render(); },
    }, 'Retry'),
  ]);
  return wrap;
}

function setView(name) {
  state.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  render();
}

// ----- Focus Mode timer -----
let _focusTimerInterval = null;
function startFocusTimer() {
  if (_focusTimerInterval) return; // already running
  _focusTimerInterval = setInterval(() => {
    const el = document.getElementById('focusTimerDisplay');
    if (!el || !state.focusMode?.active) {
      clearInterval(_focusTimerInterval);
      _focusTimerInterval = null;
      return;
    }
    const ms   = Date.now() - state.focusMode.startTime;
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

document.addEventListener('click', (e) => {
  const navItem = e.target.closest('.nav-item');
  if (navItem) setView(navItem.dataset.view);
});

$('#settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ----- Initial load -----
async function init() {
  await refreshAll();
  setView('tabs');
  setupSearch();
  setupTabListeners();
  setupScanProgressListener();

  // First-run onboarding: show welcome card if this is a fresh install
  const showWelcome = await send('GET_SHOW_WELCOME');
  if (showWelcome) renderWelcomeCard();
}

function renderWelcomeCard() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const features = [
    ['🗂', 'Tab Manager',      'Search, group, pin and suspend tabs across windows.'],
    ['💾', 'Sessions',         'Save your open tabs as named sessions and restore them anytime.'],
    ['🔖', 'Bookmarks',        'Browse, tag, annotate and search all your Chrome bookmarks.'],
    ['🔗', 'Broken Link Scan', 'Find and clean dead bookmark URLs with one click.'],
    ['💤', 'Tab Suspender',    'Automatically suspend idle tabs to save memory.'],
  ];
  const featureList = el('div', { style: 'display:flex;flex-direction:column;gap:10px;margin:16px 0;' },
    features.map(([icon, name, desc]) =>
      el('div', { style: 'display:flex;gap:12px;align-items:flex-start;' }, [
        el('span', { style: 'font-size:20px;flex-shrink:0;' }, icon),
        el('div', {}, [
          el('div', { style: 'font-weight:600;font-size:13px;' }, name),
          el('div', { style: 'font-size:11px;color:var(--text-dim);' }, desc),
        ]),
      ])
    )
  );

  const modal = el('div', { class: 'modal', style: 'max-width:360px;width:100%;' }, [
    el('div', { style: 'text-align:center;margin-bottom:8px;font-size:32px;' }, '🗄️'),
    el('h3', { style: 'text-align:center;font-size:16px;' }, 'Welcome to TabVault'),
    el('p', { style: 'text-align:center;font-size:12px;color:var(--text-dim);' },
      'Your all-in-one tab and bookmark workspace. Here\'s what you can do:'),
    featureList,
    el('button', {
      class: 'btn btn-primary',
      style: 'width:100%;justify-content:center;padding:10px;',
      onclick: async () => {
        backdrop.remove();
        await send('DISMISS_WELCOME');
      },
    }, 'Get started'),
  ]);

  backdrop.appendChild(modal);
  backdrop.addEventListener('click', async (e) => {
    if (e.target === backdrop) {
      backdrop.remove();
      await send('DISMISS_WELCOME');
    }
  });
  document.body.appendChild(backdrop);
}

// Fix 3: Listen for scan progress written by background.js into storage.
// This replaces the broken "frozen at 0" pattern where progress had no channel back.
function setupScanProgressListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.scanProgress) return;
    const progress = changes.scanProgress.newValue;
    if (!progress) return;
    if (progress.running) {
      state.scanProgress = { done: progress.done, total: progress.total };
    } else {
      // Scan finished — reload metadata then clear progress indicator
      refreshAll().then(() => {
        state.scanProgress = null;
        if (state.view === 'broken') render();
      });
      return;
    }
    if (state.view === 'broken') render();
  });
}

async function refreshAll() {
  try {
    const [tabsData, sessions, tree, meta, dups, recent, locked, reading, workspaces, domainSummary, focusState] = await Promise.all([
      send('GET_ALL_TABS', { windowId: state.windowFilter }),
      send('GET_ALL_SESSIONS'),
      send('GET_BOOKMARK_TREE'),
      send('GET_ALL_BOOKMARK_META'),
      send('FIND_DUPLICATES'),
      send('GET_RECENT_TABS'),
      send('GET_LOCKED_URLS'),
      send('GET_READING_LIST'),
      send('GET_WORKSPACES'),
      send('GET_DOMAIN_SUMMARY'),
      send('GET_FOCUS_STATE'),
    ]);
    state.tabs           = tabsData.tabs    || [];
    state.groups         = tabsData.groups  || [];
    state.windows        = tabsData.windows || [];
    state.sessions       = sessions         || [];
    state.bookmarkTree   = tree             || [];
    state.bookmarkMeta   = meta             || {};
    state.duplicates     = dups             || [];
    state.recentTabs     = recent           || [];
    state.lockedUrls     = new Set(locked   || []);
    state.readingList    = reading          || [];
    state.workspaces     = workspaces       || [];
    state.domainSummary  = domainSummary    || [];
    state.focusMode      = focusState       || { active: false };
    state.flatBookmarks  = [];
    flatten(state.bookmarkTree, state.flatBookmarks);
    if (state.focusMode.active) startFocusTimer();
    updateNavBadges();
  } catch (e) {
    console.error('[TabVault] refresh failed:', e);
    toast('Failed to load data', 'error');
  }
}

// Lightweight refresh — only fetches tab-related data. Called on every tab
// event (activate, create, remove, update, move, group changes). Avoids
// hammering the background with bookmark/session/workspace messages that
// haven't changed just because the user switched tabs.
async function refreshTabs() {
  try {
    const [tabsData, dups, recent, domainSummary, focusState] = await Promise.all([
      send('GET_ALL_TABS', { windowId: state.windowFilter }),
      send('FIND_DUPLICATES'),
      send('GET_RECENT_TABS'),
      send('GET_DOMAIN_SUMMARY'),
      send('GET_FOCUS_STATE'),
    ]);
    state.tabs          = tabsData.tabs    || [];
    state.groups        = tabsData.groups  || [];
    state.windows       = tabsData.windows || [];
    state.duplicates    = dups             || [];
    state.recentTabs    = recent           || [];
    state.domainSummary = domainSummary    || [];
    state.focusMode     = focusState       || { active: false };
    if (state.focusMode.active) startFocusTimer();
    updateNavBadges();
  } catch (e) {
    console.error('[TabVault] tab refresh failed:', e);
  }
}

// Bookmark-only refresh — called when chrome.bookmarks events fire. Only
// re-fetches the tree and metadata; leaves tabs, sessions, etc. untouched.
async function refreshBookmarks() {
  try {
    const [tree, meta] = await Promise.all([
      send('GET_BOOKMARK_TREE'),
      send('GET_ALL_BOOKMARK_META'),
    ]);
    state.bookmarkTree  = tree || [];
    state.bookmarkMeta  = meta || {};
    state.flatBookmarks = [];
    flatten(state.bookmarkTree, state.flatBookmarks);
  } catch (e) {
    console.error('[TabVault] bookmark refresh failed:', e);
  }
}

// Update the nav sidebar badges without triggering a full data fetch.
function updateNavBadges() {
    $('#navTabCount').textContent  = state.tabs.length;
    $('#navSessionCount').textContent = state.sessions.length;

    const dupTotal = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);
    const dupBadge = $('#navDupCount');
    if (dupTotal > 0) { dupBadge.hidden = false; dupBadge.textContent = dupTotal; }
    else dupBadge.hidden = true;

    const readBadge = $('#navReadingCount');
    if (state.readingList.length > 0) { readBadge.hidden = false; readBadge.textContent = state.readingList.length; }
    else readBadge.hidden = true;

    const wsBadge = $('#navWsCount');
    if (state.workspaces.length > 0) { wsBadge.hidden = false; wsBadge.textContent = state.workspaces.length; }
    else wsBadge.hidden = true;
}

// ----- Tab listeners (live updates) -----
function setupTabListeners() {
  // Tab events → lightweight tab-only refresh. The debounce absorbs bursts
  // (e.g. restoring a session opens many tabs rapidly).
  const refreshTabsDebounced = debounce(async () => {
    await refreshTabs();
    if (!state.searchQuery) render();
  }, 150);

  // Bookmark events → bookmark-only refresh. Longer debounce — bookmark
  // changes are typically user-driven and less time-critical than tab switches.
  const refreshBookmarksDebounced = debounce(async () => {
    await refreshBookmarks();
    // Only re-render if the user is currently viewing a bookmark-related view.
    const bmViews = new Set(['bookmarks', 'tags', 'broken']);
    if (!state.searchQuery && bmViews.has(state.view)) render();
  }, 400);

  chrome.tabs.onCreated.addListener(refreshTabsDebounced);
  chrome.tabs.onRemoved.addListener(refreshTabsDebounced);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    // Only refresh on meaningful changes; 'loading' fires on every URL keystroke
    if (info.status === 'complete' || info.title || info.pinned !== undefined) refreshTabsDebounced();
  });
  chrome.tabs.onMoved.addListener(refreshTabsDebounced);
  chrome.tabs.onActivated.addListener(refreshTabsDebounced);
  try {
    chrome.tabGroups.onCreated.addListener(refreshTabsDebounced);
    chrome.tabGroups.onUpdated.addListener(refreshTabsDebounced);
    chrome.tabGroups.onRemoved.addListener(refreshTabsDebounced);
  } catch {}
  chrome.bookmarks.onCreated.addListener(refreshBookmarksDebounced);
  chrome.bookmarks.onRemoved.addListener(refreshBookmarksDebounced);
  chrome.bookmarks.onChanged.addListener(refreshBookmarksDebounced);
  chrome.bookmarks.onMoved.addListener(refreshBookmarksDebounced);
}

// ===========================================================================
// TABS VIEW
// ===========================================================================
views.tabs = function (root) {
  const panel = el('div', { class: 'panel' + (state.selectionMode ? ' selection-mode' : '') });

  const audioTabs   = state.tabs.filter((t) => t.audible && !t.mutedInfo?.muted);
  const mutedTabs   = state.tabs.filter((t) => t.mutedInfo?.muted);
  const hasAudio    = audioTabs.length > 0;
  const hasMuted    = mutedTabs.length > 0;

  const windowPickerItems = [
    el('option', { value: '' }, 'Current window'),
    el('option', { value: 'all' }, `All windows${state.windows.length > 1 ? ` (${state.windows.length})` : ''}`),
  ];
  const windowPicker = el('select', {
    style: { fontSize: '11px', padding: '3px 6px', maxWidth: '140px' },
    onchange: async (e) => {
      state.windowFilter = e.target.value || null;
      await refreshAll();
      render();
    },
  }, windowPickerItems);
  if (state.windowFilter) windowPicker.value = state.windowFilter;

  const header = el('div', { class: 'panel-header' }, [
    el('h2', {}, state.selectionMode ? `Select tabs (${state.selectedTabIds.size})` : 'Open Tabs'),
    windowPicker,
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn' + (state.selectionMode ? ' btn-primary' : ' btn-ghost'),
        title: 'Toggle selection mode',
        onclick: () => {
          state.selectionMode = !state.selectionMode;
          state.selectedTabIds.clear();
          render();
        },
      }, state.selectionMode ? 'Done' : 'Select'),
      state.selectionMode ? el('button', {
        class: 'btn',
        title: 'Group selected tabs',
        onclick: groupSelected,
      }, `Group (${state.selectedTabIds.size})`) : null,
      state.selectionMode ? el('button', {
        class: 'btn btn-danger',
        title: 'Close selected',
        'aria-label': 'Close selected tabs',
        onclick: async () => {
          if (state.selectedTabIds.size === 0) return;
          // Snapshot tab info before closing so the undo toast can restore them.
          const toClose = state.tabs.filter((t) => state.selectedTabIds.has(t.id));
          const snapshots = toClose.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned }));
          for (const t of toClose) {
            try { await send('CLOSE_TAB', { tabId: t.id }); } catch {}
          }
          state.selectedTabIds.clear();
          state.selectionMode = false;
          await refreshTabs();
          render();
          const count = snapshots.length;
          showUndoToast(
            `Closed ${count} tab${count === 1 ? '' : 's'}`,
            async () => {
              for (const s of snapshots) {
                try { await send('OPEN_URL', { url: s.url, pinned: s.pinned }); } catch {}
              }
              await refreshTabs(); render();
            },
          );
        },
      }, 'Close') : null,
      !state.selectionMode ? el('button', {
        class: 'btn',
        title: 'Auto-group by domain',
        onclick: async () => {
          const n = await send('AUTO_GROUP_TABS');
          toast(`Created ${n} group${n === 1 ? '' : 's'}`, 'success');
          await refreshAll();
          render();
        },
      }, 'Auto-group') : null,
      // Smart Auto-Grouping (AI)
      !state.selectionMode ? el('button', {
        class: 'btn btn-smart-group',
        id: 'smartGroupBtn',
        title: 'Use AI to group tabs by topic',
        onclick: () => runSmartGrouping(),
      }, [
        (() => {
          const ns = 'http://www.w3.org/2000/svg';
          const s  = document.createElementNS(ns, 'svg');
          s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24');
          s.innerHTML = '<path d="M12 2a5 5 0 015 5v3h1a2 2 0 012 2v7a2 2 0 01-2 2H6a2 2 0 01-2-2v-7a2 2 0 012-2h1V7a5 5 0 015-5z"/><circle cx="12" cy="16" r="1.5"/>';
          return s;
        })(),
        'Smart Group',
      ]) : null,
      // Mute All — only shown when audio is playing
      (hasAudio && !state.selectionMode) ? el('button', {
        class: 'btn btn-audio-mute',
        title: `Mute all ${audioTabs.length} playing tab${audioTabs.length === 1 ? '' : 's'}`,
        onclick: async () => {
          await send('MUTE_ALL_AUDIO');
          await refreshAll(); render();
        },
      }, [
        el('span', { class: 'audio-pulse' }),
        `Mute all (${audioTabs.length})`,
      ]) : null,
      // Unmute All — only shown when tabs are muted
      (hasMuted && !hasAudio && !state.selectionMode) ? el('button', {
        class: 'btn btn-ghost',
        title: 'Unmute all tabs',
        onclick: async () => { await send('UNMUTE_ALL'); await refreshAll(); render(); },
      }, 'Unmute all') : null,
    ].filter(Boolean)),
  ]);
  panel.appendChild(header);

  // Focus Mode banner — shown when focus mode is active
  if (state.focusMode.active) {
    const banner = el('div', { class: 'focus-banner' }, [
      el('span', { class: 'focus-dot' }),
      el('span', { class: 'focus-title' }, `Focusing: ${state.focusMode.groupTitle}`),
      el('span', { id: 'focusTimerDisplay', class: 'focus-timer' }, '0:00'),
      el('button', {
        class: 'btn focus-exit-btn',
        onclick: async () => {
          await send('EXIT_FOCUS_MODE');
          clearInterval(_focusTimerInterval);
          _focusTimerInterval = null;
          toast('Focus mode ended — tabs restored', 'success');
          await refreshAll(); render();
        },
      }, 'Exit Focus'),
    ]);
    panel.appendChild(banner);
    startFocusTimer();
  }

  const body = el('div', { class: 'panel-body' });
  body.id = 'tabsBody';

  if (state.tabs.length === 0) {
    body.appendChild(emptyState('No tabs open', 'Open some websites to get started.'));
  } else {
    renderTabList(body);
  }

  // Recently closed section
  if (state.recentTabs.length > 0) {
    body.appendChild(renderRecentlyClosed());
  }

  panel.appendChild(body);

  // stats bar
  const sleeping = state.tabs.filter((t) => t.url?.includes('suspended.html')).length;
  const dupCount = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);
  const stats = el('div', { class: 'stats-bar' }, [
    el('span', { class: 'pill' }, `🗂 ${state.tabs.length} tabs`),
    el('span', { class: 'pill' }, `💤 ${sleeping} sleeping`),
    el('span', { class: 'pill' }, `📋 ${state.groups.length} groups`),
    el('span', { class: 'pill' }, `⚠️ ${dupCount} duplicate${dupCount === 1 ? '' : 's'}`),
  ]);
  panel.appendChild(stats);

  root.appendChild(panel);
};

function renderTabList(container) {
  const pinned    = state.tabs.filter((t) => t.pinned);
  const ungrouped = state.tabs.filter((t) => !t.pinned && (t.groupId === -1 || t.groupId == null));
  const grouped   = new Map();
  for (const t of state.tabs) {
    if (t.pinned) continue;
    if (t.groupId !== -1 && t.groupId != null) {
      if (!grouped.has(t.groupId)) grouped.set(t.groupId, []);
      grouped.get(t.groupId).push(t);
    }
  }

  if (pinned.length) {
    container.appendChild(el('div', { class: 'group-header' }, 'Pinned'));
    for (const t of pinned) container.appendChild(tabRow(t));
  }

  for (const group of state.groups) {
    const tabs = grouped.get(group.id);
    if (!tabs) continue;
    const hdr = el('div', { class: 'group-header' }, [
      el('span', { class: `group-dot group-${group.color}` }),
      el('span', {}, group.title || '(unnamed group)'),
      el('span', { class: 'folder-count' }, `${tabs.length}`),
      // Focus this group button
      !state.focusMode.active ? el('button', {
        class: 'btn btn-icon btn-ghost focus-group-btn',
        title: `Focus on "${group.title || 'this group'}" — suspend all other tabs`,
        onclick: async (e) => {
          e.stopPropagation();
          await send('ENTER_FOCUS_MODE', { groupId: group.id, groupTitle: group.title || 'Focus Group' });
          toast(`Focus mode: ${group.title || 'group'}`, 'success');
          await refreshAll(); render();
        },
      }, (() => {
        const ns = 'http://www.w3.org/2000/svg';
        const s  = document.createElementNS(ns, 'svg');
        s.setAttribute('class', 'icon'); s.setAttribute('viewBox', '0 0 24 24');
        s.innerHTML = '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>';
        return s;
      })()) : null,
    ].filter(Boolean));
    container.appendChild(hdr);
    for (const t of tabs) container.appendChild(tabRow(t));
  }

  // Ungrouped tabs — show as domain clusters with close-by-domain button
  if (ungrouped.length > 0) {
    const byDomain = new Map();
    for (const t of ungrouped) {
      try {
        const domain = new URL(t.url).hostname.replace(/^www\./, '');
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain).push(t);
      } catch {
        if (!byDomain.has('other')) byDomain.set('other', []);
        byDomain.get('other').push(t);
      }
    }
    for (const [domain, tabs] of byDomain) {
      if (tabs.length > 1) {
        // Show a domain cluster header with close-all button
        const hdr = el('div', { class: 'group-header domain-header' }, [
          el('span', { class: 'domain-label' }, domain),
          el('span', { class: 'folder-count' }, `${tabs.length}`),
          el('button', {
            class: 'btn btn-icon btn-ghost close-domain-btn',
            title: `Close all ${tabs.length} ${domain} tabs`,
            onclick: async (e) => {
              e.stopPropagation();
              const n = await send('CLOSE_TABS_BY_DOMAIN', { domain });
              toast(`Closed ${n} ${domain} tab${n === 1 ? '' : 's'}`, 'success');
              await refreshAll(); render();
            },
          }, '✕'),
        ]);
        container.appendChild(hdr);
      }
      for (const t of tabs) container.appendChild(tabRow(t));
    }
  }
}

function renderRecentlyClosed() {
  const shown = state.showRecentlyClosed;
  const wrap  = el('div', { class: 'recent-section' });

  const toggle = el('div', {
    class: 'recent-header',
    onclick: () => { state.showRecentlyClosed = !state.showRecentlyClosed; render(); },
  }, [
    el('span', { class: 'recent-chevron' + (shown ? ' open' : '') }, '›'),
    el('span', { class: 'recent-label' }, 'Recently closed'),
    el('span', { class: 'recent-count' }, String(state.recentTabs.length)),
  ]);
  wrap.appendChild(toggle);

  if (shown) {
    const list = el('div', { class: 'recent-list' });
    for (const t of state.recentTabs.slice(0, 12)) {
      const age = formatAge(t.closedAt);
      const row = el('div', { class: 'recent-row' });

      const fav = el('img', { class: 'fav', src: t.favIconUrl || favicon(t.url), alt: '' });
      fav.onerror = () => { fav.src = defaultFaviconDataUri(); };

      row.appendChild(fav);
      row.appendChild(el('div', { class: 'meta' }, [
        el('div', { class: 'title' }, t.title || t.url),
        el('div', { class: 'sub' }, getDomain(t.url)),
      ]));
      if (age) row.appendChild(el('span', { class: 'recent-age' }, age));

      row.appendChild(el('button', {
        class: 'btn btn-icon btn-ghost recent-restore',
        title: 'Restore tab',
        onclick: async (e) => {
          e.stopPropagation();
          await send('RESTORE_RECENT_TAB', { sessionId: t.sessionId, url: t.url });
          await refreshAll(); render();
        },
      }, [
        (() => {
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('class', 'icon');
          const p = document.createElementNS(ns, 'path');
          p.setAttribute('d', 'M21 12a9 9 0 11-3-6.7');
          const p2 = document.createElementNS(ns, 'path');
          p2.setAttribute('d', 'M21 4v5h-5');
          svg.append(p, p2);
          return svg;
        })(),
      ]));

      row.addEventListener('click', async () => {
        await send('RESTORE_RECENT_TAB', { sessionId: t.sessionId, url: t.url });
        await refreshAll(); render();
      });

      list.appendChild(row);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

function tabRow(tab) {
  const isSuspended = tab.url?.includes('suspended.html');
  const isSelected  = state.selectedTabIds.has(tab.id);
  const isLocked    = tab._locked || state.lockedUrls.has(tab.url);
  const isPlaying   = tab.audible && !tab.mutedInfo?.muted;
  const isMuted     = !!tab.mutedInfo?.muted;
  const age         = formatAge(tab._lastActivity);
  const ageCls      = ageClass(tab._lastActivity);

  const row = el('div', {
    class: [
      'row',
      tab.active    ? 'active'    : '',
      isSuspended   ? 'suspended' : '',
      tab.pinned    ? 'pinned'    : '',
      isSelected    ? 'selected'  : '',
      isLocked      ? 'is-locked' : '',
      isPlaying     ? 'is-playing': '',
      isMuted       ? 'is-muted'  : '',
    ].filter(Boolean).join(' '),
    role: 'listitem',
    'data-tab-id': tab.id,
    draggable: 'true',
  });

  row.appendChild(el('span', { class: 'drag', title: 'Drag to reorder' }, '⠿'));

  const checkbox = el('input', {
    type: 'checkbox',
    class: 'checkbox',
    checked: isSelected ? '' : null,
    onclick: (e) => {
      e.stopPropagation();
      if (e.target.checked) state.selectedTabIds.add(tab.id);
      else state.selectedTabIds.delete(tab.id);
      row.classList.toggle('selected', e.target.checked);
    },
  });
  if (isSelected) checkbox.checked = true;
  row.appendChild(checkbox);

  const fav = el('img', {
    class: 'fav',
    src: tab.favIconUrl || favicon(tab.url),
    alt: '',
  });
  fav.addEventListener('error', () => { fav.src = defaultFaviconDataUri(); });

  // Audio playing pulse indicator on the favicon
  const favWrap = el('div', { class: 'fav-wrap' });
  favWrap.appendChild(fav);
  if (isPlaying || isMuted) {
    favWrap.appendChild(el('span', { class: 'audio-dot' + (isMuted ? ' muted' : '') }));
  }
  row.appendChild(favWrap);

  const metaDiv = el('div', { class: 'meta' }, [
    el('div', { class: 'title' }, tab.title || '(untitled)'),
    el('div', { class: 'sub' }, getDomain(tab.url)),
  ]);
  row.appendChild(metaDiv);

  // Age badge
  if (age) {
    row.appendChild(el('span', { class: `age-badge ${ageCls}` }, age));
  }

  const actions = el('div', { class: 'actions' }, [
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: 'Save to Reading List',
      'aria-label': 'Save to Reading List',
      onclick: async (e) => {
        e.stopPropagation();
        const ok = await send('SAVE_TO_READING_LIST', { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
        toast(ok ? 'Saved to Reading List' : 'Already in Reading List', ok ? 'success' : 'info');
      },
    }, (() => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = '<path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/>';
      return svg;
    })()),
    // Lock / Unlock button — always visible when locked
    el('button', {
      class: 'btn btn-icon btn-ghost lock-btn' + (isLocked ? ' locked' : ''),
      title: isLocked ? 'Unlock tab (click to allow closing)' : 'Lock tab (prevent accidental close)',
      'aria-label': isLocked ? 'Unlock tab' : 'Lock tab',
      onclick: async (e) => {
        e.stopPropagation();
        if (isLocked) {
          await send('UNLOCK_TAB', { tabId: tab.id, url: tab.url });
        } else {
          await send('LOCK_TAB', { tabId: tab.id });
        }
        await refreshAll(); render();
      },
    }, (() => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = isLocked
        ? '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>'
        : '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 019.9-1"/>';
      return svg;
    })()),
    // Mute / Unmute — only shown for audio tabs
    (isPlaying || isMuted) ? el('button', {
      class: 'btn btn-icon btn-ghost',
      title: isMuted ? 'Unmute tab' : 'Mute tab',
      'aria-label': isMuted ? 'Unmute tab' : 'Mute tab',
      onclick: async (e) => {
        e.stopPropagation();
        await send('TOGGLE_MUTE_TAB', { tabId: tab.id, muted: !isMuted });
        await refreshAll(); render();
      },
    }, (() => {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('class', 'icon'); svg.setAttribute('viewBox', '0 0 24 24');
      svg.innerHTML = isMuted
        ? '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>'
        : '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/>';
      return svg;
    })()) : null,
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: tab.pinned ? 'Unpin' : 'Pin',
      'aria-label': tab.pinned ? 'Unpin tab' : 'Pin tab',
      onclick: async (e) => {
        e.stopPropagation();
        await send('PIN_TAB', { tabId: tab.id, pinned: !tab.pinned });
        await refreshAll(); render();
      },
    }, tab.pinned ? '📍' : '📌'),
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: 'Suspend',
      'aria-label': 'Suspend tab',
      onclick: async (e) => {
        e.stopPropagation();
        await send('SUSPEND_TAB', { tabId: tab.id });
        await refreshAll(); render();
      },
    }, '💤'),
    // Close — hidden for locked tabs
    !isLocked ? el('button', {
      class: 'btn btn-icon btn-ghost',
      title: 'Close',
      'aria-label': `Close tab: ${tab.title || 'untitled'}`,
      onclick: async (e) => {
        e.stopPropagation();
        const { url, title, pinned } = tab;
        await send('CLOSE_TAB', { tabId: tab.id });
        showUndoToast(`Closed "${tab.title || 'tab'}"`, async () => {
          await send('OPEN_URL', { url, pinned });
        });
      },
    }, '✕') : null,
  ].filter(Boolean));
  row.appendChild(actions);

  row.addEventListener('click', async (e) => {
    if (e.target.closest('button') || e.target.closest('input')) return;
    if (state.selectionMode) {
      // Toggle selection instead of switching
      const cb = row.querySelector('.checkbox');
      cb.checked = !cb.checked;
      if (cb.checked) state.selectedTabIds.add(tab.id);
      else state.selectedTabIds.delete(tab.id);
      row.classList.toggle('selected', cb.checked);
      return;
    }
    await send('SWITCH_TAB', { tabId: tab.id });
  });

  // Drag and drop
  row.addEventListener('dragstart', (e) => {
    row.classList.add('dragging');
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'tab', tabId: tab.id }));
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop-target'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.kind === 'tab' && data.tabId !== tab.id) {
        await send('MOVE_TAB', { tabId: data.tabId, index: tab.index });
      }
    } catch {}
  });

  return row;
}

async function groupSelected() {
  if (state.selectedTabIds.size < 2) {
    toast('Select at least 2 tabs', 'error');
    return;
  }
  const name = await modalPrompt('Group name', 'New group');
  if (!name) return;
  await send('GROUP_TABS', { tabIds: [...state.selectedTabIds], name, color: 'blue' });
  state.selectedTabIds.clear();
  toast('Group created', 'success');
  await refreshAll();
  render();
}

// ===========================================================================
// SESSIONS VIEW
// ===========================================================================
views.sessions = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Saved Sessions'),
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const name = await modalPrompt('Session name', 'Session ' + new Date().toLocaleString());
          if (!name) return;
          await send('SAVE_SESSION', { name, tags: [] });
          toast('Session saved', 'success');
          await refreshAll();
          render();
        },
      }, '+ Save current'),
    ]),
  ]));

  const body = el('div', { class: 'panel-body' });
  if (state.sessions.length === 0) {
    body.appendChild(emptyState('No sessions saved yet', 'Save your current tabs as a session to restore them later.'));
  } else {
    for (const s of state.sessions) body.appendChild(sessionCard(s));
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

function sessionCard(s) {
  const card = el('div', { class: 'session-card' });
  card.appendChild(el('div', { class: 'session-head' }, [
    el('div', {}, [
      el('div', { class: 'session-name' }, s.name),
      el('div', { class: 'session-meta' }, `${s.tabs.length} tabs · ${formatDate(s.createdAt)}`),
    ]),
    el('button', {
      class: 'btn btn-icon btn-ghost btn-danger',
      title: 'Delete',
      onclick: async () => {
        const snapshot = JSON.parse(JSON.stringify(s)); // deep copy before deletion
        await send('DELETE_SESSION', { id: s.id });
        toast('Session deleted', 'success');
        showUndoToast(`Deleted "${s.name}"`, async () => {
          await send('RESTORE_SAVED_SESSION', { session: snapshot });
          await refreshAll();
          render();
        });
        await refreshAll();
        render();
      },
    }, '×'),
  ]));

  // tags
  if (s.tags?.length) {
    card.appendChild(el('div', { class: 'bookmark-tags' },
      s.tags.map((t) => el('span', { class: 'tag-pill', style: { background: tagColor(t) } }, t))));
  }

  // favicons preview
  card.appendChild(el('div', { class: 'session-favicons' },
    s.tabs.slice(0, 5).map((t) => el('img', {
      src: t.favIconUrl || favicon(t.url),
      onerror: function () { this.src = defaultFaviconDataUri(); },
      title: t.title,
      alt: '',
    }))));

  card.appendChild(el('div', { class: 'session-actions' }, [
    el('button', {
      class: 'btn btn-primary',
      onclick: async () => {
        await send('RESTORE_SESSION', { id: s.id, mode: 'new' });
        toast('Restored in new window', 'success');
      },
    }, 'Restore'),
    el('button', {
      class: 'btn',
      onclick: async () => {
        await send('RESTORE_SESSION', { id: s.id, mode: 'merge' });
        toast('Merged into current window', 'success');
      },
    }, 'Merge'),
  ]));
  return card;
}

// ===========================================================================
// BOOKMARKS VIEW
// ===========================================================================
views.bookmarks = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Bookmarks' + (state.activeTag ? ` · #${state.activeTag}` : '')),
    el('div', { class: 'panel-actions' }, [
      state.activeTag ? el('button', { class: 'btn', onclick: () => { state.activeTag = null; render(); } }, 'Clear filter') : null,
      el('button', { class: 'btn', onclick: exportBookmarks }, 'Export'),
      el('label', { class: 'btn' }, [
        'Import',
        el('input', {
          type: 'file', accept: '.html', style: { display: 'none' }, onchange: importBookmarks,
        }),
      ]),
    ].filter(Boolean)),
  ]));

  const body = el('div', { class: 'panel-body' });
  if (state.activeTag) {
    const filtered = state.flatBookmarks.filter((bm) => {
      const meta = state.bookmarkMeta[bm.id] || {};
      return (meta.tags || []).includes(state.activeTag);
    });
    if (filtered.length === 0) body.appendChild(emptyState('No bookmarks for this tag', ''));
    else for (const bm of filtered) body.appendChild(bookmarkRow(bm));
  } else if (state.bookmarkTree.length === 0 || state.flatBookmarks.length === 0) {
    body.appendChild(emptyState('No bookmarks', 'Your bookmarks will appear here.'));
  } else {
    for (const node of state.bookmarkTree) renderTree(node, body, true);
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

function renderTree(node, container, isRoot = false) {
  if (node.children) {
    if (isRoot) {
      // Render root's children directly
      for (const c of node.children) renderTree(c, container, false);
      return;
    }
    const isOpen = state.openFolders.has(node.id);
    const folder = el('div', { class: 'tree-folder' + (isOpen ? ' open' : '') });
    const header = el('div', { class: 'tree-folder-header' }, [
      el('span', { class: 'chevron' }, '▶'),
      iconSvg('M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z'),
      el('span', {}, node.title || '(untitled folder)'),
      el('span', { class: 'folder-count' }, `${node.children.length}`),
    ]);
    header.addEventListener('click', () => {
      if (state.openFolders.has(node.id)) state.openFolders.delete(node.id);
      else state.openFolders.add(node.id);
      folder.classList.toggle('open');
    });
    folder.appendChild(header);
    const childContainer = el('div', { class: 'tree-children' });
    for (const c of node.children) renderTree(c, childContainer, false);
    folder.appendChild(childContainer);
    container.appendChild(folder);
  } else if (node.url) {
    container.appendChild(bookmarkRow(node));
  }
}

function bookmarkRow(bm) {
  const meta = state.bookmarkMeta[bm.id] || {};
  const row = el('div', { class: 'row', 'data-bm-id': bm.id, draggable: 'true' });

  row.appendChild(el('img', {
    class: 'fav',
    src: favicon(bm.url),
    onerror: function () { this.src = defaultFaviconDataUri(); },
    alt: '',
  }));

  const metaDiv = el('div', { class: 'meta' });
  metaDiv.appendChild(el('div', { class: 'title' }, meta.customTitle || bm.title || bm.url));
  metaDiv.appendChild(el('div', { class: 'sub' }, getDomain(bm.url)));
  if (meta.tags?.length) {
    metaDiv.appendChild(el('div', { class: 'bookmark-tags' },
      meta.tags.map((t) => el('span', {
        class: 'tag-pill',
        style: { background: tagColor(t) },
        onclick: (e) => { e.stopPropagation(); state.activeTag = t; setView('bookmarks'); },
      }, t))));
  }
  row.appendChild(metaDiv);

  if (meta.scanStatus) {
    const cls = meta.scanStatus === 'alive' ? 'status-alive' : meta.scanStatus === 'broken' ? 'status-broken' : 'status-unknown';
    row.appendChild(el('span', { class: cls, title: meta.scanStatus }, meta.scanStatus === 'alive' ? '✓' : meta.scanStatus === 'broken' ? '✗' : '?'));
  }

  row.appendChild(el('div', { class: 'actions' }, [
    el('button', {
      class: 'btn btn-icon btn-ghost', title: 'Edit tags & note',
      onclick: (e) => { e.stopPropagation(); openNotePanel(row, bm); },
    }, '✏️'),
    el('button', {
      class: 'btn btn-icon btn-ghost', title: 'Copy link',
      onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(bm.url); toast('Link copied', 'success'); },
    }, '📋'),
    el('button', {
      class: 'btn btn-icon btn-ghost btn-danger', title: 'Delete',
      onclick: async (e) => {
        e.stopPropagation();
        const ok = await modalConfirm('Delete bookmark?', bm.title);
        if (!ok) return;
        // Snapshot for undo before deletion
        const { parentId, title, url } = bm;
        await send('DELETE_BOOKMARK', { id: bm.id });
        showUndoToast(`Deleted "${title}"`, async () => {
          await send('CREATE_BOOKMARK', { parentId, title, url });
          await refreshAll();
          render();
        });
        await refreshAll();
        render();
      },
    }, '🗑'),
  ]));

  row.addEventListener('click', async (e) => {
    if (e.target.closest('button')) return;
    await chrome.tabs.create({ url: bm.url, active: true });
  });

  // Drag/drop
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'bookmark', id: bm.id }));
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));

  return row;
}

function openNotePanel(row, bm) {
  const existing = row.nextElementSibling;
  if (existing?.classList.contains('note-panel')) { existing.remove(); return; }

  const meta = state.bookmarkMeta[bm.id] || {};
  const tagInput = el('input', {
    type: 'text', placeholder: 'tag1, tag2, tag3',
    value: (meta.tags || []).join(', '),
    style: { width: '100%', marginBottom: '6px' },
  });
  const noteArea = el('textarea', {
    placeholder: 'Add a note (max 2000 chars)…',
    maxlength: '2000',
  }, meta.note || '');

  const panel = el('div', { class: 'note-panel' }, [
    el('label', { style: { fontSize: '11px', color: 'var(--text-dim)' } }, 'Tags'),
    tagInput,
    el('label', { style: { fontSize: '11px', color: 'var(--text-dim)' } }, 'Note'),
    noteArea,
    el('div', { class: 'note-panel-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const tags = tagInput.value.split(',').map((s) => s.trim()).filter(Boolean);
          const note = noteArea.value;
          await send('SET_BOOKMARK_META', { id: bm.id, meta: { tags, note } });
          state.bookmarkMeta[bm.id] = { ...state.bookmarkMeta[bm.id], tags, note };
          toast('Saved', 'success');
          panel.remove();
          render();
        },
      }, 'Save'),
      el('button', { class: 'btn', onclick: () => panel.remove() }, 'Cancel'),
    ]),
  ]);
  row.parentNode.insertBefore(panel, row.nextSibling);
}

// ===========================================================================
// TAGS VIEW
// ===========================================================================
views.tags = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [el('h2', {}, 'Tags')]));

  const counts = new Map();
  for (const meta of Object.values(state.bookmarkMeta)) {
    for (const t of meta.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }

  const body = el('div', { class: 'panel-body' });
  if (counts.size === 0) {
    body.appendChild(emptyState('No tags yet', 'Add tags to bookmarks to see them grouped here.'));
  } else {
    const cloud = el('div', { class: 'tag-cloud' });
    for (const [tag, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      cloud.appendChild(el('div', {
        class: 'tag-chip',
        style: { background: tagColor(tag) },
        onclick: () => { state.activeTag = tag; setView('bookmarks'); },
      }, [tag, el('span', { class: 'count' }, count)]));
    }
    body.appendChild(cloud);
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

// ===========================================================================
// DUPLICATES VIEW
// ===========================================================================
views.duplicates = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Duplicate Tabs'),
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const ok = await modalConfirm('Close duplicates?', 'This will keep the first instance of each duplicated URL.');
          if (!ok) return;
          const n = await send('CLOSE_DUPLICATES');
          toast(`Closed ${n} duplicates`, 'success');
          await refreshAll();
          render();
        },
      }, 'Close all duplicates'),
    ]),
  ]));

  const body = el('div', { class: 'panel-body' });
  if (state.duplicates.length === 0) {
    body.appendChild(emptyState('✓ No duplicate tabs detected', ''));
  } else {
    for (const group of state.duplicates) {
      const groupDiv = el('div', { style: { marginBottom: '12px' } });
      groupDiv.appendChild(el('div', { class: 'group-header' }, `${group.tabs.length}× ${getDomain(group.tabs[0].url)}`));
      for (const t of group.tabs) groupDiv.appendChild(tabRow(t));
      body.appendChild(groupDiv);
    }
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

// ===========================================================================
// BROKEN LINKS VIEW
// ===========================================================================
views.broken = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Broken Link Scanner'),
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: runScan,
      }, 'Scan all bookmarks'),
      el('button', {
        class: 'btn btn-danger',
        onclick: cleanBroken,
      }, 'Clean broken'),
    ]),
  ]));

  const body = el('div', { class: 'panel-body' });
  body.id = 'brokenBody';

  const broken = state.flatBookmarks
    .map((bm) => ({ bm, meta: state.bookmarkMeta[bm.id] || {} }))
    .filter(({ meta }) => meta.scanStatus === 'broken');

  if (state.scanProgress) {
    const pct = Math.round((state.scanProgress.done / state.scanProgress.total) * 100);
    body.appendChild(el('div', { style: { padding: '12px' } }, [
      el('div', { style: { fontSize: '12px', marginBottom: '6px' } }, `Scanning ${state.scanProgress.done}/${state.scanProgress.total}…`),
      el('div', { class: 'progress' }, [el('div', { class: 'progress-fill', style: { width: pct + '%' } })]),
    ]));
  } else if (broken.length === 0) {
    body.appendChild(emptyState('✓ All bookmarks are healthy', 'Run a scan to verify.'));
  } else {
    body.appendChild(el('div', { style: { padding: '8px 12px', fontSize: '11px', color: 'var(--text-dim)' } },
      `${broken.length} broken bookmark${broken.length === 1 ? '' : 's'}`));
    for (const { bm } of broken) body.appendChild(bookmarkRow(bm));
  }

  panel.appendChild(body);
  root.appendChild(panel);
};

async function runScan() {
  toast('Scanning bookmarks…', 'info');
  // Reset progress display; real updates come via setupScanProgressListener()
  state.scanProgress = { done: 0, total: state.flatBookmarks.length };
  render();
  try {
    await send('SCAN_BOOKMARKS');
    // Background sets scanProgress.running=false when done; listener handles the rest.
    toast('Scan complete', 'success');
  } catch (e) {
    state.scanProgress = null;
    toast('Scan failed: ' + e.message, 'error');
    render();
  }
}

async function cleanBroken() {
  const broken = state.flatBookmarks.filter((bm) => state.bookmarkMeta[bm.id]?.scanStatus === 'broken');
  if (broken.length === 0) { toast('Nothing to clean', 'info'); return; }
  const ok = await modalConfirm('Delete broken bookmarks?', `${broken.length} bookmark${broken.length === 1 ? '' : 's'} will be permanently removed.`);
  if (!ok) return;
  for (const bm of broken) {
    try { await send('DELETE_BOOKMARK', { id: bm.id }); } catch {}
  }
  toast(`Deleted ${broken.length} bookmarks`, 'success');
  await refreshAll();
  render();
}

// ===========================================================================
// IMPORT / EXPORT
// ===========================================================================
function exportBookmarks() {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];

  // Only export safe, navigable URLs — skip javascript:, data:, about:, etc.
  function isSafeExportUrl(url) {
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:' || protocol === 'ftp:';
    } catch { return false; }
  }

  function walk(nodes, depth = 1) {
    const indent = '  '.repeat(depth);
    for (const n of nodes) {
      if (n.url) {
        if (!isSafeExportUrl(n.url)) continue; // skip javascript: etc.
        lines.push(`${indent}<DT><A HREF="${escapeHtml(n.url)}">${escapeHtml(n.title || '')}</A>`);
      } else if (n.children) {
        lines.push(`${indent}<DT><H3>${escapeHtml(n.title || '')}</H3>`);
        lines.push(`${indent}<DL><p>`);
        walk(n.children, depth + 1);
        lines.push(`${indent}</DL><p>`);
      }
    }
  }
  walk(state.bookmarkTree);
  lines.push('</DL><p>');
  const blob = new Blob([lines.join('\n')], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabvault-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Bookmarks exported', 'success');
}

async function importBookmarks(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();

  // Guard: must be a Netscape bookmark export, not an arbitrary HTML page.
  // Importing a random HTML file would create a bookmark for every <a> tag on it.
  if (!text.includes('NETSCAPE-Bookmark-file')) {
    toast('Invalid file — please export bookmarks from your browser first', 'error');
    e.target.value = '';
    return;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/html');
  const links = doc.querySelectorAll('a');
  let folder;
  try {
    folder = await send('CREATE_BOOKMARK', { title: `Imported ${new Date().toLocaleDateString()}` });
  } catch (err) { toast('Import failed: ' + err.message, 'error'); return; }
  let count = 0;
  for (const a of links) {
    try {
      await send('CREATE_BOOKMARK', { parentId: folder.id, title: a.textContent || a.href, url: a.href });
      count++;
    } catch {}
  }
  toast(`Imported ${count} bookmarks`, 'success');
  await refreshAll();
  render();
}

// ===========================================================================
// UNIFIED SEARCH
// ===========================================================================
let fuseTabs, fuseBookmarks;
function buildFuseIndex() {
  if (typeof Fuse === 'undefined') {
    console.error('[TabVault] Fuse.js not loaded');
    return false;
  }
  fuseTabs = new Fuse(state.tabs, {
    keys: ['title', 'url'], threshold: 0.4, includeScore: true,
  });
  const bookmarkData = state.flatBookmarks.map((bm) => ({
    bm, title: bm.title, url: bm.url,
    tags: (state.bookmarkMeta[bm.id]?.tags || []).join(' '),
    note: state.bookmarkMeta[bm.id]?.note || '',
  }));
  fuseBookmarks = new Fuse(bookmarkData, {
    keys: ['title', 'url', 'tags', 'note'], threshold: 0.4, includeScore: true,
  });
  return true;
}

function setupSearch() {
  const input = $('#globalSearch');
  const handler = debounce((e) => {
    state.searchQuery = e.target.value.trim();
    if (state.searchQuery) renderSearch();
    else views[state.view]?.($('#main'));
  }, 200);
  input.addEventListener('input', handler);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; state.searchQuery = ''; views[state.view]?.($('#main')); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      handleSearchNav(e);
    }
  });
}

function handleSearchNav(e) {
  const rows = $$('#main .row');
  if (rows.length === 0) return;
  const current = rows.findIndex((r) => r.classList.contains('kbd-focus'));
  let next = current;
  if (e.key === 'ArrowDown') {
    // -1 (nothing focused) → 0 (first); otherwise advance, clamped to last
    next = current === -1 ? 0 : Math.min(rows.length - 1, current + 1);
  }
  if (e.key === 'ArrowUp') {
    // -1 (nothing focused) → last item; otherwise retreat, clamped to first
    next = current === -1 ? rows.length - 1 : Math.max(0, current - 1);
  }
  if (e.key === 'Enter' && current >= 0) { rows[current].click(); return; }
  rows.forEach((r) => r.classList.remove('kbd-focus'));
  if (next >= 0) {
    rows[next].classList.add('kbd-focus');
    rows[next].scrollIntoView({ block: 'nearest' });
  }
  e.preventDefault();
}

async function renderSearch() {
  const main = $('#main');
  const panel = el('div', { class: 'panel' });
  const body  = el('div', { class: 'panel-body' });

  if (!buildFuseIndex()) {
    body.appendChild(emptyState('Search unavailable', 'Fuse.js failed to load. Reload the extension.'));
    panel.appendChild(body); main.appendChild(panel);
    return;
  }

  const tabResults = fuseTabs.search(state.searchQuery).slice(0, 20);
  const bmResults  = fuseBookmarks.search(state.searchQuery).slice(0, 30);

  // Browser history — direct chrome.history API call (extension pages have access)
  let historyItems = [];
  try {
    historyItems = await chrome.history.search({
      text:      state.searchQuery,
      maxResults: 20,
      startTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    // Filter out URLs already shown as open tabs
    const openUrls = new Set(state.tabs.map((t) => t.url));
    historyItems = historyItems.filter((h) => !openUrls.has(h.url));
  } catch { historyItems = []; }

  if (!tabResults.length && !bmResults.length && !historyItems.length) {
    body.appendChild(emptyState('No results', `Nothing found for "${state.searchQuery}". Try different keywords.`));
  } else {
    if (tabResults.length) {
      body.appendChild(el('div', { class: 'search-section-header' }, `Open tabs  (${tabResults.length})`));
      for (const r of tabResults) body.appendChild(tabRow(r.item));
    }
    if (bmResults.length) {
      body.appendChild(el('div', { class: 'search-section-header' }, `Bookmarks  (${bmResults.length})`));
      for (const r of bmResults) body.appendChild(bookmarkRow(r.item.bm));
    }
    if (historyItems.length) {
      body.appendChild(el('div', { class: 'search-section-header' }, `History  (${historyItems.length})`));
      for (const h of historyItems) {
        const row = el('div', { class: 'row history-row' });
        const fav = el('img', { class: 'fav', src: `https://www.google.com/s2/favicons?domain=${getDomain(h.url)}&sz=32`, alt: '' });
        fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
        row.appendChild(fav);
        row.appendChild(el('div', { class: 'meta' }, [
          el('div', { class: 'title' }, h.title || h.url),
          el('div', { class: 'sub' }, getDomain(h.url)),
        ]));
        row.appendChild(el('span', { class: 'history-badge' }, 'history'));
        row.addEventListener('click', () => chrome.tabs.create({ url: h.url }));
        body.appendChild(row);
      }
    }
  }
  panel.appendChild(body);
  main.appendChild(panel);
}

// ===========================================================================
// HELPERS
// ===========================================================================
function emptyState(title, desc) {
  return el('div', { class: 'empty-state' }, [
    iconSvg('M12 2v20M2 12h20', 40),
    el('h3', {}, title),
    desc ? el('p', {}, desc) : null,
  ].filter(Boolean));
}

function iconSvg(d, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

// ===========================================================================
// READING LIST VIEW
// ===========================================================================
views.reading = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, `Reading List (${state.readingList.length})`),
    el('div', { class: 'panel-actions' }, [
      state.readingList.length > 0 ? el('button', {
        class: 'btn btn-ghost',
        onclick: async () => {
          const ok = await modalConfirm('Clear reading list?', 'All saved items will be removed.');
          if (!ok) return;
          await send('CLEAR_READING_LIST');
          await refreshAll(); render();
        },
      }, 'Clear all') : null,
    ].filter(Boolean)),
  ]));

  const body = el('div', { class: 'panel-body' });
  if (state.readingList.length === 0) {
    body.appendChild(emptyState('Reading list is empty',
      'Right-click any page and choose "Save to Reading List", or use the button in the tab row.'));
  } else {
    for (const item of state.readingList) {
      const card = el('div', { class: 'reading-card' });
      const fav  = el('img', { class: 'fav', src: item.favIconUrl || `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`, alt: '' });
      fav.onerror = () => { fav.src = defaultFaviconDataUri(); };

      card.appendChild(el('div', { class: 'reading-main' }, [
        fav,
        el('div', { class: 'meta' }, [
          el('div', { class: 'title' }, item.title || item.url),
          el('div', { class: 'sub' }, getDomain(item.url)),
          el('div', { class: 'reading-age' }, 'Saved ' + formatDate(item.savedAt)),
        ]),
      ]));

      card.appendChild(el('div', { class: 'reading-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            await chrome.tabs.create({ url: item.url });
            // Auto-remove after opening
            await send('REMOVE_FROM_READING_LIST', { id: item.id });
            await refreshAll(); render();
          },
        }, 'Read now'),
        el('button', {
          class: 'btn btn-ghost',
          onclick: async (e) => {
            e.stopPropagation();
            await send('REMOVE_FROM_READING_LIST', { id: item.id });
            await refreshAll(); render();
          },
        }, 'Remove'),
      ]));

      body.appendChild(card);
    }
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

// ===========================================================================
// WORKSPACES VIEW
// ===========================================================================
const WS_COLORS = ['blue','green','purple','red','orange','pink','cyan','amber'];

views.workspaces = function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Workspaces'),
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const name = await modalPrompt('Workspace name', 'My Workspace');
          if (!name) return;
          await send('CREATE_WORKSPACE', { name, color: WS_COLORS[state.workspaces.length % WS_COLORS.length] });
          toast(`Workspace "${name}" created`, 'success');
          await refreshAll(); render();
        },
      }, '+ New workspace'),
    ]),
  ]));

  const body = el('div', { class: 'panel-body' });
  if (state.workspaces.length === 0) {
    body.appendChild(emptyState('No workspaces yet',
      'Create a workspace to snapshot your current tabs and launch them as a set anytime.'));
  } else {
    for (const ws of state.workspaces) {
      const card = el('div', { class: 'ws-card' });

      const head = el('div', { class: 'ws-head' }, [
        el('div', { class: `ws-dot group-${ws.color}` }),
        el('div', { class: 'ws-info' }, [
          el('div', { class: 'ws-name' }, ws.name),
          el('div', { class: 'ws-meta' }, `${ws.tabs.length} tabs · Last used ${formatDate(ws.lastUsed)}`),
        ]),
      ]);
      card.appendChild(head);

      // Favicon row preview
      if (ws.tabs.length > 0) {
        const favs = el('div', { class: 'ws-favicons' });
        ws.tabs.slice(0, 10).forEach((t) => {
          const img = el('img', { src: t.favIconUrl || `https://www.google.com/s2/favicons?domain=${getDomain(t.url)}&sz=32`, alt: '', title: t.title });
          img.onerror = () => { img.src = defaultFaviconDataUri(); };
          favs.appendChild(img);
        });
        if (ws.tabs.length > 10) favs.appendChild(el('span', { class: 'ws-more' }, `+${ws.tabs.length - 10}`));
        card.appendChild(favs);
      }

      card.appendChild(el('div', { class: 'ws-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          title: 'Open all workspace tabs in a new window',
          onclick: async () => {
            await send('LAUNCH_WORKSPACE', { id: ws.id });
            toast(`Launched "${ws.name}"`, 'success');
          },
        }, 'Launch'),
        el('button', {
          class: 'btn',
          title: 'Update workspace with current open tabs',
          onclick: async () => {
            await send('SAVE_TABS_TO_WORKSPACE', { id: ws.id });
            toast('Workspace updated with current tabs', 'success');
            await refreshAll(); render();
          },
        }, 'Update'),
        el('button', {
          class: 'btn btn-ghost btn-danger',
          onclick: async () => {
            const ok = await modalConfirm('Delete workspace?', `"${ws.name}" will be permanently removed.`);
            if (!ok) return;
            await send('DELETE_WORKSPACE', { id: ws.id });
            toast('Workspace deleted', 'success');
            await refreshAll(); render();
          },
        }, 'Delete'),
      ]));

      body.appendChild(card);
    }
  }
  panel.appendChild(body);
  root.appendChild(panel);
};

// ===========================================================================
// INSIGHTS VIEW
// ===========================================================================
views.insights = async function (root) {
  const panel = el('div', { class: 'panel' });
  panel.appendChild(el('div', { class: 'panel-header' }, [
    el('h2', {}, 'Tab Insights'),
    el('div', { class: 'panel-actions' }, [
      el('button', {
        class: 'btn',
        onclick: async () => { state.analytics = null; await refreshInsights(root, panel); },
      }, 'Refresh'),
    ]),
  ]));

  const body = el('div', { class: 'panel-body' }); body.id = 'insightsBody';
  panel.appendChild(body);
  root.appendChild(panel);

  await refreshInsights(root, panel, body);
};

async function refreshInsights(root, panel, body) {
  const b = body || document.getElementById('insightsBody');
  if (!b) return;
  b.innerHTML = '';

  const data = await send('GET_TAB_ANALYTICS');
  if (!data) { b.appendChild(emptyState('Could not load analytics', '')); return; }

  const { total, zombies, ageBreakdown, topDomains } = data;

  // ── Summary cards ───────────────────────────────────────────
  const cards = el('div', { class: 'insights-cards' });
  [
    { val: total, lbl: 'Total tabs' },
    { val: ageBreakdown.today, lbl: 'Active today', cls: 'fresh' },
    { val: ageBreakdown.week,  lbl: 'This week',    cls: 'old'   },
    { val: zombies.length,     lbl: 'Zombies',       cls: zombies.length > 0 ? 'stale' : '' },
  ].forEach(({ val, lbl, cls }) => {
    cards.appendChild(el('div', { class: `insights-card ${cls || ''}` }, [
      el('div', { class: 'insights-val' }, String(val)),
      el('div', { class: 'insights-lbl' }, lbl),
    ]));
  });
  b.appendChild(cards);

  // ── Age distribution bar ────────────────────────────────────
  if (total > 0) {
    b.appendChild(el('div', { class: 'insights-section-title' }, 'Age distribution'));
    const barWrap = el('div', { class: 'age-bar-wrap' });
    [
      { val: ageBreakdown.today, cls: 'fresh', lbl: 'Today' },
      { val: ageBreakdown.week,  cls: 'old',   lbl: 'This week' },
      { val: ageBreakdown.older, cls: 'stale', lbl: 'Older' },
      { val: ageBreakdown.unknown, cls: 'unk', lbl: 'Unknown' },
    ].forEach(({ val, cls, lbl }) => {
      if (!val) return;
      const pct = Math.round((val / total) * 100);
      barWrap.appendChild(el('div', {
        class: `age-segment ${cls}`,
        style: { width: pct + '%' },
        title: `${lbl}: ${val} tab${val === 1 ? '' : 's'} (${pct}%)`,
      }));
    });
    b.appendChild(barWrap);
    const legend = el('div', { class: 'age-legend' });
    [
      { cls: 'fresh', lbl: `Today (${ageBreakdown.today})` },
      { cls: 'old',   lbl: `This week (${ageBreakdown.week})` },
      { cls: 'stale', lbl: `Older (${ageBreakdown.older})` },
    ].forEach(({ cls, lbl }) => {
      legend.appendChild(el('span', { class: 'age-legend-item' }, [
        el('span', { class: `age-legend-dot ${cls}` }),
        lbl,
      ]));
    });
    b.appendChild(legend);
  }

  // ── Top domains ─────────────────────────────────────────────
  if (topDomains.length > 0) {
    b.appendChild(el('div', { class: 'insights-section-title' }, 'Most open domains'));
    const domList = el('div', { class: 'domain-list' });
    const maxCount = topDomains[0].count;
    for (const { domain, count } of topDomains) {
      const pct = Math.round((count / maxCount) * 100);
      const row = el('div', { class: 'domain-row' }, [
        el('span', { class: 'domain-name' }, domain),
        el('div', { class: 'domain-bar-bg' }, [
          el('div', { class: 'domain-bar-fill', style: { width: pct + '%' } }),
        ]),
        el('span', { class: 'domain-count' }, String(count)),
        el('button', {
          class: 'btn btn-icon btn-ghost close-domain-btn',
          title: `Close all ${count} ${domain} tab${count === 1 ? '' : 's'}`,
          onclick: async () => {
            const n = await send('CLOSE_TABS_BY_DOMAIN', { domain });
            toast(`Closed ${n} ${domain} tab${n === 1 ? '' : 's'}`, 'success');
            await refreshAll(); render();
          },
        }, '✕'),
      ]);
      domList.appendChild(row);
    }
    b.appendChild(domList);
  }

  // ── Zombie tabs ─────────────────────────────────────────────
  if (zombies.length > 0) {
    b.appendChild(el('div', { class: 'insights-section-title' }, [
      `Zombie tabs (${zombies.length})`,
      el('button', {
        class: 'btn btn-ghost',
        style: { fontSize: '11px', marginLeft: '8px' },
        title: 'Close all zombie tabs',
        onclick: async () => {
          const ok = await modalConfirm('Close all zombie tabs?', `${zombies.length} tab${zombies.length === 1 ? '' : 's'} untouched for 7+ days will be closed.`);
          if (!ok) return;
          for (const z of zombies) { try { await send('CLOSE_TAB', { tabId: z.id }); } catch {} }
          toast(`Closed ${zombies.length} zombie tab${zombies.length === 1 ? '' : 's'}`, 'success');
          await refreshAll(); render();
        },
      }, 'Close all'),
    ]));
    for (const z of zombies) {
      const row = el('div', { class: 'row zombie-row' });
      const fav = el('img', { class: 'fav', src: z.favIconUrl || defaultFaviconDataUri(), alt: '' });
      fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
      row.appendChild(fav);
      row.appendChild(el('div', { class: 'meta' }, [
        el('div', { class: 'title' }, z.title || z.url),
        el('div', { class: 'sub' }, `Last visited ${formatDate(z.lastActivity)}`),
      ]));
      row.appendChild(el('button', {
        class: 'btn btn-icon btn-ghost', title: 'Close tab',
        onclick: async (e) => {
          e.stopPropagation();
          await send('CLOSE_TAB', { tabId: z.id });
          await refreshAll(); render();
        },
      }, '✕'));
      row.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;
        await send('SWITCH_TAB', { tabId: z.id });
      });
      b.appendChild(row);
    }
  }
}

// ===========================================================================
// SMART AUTO-GROUPING (AI)
// ===========================================================================
async function runSmartGrouping() {
  const btn = document.getElementById('smartGroupBtn');
  if (btn) { btn.textContent = 'Analyzing…'; btn.disabled = true; }

  try {
    const result = await send('GET_AI_GROUP_SUGGESTIONS');

    if (result.error === 'no_key') {
      showNoApiKeyModal();
      return;
    }
    if (result.error) {
      toast('AI error: ' + result.error, 'error');
      return;
    }
    if (!result.suggestions?.length) {
      toast('No clear groupings found — try having more related tabs open', 'info');
      return;
    }
    showAiGroupModal(result.suggestions);
  } catch (e) {
    toast('Smart grouping failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'Smart Group'; btn.disabled = false; }
  }
}

function showNoApiKeyModal() {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Anthropic API key required'),
    el('p', { style: 'color:var(--text-dim);font-size:12px;margin-top:6px;line-height:1.6' },
      'Smart Auto-Grouping uses Claude AI to analyse your tabs. Add your API key in Settings to get started.'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: () => { backdrop.remove(); chrome.runtime.openOptionsPage(); },
      }, 'Open Settings'),
    ]),
  ]);
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

function showAiGroupModal(suggestions) {
  const backdrop = el('div', { class: 'modal-backdrop' });

  // Track which suggestions are selected (all on by default)
  const selected = new Set(suggestions.map((_, i) => i));

  const buildModal = () => {
    backdrop.innerHTML = '';
    const modal = el('div', { class: 'modal ai-group-modal' });
    modal.appendChild(el('h3', {}, 'Smart grouping suggestions'));
    modal.appendChild(el('p', { style: 'font-size:12px;color:var(--text-dim);margin:4px 0 14px' },
      `Claude found ${suggestions.length} group${suggestions.length === 1 ? '' : 's'}. Select which to apply.`));

    const list = el('div', { class: 'ai-group-list' });
    suggestions.forEach((s, i) => {
      const isOn = selected.has(i);
      const card = el('div', {
        class: 'ai-group-card' + (isOn ? ' selected' : ''),
        onclick: () => {
          if (selected.has(i)) selected.delete(i); else selected.add(i);
          buildModal();
        },
      }, [
        el('div', { class: 'ai-group-card-head' }, [
          el('span', { class: `ai-group-check ${isOn ? 'on' : ''}` }, isOn ? '✓' : ''),
          el('span', { class: `group-dot group-${s.color}`, style: 'width:10px;height:10px;border-radius:50%;flex-shrink:0' }),
          el('span', { class: 'ai-group-name' }, s.name),
          el('span', { class: 'ai-group-count' }, `${s.tabs.length} tabs`),
        ]),
        el('div', { class: 'ai-group-tabs' },
          s.tabs.map((t) => {
            const row = el('div', { class: 'ai-tab-row' });
            const fav = el('img', { src: t.favIconUrl || defaultFaviconDataUri(), alt: '', class: 'fav' });
            fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
            row.appendChild(fav);
            row.appendChild(el('span', { class: 'ai-tab-title' }, t.title || t.url));
            return row;
          })
        ),
      ]);
      list.appendChild(card);
    });
    modal.appendChild(list);

    const count = selected.size;
    modal.appendChild(el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn', onclick: () => backdrop.remove() }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        disabled: count === 0,
        onclick: async () => {
          backdrop.remove();
          let applied = 0;
          for (const i of selected) {
            const s = suggestions[i];
            const res = await send('APPLY_AI_GROUP', { name: s.name, color: s.color, tabIds: s.tabIds });
            if (res !== null) applied++;
          }
          toast(`Applied ${applied} group${applied === 1 ? '' : 's'}`, 'success');
          await refreshAll(); render();
        },
      }, count === 0 ? 'Select groups to apply' : `Apply ${count} group${count === 1 ? '' : 's'}`),
    ]));

    backdrop.appendChild(modal);
  };

  buildModal();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

init();