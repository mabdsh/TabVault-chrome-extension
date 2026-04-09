// popup.js — TabVault popup with sub-tabs (Tabs / Sessions / Bookmarks)
import {
  send, $, $$, el, debounce, getDomain, favicon, defaultFaviconDataUri,
  formatDate, formatAge, ageClass, toast, modalPrompt, modalConfirm, flatten,
} from '../shared/common.js';

const state = {
  view: 'tabs',
  searchQuery: '',
  tabs: [],
  groups: [],
  sessions: [],
  bookmarkTree: [],
  flatBookmarks: [],
  duplicates: [],
  bookmarkPath: [],
  recentTabs: [],
  lockedUrls: new Set(),
  readingList: [],
  currentWindowId: null,
};

// ---------- Init ----------
async function init() {
  await loadAll();
  setView('tabs');
  attachListeners();
}

async function loadAll() {
  try {
    const [tabsData, sessions, tree, dups, recent, locked, reading, currentTab] = await Promise.all([
      send('GET_ALL_TABS'),
      send('GET_ALL_SESSIONS'),
      send('GET_BOOKMARK_TREE'),
      send('FIND_DUPLICATES'),
      send('GET_RECENT_TABS'),
      send('GET_LOCKED_URLS'),
      send('GET_READING_LIST'),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    state.tabs          = tabsData?.tabs    || [];
    state.groups        = tabsData?.groups  || [];
    state.sessions      = sessions  || [];
    state.bookmarkTree  = tree       || [];
    state.flatBookmarks = [];
    flatten(state.bookmarkTree, state.flatBookmarks);
    state.duplicates    = dups    || [];
    state.recentTabs    = recent  || [];
    state.lockedUrls    = new Set(locked || []);
    state.readingList   = reading || [];
    state.currentWindowId = currentTab?.[0]?.windowId ?? null;
    updateCounts();
  } catch (e) {
    console.error('[TabVault popup] load failed:', e);
    toast('Failed to load', 'error');
  }
}

function updateCounts() {
  $('#pillTabs').textContent     = state.tabs.length;
  $('#pillSessions').textContent = state.sessions.length;
  const dupTotal = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);
  const badge = $('#dupBadge');
  if (dupTotal > 0) { badge.hidden = false; badge.textContent = dupTotal; }
  else badge.hidden = true;
  const readBadge = $('#pillReading');
  if (readBadge) {
    if (state.readingList.length > 0) { readBadge.hidden = false; readBadge.textContent = state.readingList.length; }
    else readBadge.hidden = true;
  }
  renderFooter();
}

function renderFooter() {
  const footer = $('#popupFooter');
  const sleeping = state.tabs.filter((t) => t.url?.includes('suspended.html')).length;
  const dupes    = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);

  const stats = [
    {
      icon: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M8 6V4M16 6V4"/>',
      val: state.tabs.length,
      lbl: 'tabs',
    },
    {
      icon: '<path d="M18 8h1a4 4 0 010 8h-1"/><path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/>',
      val: sleeping,
      lbl: 'sleeping',
    },
    {
      icon: '<path d="M21 12a9 9 0 11-3-6.7"/><path d="M21 4v5h-5"/>',
      val: state.sessions.length,
      lbl: 'sessions',
    },
    {
      icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
      val: dupes,
      lbl: 'dupes',
    },
  ];

  footer.innerHTML = '';
  for (const s of stats) {
    const stat = el('div', { class: 'footer-stat' }, [
      (() => {
        const ns  = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.innerHTML = s.icon;
        return svg;
      })(),
      el('div', {}, [
        el('div', { class: 'footer-stat-val' }, String(s.val)),
        el('div', { class: 'footer-stat-lbl' }, s.lbl),
      ]),
    ]);
    footer.appendChild(stat);
  }
}

// ---------- View routing ----------
function setView(view) {
  state.view = view;
  $$('.nav-pill').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (state.searchQuery) renderSearch();
  else render();
}

