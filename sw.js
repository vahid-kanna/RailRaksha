/**
 * RailRaksha — Service Worker
 * Offline-first caching for all app assets.
 * Background sync for defect reports when online.
 *
 * Strategy: Stale-While-Revalidate for JS/CSS/HTML (serves cached instantly,
 * then updates cache from network in the background so the NEXT load is fresh).
 * Cache-first for static assets (icons, manifest).
 */

const CACHE_NAME = 'railraksha-v3.3';

const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/css/style.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/manifest.json"
];

const DYNAMIC_ASSETS = [
  "/js/app.js",
  "/js/config.js",
  "/js/config-keys.js",
  "/js/ai-engine.js",
  "/js/train-alert.js",
  "/js/live-trains.js",
  "/js/timetable-data.js",
  "/js/defect-report.js",
  "/js/gang-diary.js",
  "/js/weather-alert.js",
  "/js/pw-manual.js",
  "/js/db.js",
  "/js/icons.js"
];

// Install — cache all assets
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll([...SHELL_ASSETS, ...DYNAMIC_ASSETS])
    )
  );
  // Force activate immediately so old cache is purged
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Skip cross-origin requests (API calls) — let them go to network
  if (url.origin !== self.location.origin) {
    e.respondWith(fetch(e.request).catch(() => new Response("Offline", { status: 503 })));
    return;
  }

  const isDynamic = DYNAMIC_ASSETS.some(a => url.pathname.endsWith(a.replace("/js/", "/js/")));
  const isHTML    = url.pathname === "/" || url.pathname.endsWith("/index.html");

  // ── Stale-While-Revalidate for JS/CSS/HTML ──────────────────────────────
  // Serve cached version immediately (instant load), but also fetch from
  // network and update the cache so the NEXT page load gets the fresh version.
  if (isDynamic || isHTML) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const networkPromise = fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached);

          // Return cached immediately if available, otherwise wait for network
          return cached || networkPromise;
        })
      )
    );
    return;
  }

  // ── Cache-first for static assets (icons, manifest) ──────────────────────
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, cloned));
        }
        return response;
      }).catch(() => {
        if (e.request.mode === "navigate") {
          return caches.match("/index.html");
        }
        return new Response("Offline", { status: 503 });
      });
    })
  );
});

// Background sync for defect reports
self.addEventListener("sync", (e) => {
  if (e.tag === "sync-defect-reports") {
    e.waitUntil(syncDefectReports());
  }
});

async function syncDefectReports() {
  try {
    const db = await openOfflineDB();
    if (!db) return;

    const reports = await getAllPendingReports(db);
    if (reports.length === 0) return;

    const endpoint = await getSyncEndpoint();

    for (const report of reports) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report)
        });
        if (response.ok) {
          await markReportSynced(db, report.id);
          console.log("[RailRaksha SW] Synced defect report:", report.id);
        }
      } catch (err) {
        console.warn("[RailRaksha SW] Failed to sync report:", report.id, err);
      }
    }
  } catch (err) {
    console.error("[RailRaksha SW] Sync error:", err);
  }
}

function openOfflineDB() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open("railraksha_db", 1);
      request.onerror = () => resolve(null);
      request.onsuccess = () => resolve(request.result);
    } catch {
      resolve(null);
    }
  });
}

function getAllPendingReports(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("defect_reports", "readonly");
      const store = tx.objectStore("defect_reports");
      const index = store.index("status");
      const request = index.getAll("OPEN");
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

function markReportSynced(db, id) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction("defect_reports", "readwrite");
      const store = tx.objectStore("defect_reports");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const report = getReq.result;
        if (report) {
          report.status = "SYNCED";
          report.syncedAt = new Date().toISOString();
          store.put(report);
        }
        resolve();
      };
    } catch {
      resolve();
    }
  });
}

function getSyncEndpoint() {
  return new Promise((resolve) => {
    resolve("/api/defect-reports");
  });
}
