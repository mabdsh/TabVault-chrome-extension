// sidebar.js — TabVault sidebar main module
import {
  send, $, $$, el, debounce, getDomain, favicon, defaultFaviconDataUri,
  formatDate, escapeHtml, tagColor, toast, showUndoToast, modalPrompt, modalConfirm,
} from '../shared/common.js';

const state = {
  view: 'tabs',
  tabs: [],
  groups: [],
  windows: [],           // all open normal windows (populated in 'all' mode)
  windowFilter: null,    // null = current window, 'all' = all windows, number = specific windowId
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
      renderSearch();
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
    const [tabsData, sessions, tree, meta, dups] = await Promise.all([
      send('GET_ALL_TABS', { windowId: state.windowFilter }),
      send('GET_ALL_SESSIONS'),
      send('GET_BOOKMARK_TREE'),
      send('GET_ALL_BOOKMARK_META'),
      send('FIND_DUPLICATES'),
    ]);
    state.tabs = tabsData.tabs || [];
    state.groups = tabsData.groups || [];
    state.windows = tabsData.windows || [];
    state.sessions = sessions || [];
    state.bookmarkTree = tree || [];
    state.bookmarkMeta = meta || {};
    state.duplicates = dups || [];
    state.flatBookmarks = [];
    flatten(state.bookmarkTree, state.flatBookmarks);

    $('#navTabCount').textContent = state.tabs.length;
    $('#navSessionCount').textContent = state.sessions.length;
    const dupTotal = state.duplicates.reduce((a, b) => a + (b.tabs.length - 1), 0);
    const dupBadge = $('#navDupCount');
    if (dupTotal > 0) { dupBadge.hidden = false; dupBadge.textContent = dupTotal; }
    else dupBadge.hidden = true;
  } catch (e) {
    console.error('[TabVault] refresh failed:', e);
    toast('Failed to load data', 'error');
  }
}

function flatten(nodes, out) {
  for (const n of nodes) {
    if (n.url) out.push(n);
    if (n.children) flatten(n.children, out);
  }
}

// ----- Tab listeners (live updates) -----
function setupTabListeners() {
  // Only rebuild on meaningful state changes to avoid flicker on every keypress.
  // onUpdated fires on every URL character typed — filter to 'complete' only.
  const refresh = debounce(async () => {
    await refreshAll();
    // render() clears #main before redrawing — do NOT call views[x](main) directly
    // as that appends onto existing content and causes DOM doubling.
    if (!state.searchQuery) render();
  }, 150);
  chrome.tabs.onCreated.addListener(refresh);
  chrome.tabs.onRemoved.addListener(refresh);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    // Only refresh on meaningful changes; 'loading' fires on every URL keystroke
    if (info.status === 'complete' || info.title || info.pinned !== undefined) refresh();
  });
  chrome.tabs.onMoved.addListener(refresh);
  chrome.tabs.onActivated.addListener(refresh);
  try {
    chrome.tabGroups.onCreated.addListener(refresh);
    chrome.tabGroups.onUpdated.addListener(refresh);
    chrome.tabGroups.onRemoved.addListener(refresh);
  } catch {}
  chrome.bookmarks.onCreated.addListener(refresh);
  chrome.bookmarks.onRemoved.addListener(refresh);
  chrome.bookmarks.onChanged.addListener(refresh);
  chrome.bookmarks.onMoved.addListener(refresh);
}

