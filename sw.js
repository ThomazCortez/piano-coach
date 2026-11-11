// Offline: serve from cache, refresh the cache in the background.
const CACHE = 'piano-coach-v9';
const FILES = ['./', 'index.html', 'app.js', 'matcher.js', 'vendor/Midi.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

// A new version takes over at once (skipWaiting + claim); app.js then reloads the page to show it.
// Without this an installed app keeps the old code until every window of it has been closed.
self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())
));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone(); // clone now: once the page starts reading res it can't be cloned
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    });
    return hit || net;
  }));
});
