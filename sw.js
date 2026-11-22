/**
 * RailRaksha — Offline-First Service Worker (v6.0)
 *
 * - Network-only for /api/* and non-GET requests (never caches live feeds or AI POSTs)
 * - Stale-While-Revalidate for HTML, CSS, and JS modules (instant offline boot + fresh updates)
 * - Cache-First for static icons and manifest
 */

const CACHE_NAME = 'railraksha-v6.0';

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

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll([...SHELL_ASSETS, ...DYNAMIC_ASSETS]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Never intercept non-GET requests (e.g. POST /api/chat)
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Never cache cross-origin API calls or same-origin /api/* endpoints
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return;
  }

  const isDynamic = DYNAMIC_PATHS.has(url.pathname) || url.pathname === '/css/style.css';
  const isHTML = url.pathname === '/' || url.pathname.endsWith('/index.html');

  // Stale-While-Revalidate for app shell & JS/CSS
  if (isDynamic || isHTML) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const networkPromise = fetch(e.request)
            .then(response => {
              if (response.ok) cache.put(e.request, response.clone());
              return response;
            })
            .catch(() => cached);
          return cached || networkPromise;
        })
      )
    );
    return;
  }

  // Cache-first for static assets (icons, manifest)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(response => {
          if (response.ok) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, cloned));
          }
          return response;
        })
        .catch(() => {
          if (e.request.mode === 'navigate') return caches.match('./index.html');
          return new Response('Offline', { status: 503 });
        });
    })
  );
});