// ===========================================================================
// TABS VIEW
// ===========================================================================
views.tabs = function (root) {
  const panel = el('div', { class: 'panel' + (state.selectionMode ? ' selection-mode' : '') });

  // Window picker — lets users see tabs from all windows or a specific one
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
        onclick: async () => {
          if (state.selectedTabIds.size === 0) return;
          for (const id of state.selectedTabIds) {
            try { await send('CLOSE_TAB', { tabId: id }); } catch {}
          }
          state.selectedTabIds.clear();
          await refreshAll();
          render();
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
    ].filter(Boolean)),
  ]);
  panel.appendChild(header);

  const body = el('div', { class: 'panel-body' });
  body.id = 'tabsBody';

  if (state.tabs.length === 0) {
    body.appendChild(emptyState('No tabs open', 'Open some websites to get started.'));
  } else {
    renderTabList(body);
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
  // Group tabs by groupId; pinned first
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
    container.appendChild(el('div', { class: 'group-header' }, 'Pinned'));
    for (const t of pinned) container.appendChild(tabRow(t));
  }

  // Render groups in order they appear
  for (const group of state.groups) {
    const tabs = grouped.get(group.id);
    if (!tabs) continue;
    const header = el('div', { class: 'group-header' }, [
      el('span', { class: `group-dot group-${group.color}` }),
      el('span', {}, group.title || '(unnamed group)'),
      el('span', { class: 'folder-count' }, `${tabs.length}`),
    ]);
    container.appendChild(header);
    for (const t of tabs) container.appendChild(tabRow(t));
  }

  for (const t of ungrouped) container.appendChild(tabRow(t));
}

function tabRow(tab) {
  const isSuspended = tab.url?.includes('suspended.html');
  const isSelected = state.selectedTabIds.has(tab.id);
  const row = el('div', {
    class: 'row' + (tab.active ? ' active' : '') +
           (isSuspended ? ' suspended' : '') +
           (tab.pinned ? ' pinned' : '') +
           (isSelected ? ' selected' : ''),
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
  row.appendChild(fav);

  row.appendChild(el('div', { class: 'meta' }, [
    el('div', { class: 'title' }, tab.title || '(untitled)'),
    el('div', { class: 'sub' }, getDomain(tab.url)),
  ]));

  const actions = el('div', { class: 'actions' }, [
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: tab.pinned ? 'Unpin' : 'Pin',
      onclick: async (e) => {
        e.stopPropagation();
        await send('PIN_TAB', { tabId: tab.id, pinned: !tab.pinned });
        await refreshAll();
        render();
      },
    }, tab.pinned ? '📍' : '📌'),
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: 'Suspend',
      onclick: async (e) => {
        e.stopPropagation();
        await send('SUSPEND_TAB', { tabId: tab.id });
        await refreshAll();
        render();
      },
    }, '💤'),
    el('button', {
      class: 'btn btn-icon btn-ghost',
      title: 'Close',
      onclick: async (e) => {
        e.stopPropagation();
        // Snapshot URL/title before closing so undo can restore it
        const { url, title, pinned } = tab;
        await send('CLOSE_TAB', { tabId: tab.id });
        showUndoToast(`Closed "${tab.title || 'tab'}"`, async () => {
          await send('OPEN_URL', { url, pinned });
        });
      },
    }, '✕'),
  ]);
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

function renderSearch() {
  const main = $('#main');
  // main was already cleared by render()
  const panel = el('div', { class: 'panel' });
  const body = el('div', { class: 'panel-body' });

  if (!buildFuseIndex()) {
    body.appendChild(emptyState('Search unavailable', 'Fuse.js failed to load. Reload the extension.'));
    panel.appendChild(body);
    main.appendChild(panel);
    return;
  }

  const tabResults = fuseTabs.search(state.searchQuery).slice(0, 20);
  const bmResults = fuseBookmarks.search(state.searchQuery).slice(0, 30);

  if (tabResults.length === 0 && bmResults.length === 0) {
    body.appendChild(emptyState('No results', `Nothing found for "${state.searchQuery}". Try different keywords.`));
  } else {
    if (tabResults.length) {
      body.appendChild(el('div', { class: 'search-section-header' }, `🗂  OPEN TABS (${tabResults.length})`));
      for (const r of tabResults) body.appendChild(tabRow(r.item));
    }
    if (bmResults.length) {
      body.appendChild(el('div', { class: 'search-section-header' }, `🔖  BOOKMARKS (${bmResults.length})`));
      for (const r of bmResults) body.appendChild(bookmarkRow(r.item.bm));
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

init();