// Produces readable, locale-safe names. Example: "Apr 9 at 10:45 AM"
function sessionDefaultName() {
  const d = new Date();
  const date = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  return `${date} at ${time}`;
}

function render() {
  const body = $('#popupBody');
  body.innerHTML = '';
  try {
    if (state.view === 'tabs')           renderTabs(body);
    else if (state.view === 'sessions')  renderSessions(body);
    else if (state.view === 'bookmarks') renderBookmarks(body);
    else if (state.view === 'reading')   renderReadingList(body);
  } catch (err) {
    console.error('[TabVault popup] render error:', err);
    body.appendChild(el('div', { class: 'popup-empty' }, [
      el('strong', {}, 'Something went wrong'),
      el('p', {}, 'Try closing and reopening the popup. If the problem persists, reload the extension from chrome://extensions.'),
    ]));
  }
}

// ---------- TABS view ----------
function renderTabs(body) {
  if (state.tabs.length === 0) {
    body.appendChild(emptyState('No tabs open'));
    return;
  }
  const pinned = state.tabs.filter((t) => t.pinned);
  const ungrouped = state.tabs.filter((t) => !t.pinned && (t.groupId === -1 || t.groupId == null));
  const grouped = new Map();
  for (const t of state.tabs) {
    if (t.pinned) continue;
    if (t.groupId !== -1 && t.groupId != null) {
      if (!grouped.has(t.groupId)) grouped.set(t.groupId, []);
      grouped.get(t.groupId).push(t);
    }
  }

  if (pinned.length) {
    body.appendChild(el('div', { class: 'group-header' }, 'Pinned'));
    for (const t of pinned) body.appendChild(tabRow(t));
  }
  for (const group of state.groups) {
    const tabs = grouped.get(group.id);
    if (!tabs) continue;
    body.appendChild(el('div', { class: 'group-header' }, [
      el('span', { class: `group-dot group-${group.color}` }),
      group.title || '(group)',
    ]));
    for (const t of tabs) body.appendChild(tabRow(t));
  }
  if (ungrouped.length) {
    if (pinned.length || grouped.size) {
      body.appendChild(el('div', { class: 'group-header' }, 'Other'));
    }
    for (const t of ungrouped) body.appendChild(tabRow(t));
  }

  // Recently closed section
  if (state.recentTabs.length > 0) {
    body.appendChild(renderRecentlyClosed());
  }
}

