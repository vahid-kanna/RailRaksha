/**
 * RailRaksha — Train Alert Engine v2 (train-alert.js)
 *
 * Two-layer safety architecture:
 *  Layer 1 — SCHEDULE (always offline): Alert based on scheduled SKM time
 *  Layer 2 — LIVE GPS (when online): Alert based on real distance from worker
 *
 * Alert cascade:
 *  PREPARE  → Train > 8 km but < 15 km, OR > 20 min by schedule
 *  WARN     → Train 4–8 km, OR 8–15 min by schedule
 *  CRITICAL → Train < 4 km (live), OR < 7 min (schedule) — CLEAR TRACK NOW
 */

import { getActiveTrains, getAlertLevel, getAlertThresholds } from './timetable-data.js';
import {
  fetchLiveTrainStatus, interpolateTrainPosition, distanceToWorker,
  getDistanceAlertLevel, getCachedPosition, setCachedPosition,
  getDistThresholds, formatDistanceAlert, isTrainApproaching, gpsToKmFromMAS
} from './live-trains.js';
import { logAlert } from './db.js';

// ── State ────────────────────────────────────────────────────────────────────
let workSessionActive = false;
let scheduleInterval  = null;   // checks every 30 sec (schedule-based)
let liveInterval      = null;   // checks every 60 sec (live API)
let gpsInterval       = null;   // distance calc every 15 sec (GPS-based)
let wakeLock          = null;
let onTrainsUpdate    = null;
let onDistanceUpdate  = null;
let sessionStartTime  = null;
const alertedTrains   = {};     // trainNo → last alerted level (avoid repeat spam)

// ── Callbacks ─────────────────────────────────────────────────────────────────
export function setTrainsUpdateCallback(cb)   { onTrainsUpdate  = cb; }
export function setDistanceUpdateCallback(cb) { onDistanceUpdate = cb; }
export function isWorkSessionActive()         { return workSessionActive; }
export function getSessionStartTime()         { return sessionStartTime; }

// ── Session Control ────────────────────────────────────────────────────────────

export async function startWorkSession() {
  if (workSessionActive) return;
  workSessionActive = true;
  sessionStartTime  = new Date();
  Object.keys(alertedTrains).forEach(k => delete alertedTrains[k]);

  // Acquire screen wake lock so phone doesn't sleep on track
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}

  // Immediate checks
  await checkBySchedule();
  await checkByLiveGPS();

  // Periodic checks
  scheduleInterval = setInterval(checkBySchedule, 30_000);  // every 30 sec
  liveInterval     = setInterval(fetchLivePositions, 60_000); // every 60 sec
  gpsInterval      = setInterval(checkByLiveGPS, 15_000);    // every 15 sec
}

export function stopWorkSession() {
  workSessionActive = false;
  sessionStartTime  = null;
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
  clearInterval(scheduleInterval);
  clearInterval(liveInterval);
  clearInterval(gpsInterval);
  scheduleInterval = liveInterval = gpsInterval = null;
  Object.keys(alertedTrains).forEach(k => delete alertedTrains[k]);
  // Notify UI to reset
  if (onTrainsUpdate) onTrainsUpdate([]);
  if (onDistanceUpdate) onDistanceUpdate(null);
}

// ── Layer 1: Schedule-based check (offline, every 30 sec) ────────────────────

export async function checkBySchedule() {
  if (!workSessionActive) return;
  const trains = getActiveTrains();

  // ── HARD GATE: Never alert for trains beyond 120 min ──────────────────
  // This prevents stale/wrapped trains from firing phantom alerts.
  const ALERT_HORIZON_MIN = 120;

  if (onTrainsUpdate) onTrainsUpdate(trains);

  // Determine alert mode
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  const alertMode = cfg("alert_mode") || "station";

  for (const train of trains) {
    // Train INSIDE the work section → always CRITICAL, always alert
    if (train.inSection) {
      escalateAlert(train.no, "CRITICAL", train, "schedule",
        `INSIDE SKM↔UPD section — clear the track`);
      continue;
    }

    // Skip trains beyond the alert horizon — they are NOT a danger right now
    const effectiveMin = alertMode === "station"
      ? (train.minutesToWork ?? train.minutesUntil)
      : train.minutesUntil;
    if (effectiveMin > ALERT_HORIZON_MIN) continue;

    const level = train.alertLevel;
    if (level === "OK" || level === "PASSED") continue;

    const detail = alertMode === "station"
      ? `${effectiveMin} min to section · ${train.nearStation || ""}`
      : `${train.minutesUntil} min by schedule`;

    escalateAlert(train.no, level, train, "schedule", detail);
  }
}

// ── Layer 2: Live API — fetch positions for all active trains ─────────────────

