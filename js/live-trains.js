/**
 * RailRaksha — Live Train Position Engine (live-trains.js)
 *
 * Key capabilities:
 *  1. Fetch live running status from RailRadar (FREE — railradar.in/login)
 *  2. Interpolate current train position between known stations
 *  3. Convert km position → GPS coordinates (linear interpolation along track)
 *  4. Calculate Haversine distance: gang mate's GPS ↔ train position
 *  5. Direction-aware alerting: ONLY alert when train is APPROACHING, not receding
 *  6. Configurable alert distances (user-adjustable via Settings)
 *
 * Alert levels (GPS-based, configurable):
 *   PREPARE  → default 15 km — heads up, train is approaching
 *   WARN     → default 8 km  — move tools off track
 *   CRITICAL → default 4 km  — ALL WORKERS CLEAR THE TRACK NOW
 */

// ── Section Station Map (Vijayawada–Chennai mainline) ────────────────────────
// kmFromMAS = distance from Chennai Central (km 0)
export const SECTION_STATIONS = {
  "BZA":  { name: "Vijayawada",      lat: 16.5193, lon: 80.6305, kmFromMAS: 432 },
  "TEL":  { name: "Tenali",          lat: 16.2426, lon: 80.6411, kmFromMAS: 411 },
  "BPP":  { name: "Bapatla",         lat: 15.9066, lon: 80.4672, kmFromMAS: 373 },
  "CL":   { name: "Chirala",         lat: 15.8268, lon: 80.3557, kmFromMAS: 354 },
  "OGL":  { name: "Ongole",          lat: 15.5044, lon: 80.0497, kmFromMAS: 323 },
  "MRT":  { name: "Martur",          lat: 15.3900, lon: 80.0300, kmFromMAS: 309 },
  "ANB":  { name: "Ammanabrolu",      lat: 15.3000, lon: 80.0300, kmFromMAS: 300 },
  "SKM":  { name: "Singarayakonda",  lat: 15.2333, lon: 80.0167, kmFromMAS: 293 },
  "INGR": { name: "Inagallu",        lat: 15.1000, lon: 80.0080, kmFromMAS: 275 },
  "UPD":  { name: "Ulavapadu",        lat: 15.0140, lon: 80.0090, kmFromMAS: 265 },
  "KVZ":  { name: "Kavali",          lat: 14.9152, lon: 80.0067, kmFromMAS: 257 },
  "TGU":  { name: "Tanguturu",        lat: 14.8800, lon: 80.0050, kmFromMAS: 251 },
  "BVRT": { name: "Bitragunta",      lat: 14.7500, lon: 80.0010, kmFromMAS: 238 },
  "NLR":  { name: "Nellore",         lat: 14.4426, lon: 79.9866, kmFromMAS: 214 },
  "GDR":  { name: "Gudur",           lat: 14.1480, lon: 79.8530, kmFromMAS: 185 },
  "MAS":  { name: "Chennai Central", lat: 13.0827, lon: 80.2707, kmFromMAS:   0 },
};

// Sorted by km (ascending, Chennai→Vijayawada)
export const SORTED_STATIONS = Object.values(SECTION_STATIONS)
  .sort((a, b) => a.kmFromMAS - b.kmFromMAS);

// ── Dynamic Alert Thresholds ───────────────────────────────────────────────────
/**
 * Read distance thresholds from user config at runtime.
 * User can change these in ⚙️ Settings without reloading.
 */
export function getDistThresholds() {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  return {
    CRITICAL: parseFloat(cfg("alert_dist_critical")) || 4,
    WARN:     parseFloat(cfg("alert_dist_warn"))     || 8,
    PREPARE:  parseFloat(cfg("alert_dist_prepare"))  || 15,
  };
}

// Keep DIST_THRESHOLDS as an alias for backward compatibility
export const DIST_THRESHOLDS = {
  get CRITICAL() { return getDistThresholds().CRITICAL; },
  get WARN()     { return getDistThresholds().WARN;     },
  get PREPARE()  { return getDistThresholds().PREPARE;  },
};

// ── Haversine Distance ────────────────────────────────────────────────────────
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toRad(deg) { return deg * Math.PI / 180; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── GPS → km from MAS (inverse mapping) ──────────────────────────────────────
/**
 * Convert a GPS coordinate to the approximate km position along the
 * Vijayawada–Chennai track (measured from Chennai Central = km 0).
 * Used to determine if a train is approaching or has passed the worker.
 */
export function gpsToKmFromMAS(lat, lon) {
  let bestKm = 293; // Default to SKM
  let minDist = Infinity;

  for (let i = 0; i < SORTED_STATIONS.length - 1; i++) {
    const s1 = SORTED_STATIONS[i];
    const s2 = SORTED_STATIONS[i + 1];
    const dx = s2.lat - s1.lat, dy = s2.lon - s1.lon;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) continue;

    // Project (lat,lon) onto segment s1→s2
    const t = clamp(((lat - s1.lat) * dx + (lon - s1.lon) * dy) / lenSq, 0, 1);
    const projLat = s1.lat + t * dx;
    const projLon = s1.lon + t * dy;
    const dist = haversineKm(lat, lon, projLat, projLon);

    if (dist < minDist) {
      minDist = dist;
      bestKm = s1.kmFromMAS + t * (s2.kmFromMAS - s1.kmFromMAS);
    }
  }
  return bestKm;
}