function tabRow(tab) {
  const isSuspended = tab.url?.includes('suspended.html');
  const isLocked  = tab._locked || state.lockedUrls.has(tab.url);
  const isPlaying = tab.audible && !tab.mutedInfo?.muted;
  const isMuted   = !!tab.mutedInfo?.muted;
  const age       = formatAge(tab._lastActivity);
  const ageCls    = ageClass(tab._lastActivity);

  const row = el('div', {
    class: [
      'row',
      tab.active  ? 'active'    : '',
      isSuspended ? 'suspended' : '',
      tab.pinned  ? 'pinned'    : '',
      isLocked    ? 'is-locked' : '',
      isPlaying   ? 'is-playing': '',
    ].filter(Boolean).join(' '),
    'data-tab-id': tab.id,
  });

  // Favicon + audio dot
  const favWrap = el('div', { class: 'fav-wrap' });
  const fav = el('img', { class: 'fav', src: tab.favIconUrl || favicon(tab.url), alt: '' });
  fav.addEventListener('error', () => { fav.src = defaultFaviconDataUri(); });
  favWrap.appendChild(fav);
  if (isPlaying || isMuted) {
    favWrap.appendChild(el('span', { class: 'audio-dot' + (isMuted ? ' muted' : '') }));
  }
  row.appendChild(favWrap);

  row.appendChild(el('div', { class: 'meta' }, [
    el('div', { class: 'title' }, tab.title || '(untitled)'),
    el('div', { class: 'sub' }, getDomain(tab.url)),
  ]));

  if (age) row.appendChild(el('span', { class: `age-badge ${ageCls}` }, age));
  if (isLocked) row.appendChild(el('span', { class: 'lock-indicator', title: 'Tab is locked' }, '🔒'));

  const actions = el('div', { class: 'actions' });
  const pinBtn = el('button', {
    title: tab.pinned ? 'Unpin' : 'Pin',
    'aria-label': tab.pinned ? 'Unpin tab' : 'Pin tab',
    onclick: async (e) => {
      e.stopPropagation();
      await send('PIN_TAB', { tabId: tab.id, pinned: !tab.pinned });
      await loadAll(); render();
    },
  }, tab.pinned ? '📍' : '📌');

  const suspendBtn = el('button', {
    title: 'Suspend',
    'aria-label': 'Suspend tab',
    onclick: async (e) => {
      e.stopPropagation();
      await send('SUSPEND_TAB', { tabId: tab.id });
      await loadAll(); render();
    },
  }, '💤');

  actions.append(pinBtn, suspendBtn);

  if (isPlaying || isMuted) {
    const muteBtn = el('button', {
      title: isMuted ? 'Unmute' : 'Mute',
      'aria-label': isMuted ? 'Unmute tab' : 'Mute tab',
      onclick: async (e) => {
        e.stopPropagation();
        await send('TOGGLE_MUTE_TAB', { tabId: tab.id, muted: !isMuted });
        await loadAll(); render();
      },
    }, isMuted ? '🔈' : '🔊');
    actions.appendChild(muteBtn);
  }

  if (!isLocked) {
    const closeBtn = el('button', {
      class: 'btn-close',
      title: 'Close',
      'aria-label': `Close tab: ${tab.title || 'untitled'}`,
      onclick: async (e) => {
        e.stopPropagation();
        await send('CLOSE_TAB', { tabId: tab.id });
        await loadAll(); render();
      },
    }, '✕');
    actions.appendChild(closeBtn);
  }

  row.appendChild(actions);

  row.addEventListener('click', async () => {
    await send('SWITCH_TAB', { tabId: tab.id });
    window.close();
  });

  return row;
}

function renderRecentlyClosed() {
  const wrap = el('div', { class: 'recent-section' });
  wrap.appendChild(el('div', { class: 'section-title' }, [
    'Recently closed',
    el('span', { style: { background: 'var(--bg-elev-3)', borderRadius: '99px', padding: '1px 7px', fontSize: '10px' } },
      String(state.recentTabs.length)),
  ]));
  for (const t of state.recentTabs.slice(0, 8)) {
    const age = formatAge(t.closedAt);
    const row = el('div', { class: 'row recent-row' });
    const fav = el('img', { class: 'fav', src: t.favIconUrl || favicon(t.url), alt: '' });
    fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
    row.appendChild(fav);
    row.appendChild(el('div', { class: 'meta' }, [
      el('div', { class: 'title' }, t.title || t.url),
      el('div', { class: 'sub' }, getDomain(t.url)),
    ]));
    if (age) row.appendChild(el('span', { class: 'recent-age' }, age));
    row.addEventListener('click', async () => {
      await send('RESTORE_RECENT_TAB', { sessionId: t.sessionId, url: t.url });
      await loadAll(); render();
    });
    wrap.appendChild(row);
  }
  return wrap;
}

