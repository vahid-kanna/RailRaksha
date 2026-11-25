const CACHE_NAME = 'railraksha-v8.2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css?v=8.2',
  '/js/app.js?v=8.2',
  '/js/config.js',
  '/js/db.js',
  '/js/ai-engine.js',
  '/js/corridor.js',
  '/js/gps-tracker.js',
  '/js/timetable-data.js',
  '/js/live-trains.js',
  '/js/train-alert.js',
  '/js/defect-report.js',
  '/js/gang-diary.js',
  '/js/weather-alert.js',
  '/js/pw-manual.js',
  '/js/icons.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Never cache live API traffic
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Network-first for HTML/JS/CSS to ensure fresh updates, falling back cleanly to cache offline
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(event.request).then((m) => m || caches.match('/index.html')))
    );
  }
});
