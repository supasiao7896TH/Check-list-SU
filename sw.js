/* Service Worker — Check list SU (mobile PWA) */
const CACHE = 'su-checklist-v2';
const SHELL = [
  './',
  './interactive_checklist_su_mobile.html',
  './shared/app-core.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // App document: network-first (fresh build), fall back to cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./interactive_checklist_su_mobile.html')))
    );
    return;
  }

  // Everything else (incl. CDN assets): cache-first, then network + cache.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const cp = res.clone();
      caches.open(CACHE).then((c) => c.put(req, cp));
      return res;
    }).catch(() => cached))
  );
});
