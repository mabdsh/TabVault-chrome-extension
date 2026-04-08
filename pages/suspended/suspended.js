// suspended.js — TabVault tab restore page
(function () {
  const params = new URLSearchParams(location.search);
  const url = params.get('url') || '';
  const title = params.get('title') || 'Suspended tab';
  const fav = params.get('favicon') || '';

  document.title = '💤 ' + title;
  document.getElementById('title').textContent = title;
  let domain = '';
  try { domain = new URL(url).hostname; } catch {}
  document.getElementById('domain').textContent = domain;

  const img = document.getElementById('favicon');
  if (fav) img.src = fav;
  else if (domain) img.src = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  else img.style.display = 'none';
  img.onerror = () => { img.style.display = 'none'; };

  function restore() {
    if (url) location.replace(url);
  }

  document.getElementById('restoreBtn').addEventListener('click', restore);
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') restore();
  });
})();