const livePositions = new Map(); // trainNo → { kmFromMAS, speed, direction, fetchedAt }

export async function fetchLivePositions() {
  if (!workSessionActive) return;
  // Use getConfig so the pre-baked key from config.js is used automatically
  const cfg = (window.getConfig) ? window.getConfig : (k) => localStorage.getItem(k) || "";
  const railRadarKey = cfg("railradar_key") || localStorage.getItem("railradar_key") || "";
  if (!railRadarKey) return; // No key = skip live, rely on schedule

  const trains = getActiveTrains().filter(t => t.alertLevel !== "PASSED").slice(0, 8);
  const fetches = trains.map(async (train) => {
    const cached = getCachedPosition(train.no);
    if (cached) {
      // Rehydrate cached position (90s TTL) into the live map
      livePositions.set(train.no, {
        kmFromMAS: cached.position,
        speed: train.speed,
        direction: train.dir,
        fetchedAt: cached.timestamp
      });
      return;
    }

    const liveData = await fetchLiveTrainStatus(train.no, railRadarKey);
    if (!liveData) return;

    const kmFromMAS = interpolateTrainPosition(
      liveData.lastStation,
      liveData.departureTime,
      train.speed,
      train.dir,
      liveData.delayMinutes
    );
    livePositions.set(train.no, { kmFromMAS, speed: train.speed, direction: train.dir, fetchedAt: Date.now() });
    setCachedPosition(train.no, kmFromMAS, null);
  });
  await Promise.allSettled(fetches);
}

// ── Layer 2: GPS distance check (every 15 sec) ───────────────────────────────

export async function checkByLiveGPS() {
  if (!workSessionActive) return;
  const workerGPS = window._lastGPS;
  if (!workerGPS) return; // No GPS available — schedule-only mode

  // Estimate worker's km from MAS using their GPS coordinates
  const workerKmFromMAS = gpsToKmFromMAS(workerGPS.lat, workerGPS.lon);

  const trains = getActiveTrains().filter(t => t.alertLevel !== "PASSED");

  // ── HARD GATE: skip trains beyond 120 min (same as checkBySchedule) ──
  // Prevents far-future/wrapped trains from producing phantom distances and
  // false "approaching" alerts when no live GPS data exists for them.
  const ALERT_HORIZON_MIN = 120;

  let nearestDistKm = Infinity;
  let nearestTrain  = null;

  for (const train of trains) {
    // ── SAFETY FIRST: train INSIDE the work section ─────────────────────────
    // No GPS calculation needed — if it's in the section, alert immediately.
    if (train.inSection) {
      escalateAlert(train.no, "CRITICAL", train, "live",
        "INSIDE SKM↔UPD section — clear the track");
      // Also count as nearest (0 km) for the distance panel
      if (nearestDistKm > 0) {
        nearestDistKm = 0;
        nearestTrain  = { ...train, distKm: 0 };
      }
      continue;
    }

    const livePos = livePositions.get(train.no);
    let trainKmFromMAS;

    if (livePos) {
      trainKmFromMAS = livePos.kmFromMAS;
    } else {
      // No live data — estimate from schedule, but ONLY if within horizon.
      // Far-future trains produce nonsense km estimates (hundreds of km away),
      // which the schedule path should have already excluded.
      const minUntil = train.minutesUntil;
      if (minUntil > ALERT_HORIZON_MIN) continue; // skip far trains
      const kmTraveled = (minUntil / 60) * train.speed;
      // DOWN train: has NOT reached SKM yet → it's north of SKM (higher km)
      // UP train:   has NOT reached SKM yet → it's south of SKM (lower km)
      trainKmFromMAS = train.dir === "D"
        ? workerKmFromMAS + kmTraveled   // still north of worker, approaching
        : workerKmFromMAS - kmTraveled;  // still south of worker, approaching
    }

    // ─────────────────────────────────────────────────────────────────────────
    // KEY SAFETY LOGIC: Only alert if the train is APPROACHING the worker.
    // If the train has already passed and is now receding (moving away),
    // it poses NO danger — skip it entirely.
    // ─────────────────────────────────────────────────────────────────────────
    const approaching = isTrainApproaching(trainKmFromMAS, workerKmFromMAS, train.dir);
    if (!approaching) {
      // Train has already passed this location — clear its alert state
      if (alertedTrains[train.no]) {
        delete alertedTrains[train.no];
      }
      continue; // No alert needed
    }

    // Calculate distance to worker
    const distKm = distanceToWorker(trainKmFromMAS, workerGPS.lat, workerGPS.lon);

    if (distKm < nearestDistKm) {
      nearestDistKm = distKm;
      nearestTrain  = { ...train, distKm };
    }

    // Fire alert if within threshold
    const distLevel = getDistanceAlertLevel(distKm);
    if (distLevel !== "OK") {
      escalateAlert(train.no, distLevel, train, "live",
        `${distKm.toFixed(1)} km away — approaching`);
    }
  }

  // Notify UI of nearest APPROACHING train
  if (onDistanceUpdate) {
    onDistanceUpdate(nearestTrain
      ? { train: nearestTrain, distKm: nearestDistKm }
      : null);
  }
}