// ── km → GPS interpolation ────────────────────────────────────────────────────
export function kmToLatLon(kmFromMAS) {
  if (kmFromMAS <= 0)   return { lat: SECTION_STATIONS.MAS.lat, lon: SECTION_STATIONS.MAS.lon };
  if (kmFromMAS >= 432) return { lat: SECTION_STATIONS.BZA.lat, lon: SECTION_STATIONS.BZA.lon };

  let lower = SORTED_STATIONS[0];
  let upper = SORTED_STATIONS[SORTED_STATIONS.length - 1];
  for (let i = 0; i < SORTED_STATIONS.length - 1; i++) {
    if (SORTED_STATIONS[i].kmFromMAS <= kmFromMAS && SORTED_STATIONS[i+1].kmFromMAS >= kmFromMAS) {
      lower = SORTED_STATIONS[i];
      upper = SORTED_STATIONS[i + 1];
      break;
    }
  }
  const t = (kmFromMAS - lower.kmFromMAS) / (upper.kmFromMAS - lower.kmFromMAS);
  return {
    lat: lower.lat + t * (upper.lat - lower.lat),
    lon: lower.lon + t * (upper.lon - lower.lon),
  };
}

// ── Interpolate Train Position ────────────────────────────────────────────────
export function interpolateTrainPosition(lastStationCode, departureTime, speedKmh, direction, delayMinutes = 0) {
  const station = SECTION_STATIONS[lastStationCode];
  if (!station) return direction === "D" ? 600 : -100;

  const now = new Date();
  const baseTime = departureTime ? new Date(departureTime) : new Date();
  baseTime.setMinutes(baseTime.getMinutes() - delayMinutes);

  const elapsedMin = Math.max(0, (now - baseTime) / 60000);
  const kmTraveled = elapsedMin * speedKmh / 60;

  // DOWN = towards Chennai (km from MAS decreases)
  // UP   = towards Vijayawada (km from MAS increases)
  return direction === "D"
    ? station.kmFromMAS - kmTraveled
    : station.kmFromMAS + kmTraveled;
}

// ── Distance: Train → Worker ──────────────────────────────────────────────────
export function distanceToWorker(trainKmFromMAS, workerLat, workerLon) {
  const { lat, lon } = kmToLatLon(trainKmFromMAS);
  return haversineKm(workerLat, workerLon, lat, lon);
}

// ── Direction-Aware: Is Train APPROACHING the worker? ─────────────────────────
/**
 * Returns true only when the train is moving TOWARDS the worker's position.
 * A train that has already passed and is receding should NOT trigger alerts.
 *
 * @param {number} trainKmFromMAS  - train's current km from MAS
 * @param {number} workerKmFromMAS - worker's km from MAS (derived from GPS or 293 for SKM)
 * @param {"D"|"U"} direction      - "D" = towards Chennai, "U" = towards Vijayawada
 */
export function isTrainApproaching(trainKmFromMAS, workerKmFromMAS, direction) {
  if (direction === "D") {
    // DOWN train moves from high km → low km (towards Chennai/MAS)
    // It's approaching if it's still NORTH of the worker (higher km than worker)
    return trainKmFromMAS > workerKmFromMAS;
  } else {
    // UP train moves from low km → high km (towards Vijayawada/BZA)
    // It's approaching if it's still SOUTH of the worker (lower km than worker)
    return trainKmFromMAS < workerKmFromMAS;
  }
}

// ── Alert Level by Distance ───────────────────────────────────────────────────
export function getDistanceAlertLevel(km) {
  const t = getDistThresholds();
  if (km <= t.CRITICAL) return "CRITICAL";
  if (km <= t.WARN)     return "WARN";
  if (km <= t.PREPARE)  return "PREPARE";
  return "OK";
}

// ── RailRadar API (FREE — https://railradar.in/login) ─────────────────────────
const RAILRADAR_BASE = "https://api.railradar.in";