// ---------- SESSIONS view ----------
function renderSessions(body) {
  body.appendChild(el('div', { class: 'section-title' }, [
    `Saved sessions (${state.sessions.length})`,
    el('button', {
      onclick: async () => {
        const name = await modalPrompt('Session name', sessionDefaultName());
        if (!name) return;
        await send('SAVE_SESSION', { name, tags: [] });
        toast('Session saved', 'success');
        await loadAll();
        render();
      },
    }, '+ Save current'),
  ]));

  if (state.sessions.length === 0) {
    body.appendChild(emptyState('No sessions yet', 'Click "+ Save current" to create one'));
    return;
  }

  for (const s of state.sessions) {
    const card = el('div', { class: 'session-mini' });
    card.appendChild(el('div', { class: 'session-mini-name' }, [
      s.name,
      el('span', { style: { fontSize: '10px', color: 'var(--text-faint)', fontWeight: '400' } }, formatDate(s.createdAt)),
    ]));
    card.appendChild(el('div', { class: 'session-mini-meta' }, `${s.tabs.length} tabs`));
    const favs = el('div', { class: 'session-mini-favs' });
    for (const t of s.tabs.slice(0, 8)) {
      const img = el('img', { src: t.favIconUrl || favicon(t.url), alt: '', title: t.title });
      img.addEventListener('error', () => { img.src = defaultFaviconDataUri(); });
      favs.appendChild(img);
    }
    card.appendChild(favs);
    card.appendChild(el('div', { class: 'session-mini-actions' }, [
      el('button', {
        onclick: async (e) => {
          e.stopPropagation();
          await send('RESTORE_SESSION', { id: s.id, mode: 'new' });
          toast('Restored in new window', 'success');
          window.close();
        },
      }, 'Restore'),
      el('button', {
        onclick: async (e) => {
          e.stopPropagation();
          await send('RESTORE_SESSION', { id: s.id, mode: 'merge' });
          toast('Merged', 'success');
          window.close();
        },
      }, 'Merge'),
      el('button', {
        class: 'danger',
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await modalConfirm('Delete session?', `Delete "${s.name}"?`);
          if (!ok) return;
          await send('DELETE_SESSION', { id: s.id });
          await loadAll();
          render();
        },
      }, 'Delete'),
    ]));
    body.appendChild(card);
  }
}

// ---------- BOOKMARKS view ----------
function renderBookmarks(body) {
  // Navigate the tree by path. Empty path = root.
  let current = { children: state.bookmarkTree[0]?.children || [] };
  for (const id of state.bookmarkPath) {
    const next = current.children?.find((c) => c.id === id);
    if (next) current = next;
  }

  // Breadcrumbs
  const crumbs = el('div', { class: 'section-title' });
  const homeBtn = el('button', {
    onclick: () => { state.bookmarkPath = []; render(); },
  }, '🏠 Bookmarks');
  crumbs.appendChild(homeBtn);
  body.appendChild(crumbs);

  if (state.bookmarkPath.length > 0) {
    const back = el('div', { class: 'row', onclick: () => { state.bookmarkPath.pop(); render(); } }, [
      el('span', { class: 'fav', style: { display: 'grid', placeItems: 'center', fontSize: '11px' } }, '←'),
      el('div', { class: 'meta' }, [el('div', { class: 'title' }, '.. (back)')]),
    ]);
    body.appendChild(back);
  }

  const children = current.children || [];
  if (children.length === 0) {
    body.appendChild(emptyState('Empty folder'));
    return;
  }

  // Folders first
  for (const c of children) {
    if (c.children) body.appendChild(folderRow(c));
  }
  for (const c of children) {
    if (c.url) body.appendChild(bookmarkRow(c));
  }
}

function folderRow(folder) {
  return el('div', {
    class: 'row',
    onclick: () => { state.bookmarkPath.push(folder.id); render(); },
  }, [
    el('span', { class: 'fav', style: { display: 'grid', placeItems: 'center', fontSize: '12px' } }, '📁'),
    el('div', { class: 'meta' }, [
      el('div', { class: 'title' }, folder.title || '(untitled)'),
      el('div', { class: 'sub' }, `${folder.children.length} items`),
    ]),
  ]);
}

