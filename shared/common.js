// common.js — TabVault shared utilities

export function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!resp) return resolve(null);
      if (resp.ok) resolve(resp.data);
      else reject(new Error(resp.error || 'Unknown error'));
    });
  });
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function')
      node.addEventListener(k.slice(2).toLowerCase(), v);
    // 'html' (innerHTML) intentionally removed — use children array or textContent
    // to avoid XSS when displaying user-controlled content (tab titles, bookmark names).
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

export function favicon(url, size = 32) {
  if (!url) return defaultFaviconDataUri();
  try {
    const d = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${d}&sz=${size}`;
  } catch { return defaultFaviconDataUri(); }
}

export function defaultFaviconDataUri() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%239aa1b2" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>'
  );
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function tagColor(tag) {
  const colors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#10b981'];
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ---- Toast system ----
let toastContainer = null;
export function toast(message, type = 'info', duration = 2400) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = message;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 200);
  }, duration);
}

// ---- Undo toast — for reversible destructive actions ----
// Usage: showUndoToast('Tab closed', async () => { /* undo logic */ });
export function showUndoToast(message, undoFn, duration = 5000) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const t = document.createElement('div');
  t.className = 'toast info';
  t.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';

  const msg = document.createElement('span');
  msg.textContent = message;

  const btn = document.createElement('button');
  btn.textContent = 'Undo';
  btn.style.cssText = `
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
  `;

  let undone = false;
  let timer;

  const dismiss = () => {
    clearTimeout(timer);
    t.style.opacity = '0';
    t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 200);
  };

  btn.addEventListener('click', async () => {
    if (undone) return;
    undone = true;
    dismiss();
    try { await undoFn(); } catch (e) { console.warn('[TabVault] undo failed:', e); }
  });

  t.appendChild(msg);
  t.appendChild(btn);
  toastContainer.appendChild(t);

  timer = setTimeout(dismiss, duration);
}
export function modalPrompt(title, defaultValue = '', placeholder = '') {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const input = el('input', { type: 'text', value: defaultValue, placeholder, style: { width: '100%' } });
    const cancel = el('button', { class: 'btn', onclick: () => { backdrop.remove(); resolve(null); } }, 'Cancel');
    const ok = el('button', { class: 'btn btn-primary', onclick: () => { backdrop.remove(); resolve(input.value); } }, 'OK');
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, title),
      input,
      el('div', { class: 'modal-actions' }, [cancel, ok]),
    ]);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(null); } });
    document.body.appendChild(backdrop);
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { backdrop.remove(); resolve(input.value); }
      if (e.key === 'Escape') { backdrop.remove(); resolve(null); }
    });
  });
}

export function modalConfirm(title, message) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const cancel = el('button', { class: 'btn', onclick: () => { backdrop.remove(); resolve(false); } }, 'Cancel');
    const ok = el('button', { class: 'btn btn-primary', onclick: () => { backdrop.remove(); resolve(true); } }, 'Confirm');
    const modal = el('div', { class: 'modal' }, [
      el('h3', {}, title),
      el('p', { style: { color: 'var(--text-dim)', fontSize: '12px' } }, message),
      el('div', { class: 'modal-actions' }, [cancel, ok]),
    ]);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  });
}
