/**
 * RailRaksha — IndexedDB Wrapper (db.js)
 * Simple async wrapper around IndexedDB for offline data persistence.
 */

const DB_NAME = "railraksha_db";
const DB_VERSION = 1;

const STORES = {
  DIARY_ENTRIES: "diary_entries",
  DEFECT_REPORTS: "defect_reports",
  WEATHER_CACHE: "weather_cache",
  SETTINGS: "settings",
  ALERT_LOG: "alert_log"
};

let db = null;

export async function openDB() {
  if (db) return db;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => { console.warn("[DB] IndexedDB unavailable"); resolve(null); };
      request.onsuccess = () => { db = request.result; resolve(db); };
      request.onupgradeneeded = (event) => {
        const database = event.target.result;
        if (!database.objectStoreNames.contains(STORES.DIARY_ENTRIES)) {
          const ds = database.createObjectStore(STORES.DIARY_ENTRIES, { keyPath: "id", autoIncrement: true });
          ds.createIndex("date", "date", { unique: false });
        }
        if (!database.objectStoreNames.contains(STORES.DEFECT_REPORTS)) {
          const dr = database.createObjectStore(STORES.DEFECT_REPORTS, { keyPath: "id", autoIncrement: true });
          dr.createIndex("status", "status", { unique: false });
          dr.createIndex("date", "date", { unique: false });
        }
        if (!database.objectStoreNames.contains(STORES.WEATHER_CACHE)) {
          database.createObjectStore(STORES.WEATHER_CACHE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(STORES.SETTINGS)) {
          database.createObjectStore(STORES.SETTINGS, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(STORES.ALERT_LOG)) {
          const al = database.createObjectStore(STORES.ALERT_LOG, { keyPath: "id", autoIncrement: true });
          al.createIndex("date", "date", { unique: false });
        }
      };
    } catch (e) {
      console.warn("[DB] IndexedDB open failed:", e);
      resolve(null);
    }
  });
}

async function getStore(storeName, mode = "readonly") {
  const database = await openDB();
  if (!database) throw new Error("IndexedDB not available");
  return database.transaction(storeName, mode).objectStore(storeName);
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── Generic CRUD ─────────────────────────────────────

export async function dbPut(storeName, data) {
  const store = await getStore(storeName, "readwrite");
  return promisify(store.put(data));
}

export async function dbGet(storeName, key) {
  const store = await getStore(storeName);
  return promisify(store.get(key));
}

export async function dbGetAll(storeName) {
  const store = await getStore(storeName);
  return promisify(store.getAll());
}

export async function dbDelete(storeName, key) {
  const store = await getStore(storeName, "readwrite");
  return promisify(store.delete(key));
}

// ── Settings helpers ─────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const result = await dbGet(STORES.SETTINGS, key);
  return result ? result.value : defaultValue;
}

export async function setSetting(key, value) {
  return dbPut(STORES.SETTINGS, { key, value });
}

// ── Diary entries ────────────────────────────────────

export async function saveDiaryEntry(entry) {
  return dbPut(STORES.DIARY_ENTRIES, {
    ...entry,
    date: entry.date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString()
  });
}

export async function getDiaryEntries(date = null) {
  const all = await dbGetAll(STORES.DIARY_ENTRIES);
  if (!date) return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return all.filter(e => e.date === date).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ── Defect reports ───────────────────────────────────

export async function saveDefectReport(report) {
  return dbPut(STORES.DEFECT_REPORTS, {
    ...report,
    date: report.date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    status: report.status || "OPEN"
  });
}

export async function getDefectReports() {
  const all = await dbGetAll(STORES.DEFECT_REPORTS);
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function updateDefectStatus(id, status) {
  const store = await getStore(STORES.DEFECT_REPORTS);
  const report = await promisify(store.get(id));
  if (report) {
    report.status = status;
    report.updatedAt = new Date().toISOString();
    const writeStore = await getStore(STORES.DEFECT_REPORTS, "readwrite");
    return promisify(writeStore.put(report));
  }
}

// ── Alert log ────────────────────────────────────────

export async function logAlert(trainNo, trainName, minutesBefore, alertLevel) {
  return dbPut(STORES.ALERT_LOG, {
    trainNo, trainName, minutesBefore, alertLevel,
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString()
  });
}

export { STORES };