function bookmarkRow(bm) {
  const row = el('div', { class: 'row' });
  const fav = el('img', { class: 'fav', src: favicon(bm.url), alt: '' });
  fav.addEventListener('error', () => { fav.src = defaultFaviconDataUri(); });
  row.appendChild(fav);
  row.appendChild(el('div', { class: 'meta' }, [
    el('div', { class: 'title' }, bm.title || bm.url),
    el('div', { class: 'sub' }, getDomain(bm.url)),
  ]));
  const actions = el('div', { class: 'actions' });
  actions.append(
    el('button', {
      title: 'Copy link',
      'aria-label': 'Copy link',
      onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(bm.url); toast('Copied', 'success'); },
    }, '📋'),
    el('button', {
      class: 'danger',
      title: 'Delete',
      'aria-label': `Delete bookmark: ${bm.title || bm.url}`,
      onclick: async (e) => {
        e.stopPropagation();
        const ok = await modalConfirm('Delete bookmark?', bm.title);
        if (!ok) return;
        await send('DELETE_BOOKMARK', { id: bm.id });
        await loadAll();
        render();
      },
    }, '🗑'),
  );
  row.appendChild(actions);
  // Open in new tab — non-destructive
  row.addEventListener('click', async () => {
    await send('OPEN_URL', { url: bm.url });
    window.close();
  });
  return row;
}

