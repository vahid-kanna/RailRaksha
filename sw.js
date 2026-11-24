/**
 * RailRaksha — Offline-First Service Worker (v7.0)
 *
 * - Network-only for /api/* and non-GET requests (never caches live train feeds or AI POSTs)
 * - Stale-While-Revalidate for HTML, CSS, and JS modules with ignoreSearch matching
 *   so query-string cache busters never break first-boot offline loads
 * - Cache-First for static icons and manifest
 */

const CACHE_NAME = 'railraksha-v7.0';

const SHELL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './icons/logo.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './manifest.json',
];

const DYNAMIC_ASSETS = [
  './js/app.js',
  './js/corridor.js',
  './js/gps-tracker.js',
  './js/config.js',
  './js/ai-engine.js',
  './js/train-alert.js',
  './js/live-trains.js',
  './js/timetable-data.js',
  './js/defect-report.js',
  './js/gang-diary.js',
  './js/weather-alert.js',
  './js/pw-manual.js',
  './js/db.js',
  './js/icons.js',
];

const DYNAMIC_PATHS = new Set(DYNAMIC_ASSETS.map(a => a.replace(/^\.\//, '/')));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll([...SHELL_ASSETS, ...DYNAMIC_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept cross-origin calls or same-origin /api/* edge endpoints
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  const cleanPath = url.pathname;
  const isDynamic = DYNAMIC_PATHS.has(cleanPath) || cleanPath === '/css/style.css';
  const isHTML = cleanPath === '/' || cleanPath.endsWith('/index.html') || event.request.mode === 'navigate';

  if (isDynamic || isHTML) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request, { ignoreSearch: true }).then(cached => {
          const networkPromise = fetch(event.request)
            .then(response => {
              if (response.ok) cache.put(event.request, response.clone());
              return response;
            })
            .catch(() => cached || (isHTML ? cache.match('./index.html') : new Response('Offline', { status: 503 })));
          return cached || networkPromise;
        })
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (response.ok) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(() => new Response('Offline', { status: 503 }));
    })
  );
});