export async function fetchLiveTrainStatus(trainNo, apiKey) {
  if (!apiKey) return null;
  try {
    const resp = await fetch(`${RAILRADAR_BASE}/v2/trains/${trainNo}/status`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const body = data?.data || data;

    const lat = body?.lat || body?.latitude || null;
    const lon = body?.lon || body?.longitude || null;

    const stations = body?.stations || body?.stationList || [];
    let lastPassed = null;
    for (const st of stations) {
      const actualDep = st.actualDepartureTime || st.actDep || st.actualDep || st.departedAt;
      if (actualDep && actualDep !== "--" && actualDep !== "00:00") lastPassed = st;
    }

    if (!lastPassed) {
      const cur = body?.currentStation || body?.lastStation;
      if (cur) lastPassed = { stationCode: cur.code || cur.stationCode || cur, actualDepartureTime: cur.departureTime || null };
    }
    if (!lastPassed) return null;

    const stCode = (lastPassed.stationCode || lastPassed.stnCode || lastPassed.code || "").toUpperCase();
    const depTimeStr = lastPassed.actualDepartureTime || lastPassed.actDep || lastPassed.departedAt || "";
    const delay = parseInt(body?.delay || body?.delayInMinutes || lastPassed.delay || "0") || 0;

    return { lastStation: stCode, departureTime: parseHHMM(depTimeStr), delayMinutes: delay, lat, lon };
  } catch (err) {
    console.warn(`[LiveTrains] RailRadar fetch failed for ${trainNo}:`, err.message);
    return null;
  }
}

export async function fetchStationLiveBoard(stationCode, apiKey) {
  if (!apiKey) return fetchNTESStationBoard(stationCode);
  try {
    const resp = await fetch(`${RAILRADAR_BASE}/v2/stations/${stationCode}/board`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
      signal: AbortSignal.timeout(6000)
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return fetchNTESStationBoard(stationCode); }
}

async function fetchNTESStationBoard(stationCode) {
  try {
    const url = `https://enquiry.indianrail.gov.in/ntes/json/stationRunningStatus?station=${stationCode}`;
    const resp = await fetch("https://corsproxy.io/?url=" + encodeURIComponent(url), { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

// ── Position Cache (90 second TTL) ───────────────────────────────────────────
const positionCache = new Map();
export function getCachedPosition(trainNo) {
  const c = positionCache.get(trainNo);
  if (!c) return null;
  if (Date.now() - c.timestamp > 90000) { positionCache.delete(trainNo); return null; }
  return c;
}
export function setCachedPosition(trainNo, position, distanceKm) {
  positionCache.set(trainNo, { position, distanceKm, timestamp: Date.now() });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseHHMM(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const result = new Date();
  result.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
  if (result > new Date() && (result - new Date()) > 12 * 3600000) result.setDate(result.getDate() - 1);
  return result;
}

export function formatDistanceAlert(km, trainName, direction) {
  const dir = direction === "D" ? "↓ towards Chennai" : "↑ towards Vijayawada";
  return `${trainName} — ${km.toFixed(1)} km away ${dir}`;
}

// ── Station-Based Alert: Estimate which station a train is near ────────────
/**
 * Given a train's scheduled time at SKM and its speed, estimate
 * which station the train is currently near.
 * Returns { stationCode, stationName, kmFromStation, minutesToWorkSection }
 */
export function estimateTrainStation(train) {
  const skmKm = SECTION_STATIONS.SKM.kmFromMAS; // 293
  const updKm = SECTION_STATIONS.UPD?.kmFromMAS || 265;
  const minUntilSKM = train.minutesUntil;
  const speed = train.speed || 80; // km/h

  // How far is the train from SKM right now (in km)?
  const kmFromSKM = Math.abs(minUntilSKM) * speed / 60;

  // Estimate the train's current km-from-MAS position
  let trainKm;
  if (train.dir === "D") {
    // DOWN train (BZA → GDR direction): approaching from high km (north)
    // If minUntilSKM > 0, train hasn't reached SKM yet, so it's NORTH of SKM
    trainKm = minUntilSKM > 0 ? skmKm + kmFromSKM : skmKm - kmFromSKM;
  } else {
    // UP train (GDR → BZA direction): approaching from low km (south)
    // If minUntilSKM > 0, train hasn't reached SKM yet, so it's SOUTH of SKM
    trainKm = minUntilSKM > 0 ? skmKm - kmFromSKM : skmKm + kmFromSKM;
  }

  // Find the nearest station to this km position
  let nearestStation = SORTED_STATIONS[0];
  let nearestDist = Infinity;
  for (const st of SORTED_STATIONS) {
    const d = Math.abs(st.kmFromMAS - trainKm);
    if (d < nearestDist) {
      nearestDist = d;
      nearestStation = st;
    }
  }

  // Calculate minutes until train enters the work section (SKM ↔ UPD)
  let minutesToWorkSection;
  if (train.dir === "D") {
    // DOWN train enters work section at SKM (it's the north boundary)
    minutesToWorkSection = minUntilSKM;
  } else {
    // UP train enters work section at UPD (south boundary)
    // UPD is (skmKm - updKm) = 28 km south of SKM
    // Time from UPD to SKM at train speed = distance / speed * 60
    const updToSkmMinutes = Math.abs(skmKm - updKm) / speed * 60;
    minutesToWorkSection = minUntilSKM - updToSkmMinutes;
  }

  return {
    stationCode: nearestStation.name,
    stationName: nearestStation.name,
    kmFromStation: Math.round(nearestDist),
    trainKm: Math.round(trainKm),
    minutesToWorkSection: Math.round(minutesToWorkSection)
  };
}