// ---------- SEARCH ----------
async function renderSearch() {
  const body = $('#popupBody');
  body.innerHTML = '';
  if (typeof Fuse === 'undefined') {
    body.appendChild(emptyState('Search unavailable', 'Fuse.js failed to load'));
    return;
  }
  const fuseTabs = new Fuse(state.tabs, { keys: ['title', 'url'], threshold: 0.4 });
  const fuseBm   = new Fuse(state.flatBookmarks, { keys: ['title', 'url'], threshold: 0.4 });
  const tabResults = fuseTabs.search(state.searchQuery).slice(0, 8);
  const bmResults  = fuseBm.search(state.searchQuery).slice(0, 10);

  // History results — direct chrome.history API (extension page has access)
  let historyItems = [];
  try {
    const raw = await chrome.history.search({
      text: state.searchQuery, maxResults: 10,
      startTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    const openUrls = new Set(state.tabs.map((t) => t.url));
    historyItems = raw.filter((h) => !openUrls.has(h.url));
  } catch {}

  if (!tabResults.length && !bmResults.length && !historyItems.length) {
    body.appendChild(emptyState('No results', `Nothing found for "${state.searchQuery}"`));
    return;
  }
  if (tabResults.length) {
    body.appendChild(el('div', { class: 'section-title' }, `Open tabs (${tabResults.length})`));
    for (const r of tabResults) body.appendChild(tabRow(r.item));
  }
  if (bmResults.length) {
    body.appendChild(el('div', { class: 'section-title' }, `Bookmarks (${bmResults.length})`));
    for (const r of bmResults) body.appendChild(bookmarkRow(r.item));
  }
  if (historyItems.length) {
    body.appendChild(el('div', { class: 'section-title' }, `History (${historyItems.length})`));
    for (const h of historyItems) {
      const row = el('div', { class: 'row' });
      const fav = el('img', { class: 'fav', src: `https://www.google.com/s2/favicons?domain=${getDomain(h.url)}&sz=32`, alt: '' });
      fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
      row.appendChild(fav);
      row.appendChild(el('div', { class: 'meta' }, [
        el('div', { class: 'title' }, h.title || h.url),
        el('div', { class: 'sub' }, getDomain(h.url)),
      ]));
      row.appendChild(el('span', { class: 'history-pill' }, 'history'));
      row.addEventListener('click', async () => { await chrome.tabs.create({ url: h.url }); window.close(); });
      body.appendChild(row);
    }
  }
}

// ---------- READING LIST view ----------
function renderReadingList(body) {
  if (state.readingList.length === 0) {
    body.appendChild(emptyState('Reading list is empty', 'Right-click any page or use the book icon in a tab row'));
    return;
  }
  body.appendChild(el('div', { class: 'section-title' }, [
    `Saved to read (${state.readingList.length})`,
    el('button', {
      onclick: async () => {
        await send('CLEAR_READING_LIST');
        toast('Reading list cleared', 'success');
        await loadAll(); render();
      },
    }, 'Clear all'),
  ]));
  for (const item of state.readingList) {
    const card = el('div', { class: 'reading-card-mini' });
    const fav = el('img', {
      class: 'fav',
      src: item.favIconUrl || `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`,
      alt: '',
    });
    fav.onerror = () => { fav.src = defaultFaviconDataUri(); };
    card.appendChild(fav);
    card.appendChild(el('div', { class: 'meta' }, [
      el('div', { class: 'title' }, item.title || item.url),
      el('div', { class: 'sub' }, getDomain(item.url)),
    ]));
    const actions = el('div', { class: 'actions' });
    actions.appendChild(el('button', {
      title: 'Remove from list',
      'aria-label': `Remove from reading list: ${item.title || item.url}`,
      class: 'danger',
      onclick: async (e) => {
        e.stopPropagation();
        await send('REMOVE_FROM_READING_LIST', { id: item.id });
        await loadAll(); render();
      },
    }, '✕'));
    card.appendChild(actions);
    card.addEventListener('click', async () => {
      // Open the page without auto-removing — the user may want to come back
      // to it. They can remove it explicitly with the ✕ button, or mark it
      // read via the dedicated action below.
      await chrome.tabs.create({ url: item.url });
      window.close();
    });
    body.appendChild(card);
  }
}

// ---------- Helpers ----------
function emptyState(title, desc) {
  return el('div', { class: 'popup-empty' }, [
    el('div', { style: { fontSize: '24px' } }, '∅'),
    el('strong', {}, title),
    desc ? el('p', {}, desc) : null,
  ].filter(Boolean));
}

// ---------- Listeners ----------
function attachListeners() {
  // Sub-tab nav
  $$('.nav-pill').forEach((p) => p.addEventListener('click', () => {
    state.bookmarkPath = []; // reset bookmark path on nav change
    setView(p.dataset.view);
  }));

  // Search
  $('#popupSearch').addEventListener('input', debounce(async (e) => {
    state.searchQuery = e.target.value.trim();
    if (state.searchQuery) await renderSearch();
    else render();
  }, 200));
  $('#popupSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.searchQuery = ''; render(); }
  });

  // Quick actions
  $('#saveSessionBtn').addEventListener('click', async () => {
    const name = await modalPrompt('Session name', sessionDefaultName());
    if (!name) return;
    await send('SAVE_SESSION', { name, tags: [] });
    toast('Session saved', 'success');
    await loadAll();
    if (state.view === 'sessions') render();
  });
  $('#autoGroupBtn').addEventListener('click', async () => {
    const n = await send('AUTO_GROUP_TABS');
    toast(`Created ${n} group${n === 1 ? '' : 's'}`, 'success');
    await loadAll();
    render();
  });
  $('#readLaterBtn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const ok = await send('SAVE_TO_READING_LIST', { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl });
    toast(ok ? 'Saved to Reading List' : 'Already in Reading List', ok ? 'success' : 'info');
  });
  $('#closeDupsBtn').addEventListener('click', async () => {
    const dupTotal = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);
    if (dupTotal === 0) { toast('No duplicates found', 'info'); return; }
    const ok = await modalConfirm('Close duplicates?', `Close ${dupTotal} duplicate tab${dupTotal === 1 ? '' : 's'}? The first instance of each URL will be kept.`);
    if (!ok) return;
    const n = await send('CLOSE_DUPLICATES');
    toast(`Closed ${n} duplicate${n === 1 ? '' : 's'}`, 'success');
    await loadAll();
    render();
  });

  // Header buttons
  $('#openSidebarBtn').addEventListener('click', () => {
    // chrome.sidePanel.open() MUST be called synchronously inside a user gesture
    // handler. Any await before it causes Chrome to reject it with
    // "may only be called in response to a user gesture".
    // We pre-fetched the windowId in loadAll() so no async work is needed here.
    try {
      if (state.currentWindowId) {
        chrome.sidePanel.open({ windowId: state.currentWindowId });
      }
    } catch (e) {
      toast('Could not open sidebar', 'error');
    }
    window.close();
  });
  $('#optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

init();