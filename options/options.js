// options.js — TabVault settings page
import { send, $, toast, modalConfirm } from '../shared/common.js';

const FIELDS = [
  ['defaultView', 'value'],
  ['showToolbarButton', 'checked'],
  ['openOnStart', 'checked'],
  ['suspenderEnabled', 'checked'],
  ['suspendAfterMinutes', 'value', Number],
  ['neverSuspendPatterns', 'value', (v) => v.split('\n').map(s => s.trim()).filter(Boolean), (arr) => (arr || []).join('\n')],
  ['duplicateDetection', 'checked'],
  ['showTabBadge', 'checked'],
  ['autoTagBookmarks', 'checked'],
  ['defaultNoteTemplate', 'value'],
  ['scanSchedule', 'value'],
  ['showBookmarkCount', 'checked'],
];

async function load() {
  const settings = await send('GET_SETTINGS');
  for (const [id, prop, , fromStore] of FIELDS) {
    const elNode = $('#' + id);
    if (!elNode) continue;
    const value = settings[id];
    elNode[prop] = fromStore ? fromStore(value) : value;
  }
}

async function save() {
  const update = {};
  for (const [id, prop, toStore] of FIELDS) {
    const elNode = $('#' + id);
    if (!elNode) continue;
    let v = elNode[prop];
    if (toStore) v = toStore(v);
    update[id] = v;
  }
  await send('SET_SETTINGS', update);
  $('#savedHint').textContent = 'Settings saved';
  toast('Settings saved', 'success');
  setTimeout(() => { $('#savedHint').textContent = ''; }, 2000);
}

$('#saveBtn').addEventListener('click', save);
$('#cancelBtn')?.addEventListener('click', () => load());

$('#exportBtn').addEventListener('click', async () => {
  const data = await send('EXPORT_DATA');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported', 'success');
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const ok = await modalConfirm('Import data?', 'This will merge with your existing data. Continue?');
    if (!ok) return;
    await send('IMPORT_DATA', { data });
    toast('Imported successfully', 'success');
    await load();
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  }
});

$('#clearBtn').addEventListener('click', async () => {
  const ok = await modalConfirm('Clear all TabVault data?', 'This will permanently delete all sessions, bookmark metadata, and settings. This cannot be undone.');
  if (!ok) return;
  await send('CLEAR_ALL_DATA');
  toast('All data cleared', 'success');
  await load();
});

$('#kbdLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

load();