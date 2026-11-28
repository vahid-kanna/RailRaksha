/**
 * RailRaksha — Offline IndexedDB Storage Layer v7.0 (db.js)
 *
 * Uses Asia/Kolkata (IST, UTC+05:30) date stamps so early-morning railway shifts
 * (00:00–05:30 IST) never roll back to yesterday's UTC date.
 */

const DB_NAME = 'railraksha_db';
const DB_VERSION = 1;
const IST_OFFSET_MS = 330 * 60000;

export const STORES = Object.freeze({
  DIARY_ENTRIES:  'diary_entries',
  DEFECT_REPORTS: 'defect_reports',
  WEATHER_CACHE:  'weather_cache',
  SETTINGS:       'settings',
  ALERT_LOG:      'alert_log',
});

let db = null;

/** Current date string YYYY-MM-DD in IST (UTC+05:30). */
export function getISTDateISO(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function openDB() {
  if (db) return db;
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => resolve(null);
      request.onsuccess = () => { db = request.result; resolve(db); };
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORES.DIARY_ENTRIES)) {
          const ds = database.createObjectStore(STORES.DIARY_ENTRIES, { keyPath: 'id', autoIncrement: true });
          ds.createIndex('date', 'date', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORES.DEFECT_REPORTS)) {
          const dr = database.createObjectStore(STORES.DEFECT_REPORTS, { keyPath: 'id', autoIncrement: true });
          dr.createIndex('status', 'status', { unique: false });
          dr.createIndex('date', 'date', { unique: false });
        }
        if (!database.objectStoreNames.contains(STORES.WEATHER_CACHE)) {
          database.createObjectStore(STORES.WEATHER_CACHE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(STORES.SETTINGS)) {
          database.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(STORES.ALERT_LOG)) {
          const al = database.createObjectStore(STORES.ALERT_LOG, { keyPath: 'id', autoIncrement: true });
          al.createIndex('date', 'date', { unique: false });
        }
      };
    } catch {
      resolve(null);
    }
  });
}

async function getStore(storeName, mode = 'readonly') {
  const database = await openDB();
  if (!database) return null;
  return database.transaction(storeName, mode).objectStore(storeName);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function dbPut(storeName, data) {
  const store = await getStore(storeName, 'readwrite');
  if (!store) return null;
  return promisify(store.put(data));
}

export async function dbGet(storeName, key) {
  const store = await getStore(storeName);
  if (!store) return null;
  return promisify(store.get(key));
}

export async function dbGetAll(storeName) {
  const store = await getStore(storeName);
  if (!store) return [];
  return promisify(store.getAll());
}

export async function dbDelete(storeName, key) {
  const store = await getStore(storeName, 'readwrite');
  if (!store) return null;
  return promisify(store.delete(key));
}

export async function dbClear(storeName) {
  const store = await getStore(storeName, 'readwrite');
  if (!store) return null;
  return promisify(store.clear());
}

// ── Settings helpers ─────────────────────────────────────────────────────────
export async function getSetting(key, defaultValue = null) {
  const result = await dbGet(STORES.SETTINGS, key);
  return result ? result.value : defaultValue;
}

export async function setSetting(key, value) {
  return dbPut(STORES.SETTINGS, { key, value });
}

// ── Diary entries ────────────────────────────────────────────────────────────
export async function saveDiaryEntry(entry) {
  return dbPut(STORES.DIARY_ENTRIES, {
    ...entry,
    date: entry.date || getISTDateISO(),
    createdAt: entry.createdAt || new Date().toISOString(),
  });
}

export async function getDiaryEntries(date = null) {
  const all = await dbGetAll(STORES.DIARY_ENTRIES);
  const sorted = all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return date ? sorted.filter(e => e.date === date) : sorted;
}

export async function deleteDiaryEntry(id) {
  return dbDelete(STORES.DIARY_ENTRIES, id);
}

// ── Defect reports ───────────────────────────────────────────────────────────
export async function saveDefectReport(report) {
  return dbPut(STORES.DEFECT_REPORTS, {
    ...report,
    date: report.date || getISTDateISO(),
    createdAt: report.createdAt || new Date().toISOString(),
    status: report.status || 'OPEN',
  });
}

export async function getDefectReports() {
  const all = await dbGetAll(STORES.DEFECT_REPORTS);
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function updateDefectStatus(id, status) {
  const report = await dbGet(STORES.DEFECT_REPORTS, id);
  if (!report) return null;
  report.status = status;
  report.updatedAt = new Date().toISOString();
  return dbPut(STORES.DEFECT_REPORTS, report);
}

export async function deleteDefectReport(id) {
  return dbDelete(STORES.DEFECT_REPORTS, id);
}

// ── Alert audit log ──────────────────────────────────────────────────────────
export async function logAlert({ trainNo, trainName, line, distanceKm, etaSec, level, source, workerKm }) {
  return dbPut(STORES.ALERT_LOG, {
    trainNo,
    trainName,
    line,
    distanceKm,
    etaSec,
    level,
    source,
    workerKm,
    date: getISTDateISO(),
    timestamp: new Date().toISOString(),
  });
}

export async function getAlertLogs(limit = 30) {
  const all = await dbGetAll(STORES.ALERT_LOG);
  return all
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
}

export async function clearAlertLogs() {
  return dbClear(STORES.ALERT_LOG);
}

// ── Full offline export (excludes sensitive API keys) ────────────────────────
export async function exportAllData() {
  const [diaryEntries, defectReports, alertLogs] = await Promise.all([
    getDiaryEntries(),
    getDefectReports(),
    getAlertLogs(200),
  ]);
  return {
    app: 'RailRaksha',
    version: '8.3',
    exportedAt: new Date().toISOString(),
    istDate: getISTDateISO(),
    diaryEntries,
    defectReports,
    alertLogs,
  };
}