// ── Alert Escalation ──────────────────────────────────────────────────────────

const LEVEL_RANK = { OK: 0, PREPARE: 1, WARN: 2, CRITICAL: 3 };

function escalateAlert(trainNo, level, train, source, detail) {
  const lastRank = LEVEL_RANK[alertedTrains[trainNo] || "OK"];
  const thisRank = LEVEL_RANK[level];
  if (thisRank <= lastRank) return; // Don't repeat or downgrade

  alertedTrains[trainNo] = level;
  fireAlert(train, level, source, detail);
  logAlert(trainNo, train.name, train.minutesUntil, level);
}

function fireAlert(train, level, source, detail) {
  playAlertTone(level);
  speakAlert(level, train.name, source);
  vibrateAlert(level);
  pushNotification(train, level, source);
  window.dispatchEvent(new CustomEvent("trainAlert", { detail: { train, level, source } }));
}

// ── Audio Engine ──────────────────────────────────────────────────────────────

let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

export function playAlertTone(level) {
  const ctx = getAudio();
  const configs = {
    PREPARE:  [{ f: 440, d: 0.5 }, { f: 550, d: 0.5 }],
    WARN:     [{ f: 660, d: 0.3 }, { f: 440, d: 0.3 }, { f: 660, d: 0.3 }, { f: 440, d: 0.3 }],
    CRITICAL: [{ f: 900, d: 0.2 }, { f: 440, d: 0.15 }, { f: 900, d: 0.2 }, { f: 440, d: 0.15 },
               { f: 900, d: 0.2 }, { f: 440, d: 0.15 }, { f: 1100, d: 0.5 }]
  };
  const tones = configs[level] || configs.PREPARE;
  let time = ctx.currentTime;
  tones.forEach(({ f, d }) => {
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f, time);
    gain.gain.setValueAtTime(level === "CRITICAL" ? 0.5 : 0.3, time);
    gain.gain.exponentialRampToValueAtTime(0.01, time + d);
    osc.start(time); osc.stop(time + d);
    time += d + 0.05;
  });
}

function speakAlert(level, trainName, source) {
  const msgs = {
    PREPARE:  `హెచ్చరిక! ${trainName} దగ్గరకు వస్తోంది. పని ఆపండి.`,
    WARN:     `జాగ్రత్త! ${trainName} 8 కిలోమీటర్లలో ఉంది. పరికరాలు పట్టాల నుండి తీయండి.`,
    CRITICAL: `అత్యవసరం! రైలు 4 కిలోమీటర్లలో ఉంది! అందరూ పట్టాలు వదలండి!`
  };
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(msgs[level]);
  u.lang = "te-IN"; u.rate = level === "CRITICAL" ? 1.4 : 1.0; u.volume = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function vibrateAlert(level) {
  if (!navigator.vibrate) return;
  const patterns = {
    PREPARE:  [300, 150, 300],
    WARN:     [400, 150, 400, 150, 400],
    CRITICAL: [600, 200, 600, 200, 1000, 200, 600, 200, 600]
  };
  navigator.vibrate(patterns[level] || [300]);
}

function pushNotification(train, level, source) {
  if (Notification.permission !== "granted") return;
  const msgs = {
    PREPARE:  { title: `⚠️ ${train.name} — Approaching (${source})`,          body: `Train is within 15 km. Prepare to clear the track.` },
    WARN:     { title: `🟠 ${train.name} — 8 km away!`,                       body: `${source === "live" ? "Live GPS:" : "Schedule:"} Move all tools off track NOW.` },
    CRITICAL: { title: `🚨 CLEAR TRACK! ${train.name} — ${source === "live" ? "4 km" : "< 7 min"}!`, body: `ALL WORKERS OFF THE TRACK IMMEDIATELY!` }
  };
  const msg = msgs[level];
  if (msg) {
    new Notification(msg.title, { body: msg.body, icon: "icons/icon-192.png",
      tag: `train-${train.no}`, requireInteraction: level === "CRITICAL" });
  }
}

// ── Exports for UI ────────────────────────────────────────────────────────────

export async function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission();
  }
}

export function getLivePosition(trainNo) {
  return livePositions.get(trainNo) || null;
}

export function getLivePositionsMap() {
  return livePositions;
}
