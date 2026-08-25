/* Site Clock service worker — offline shell caching. */
const CACHE = 'sqclk-v1';
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './clock.css',
    './manifest.webmanifest',
    './logo.jpg',
    './logo.png',
    './favicon.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE)
            .then((c) => c.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return; // POST clock submissions bypass SW
    if (new URL(req.url).origin !== self.location.origin) return;

    e.respondWith(
        caches.match(req).then((cached) =>
            cached || fetch(req).catch(() => caches.match('./index.html'))
        )
    );
});
