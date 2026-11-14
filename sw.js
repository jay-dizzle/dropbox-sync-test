// App-Hülle offline verfügbar machen; Dropbox-Aufrufe gehen immer ins Netz.
const VERSION = 'sync-test-v3';
const DATEIEN = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(k => Promise.all(k.filter(n => n !== VERSION).map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Netz zuerst, damit Updates sofort ankommen; ohne Netz aus dem Cache.
  e.respondWith(
    fetch(e.request)
      .then(r => { const kopie = r.clone(); caches.open(VERSION).then(c => c.put(e.request, kopie)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
