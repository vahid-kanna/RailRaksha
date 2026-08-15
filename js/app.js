/**
 * RailRaksha — Main App Controller v2 (app.js)
 * Big session button, live GPS distance display, session timer.
 */

import {
  startWorkSession, stopWorkSession, checkBySchedule, isWorkSessionActive,
  getSessionStartTime, setTrainsUpdateCallback, setDistanceUpdateCallback,
  requestNotificationPermission, playAlertTone
} from './train-alert.js';
import { getActiveTrains } from './timetable-data.js';
import { DIST_THRESHOLDS } from './live-trains.js';
import { initDefectReport }  from './defect-report.js';
import { initGangDiary }     from './gang-diary.js';
import { initWeatherAlert }  from './weather-alert.js';
import { initPWManual }      from './pw-manual.js';
import { openDB, getSetting, setSetting } from './db.js';
import { applyDefaultsOnce, getConfig } from './config.js';
import { Icons, getStatusIcon, TrainTypeIcons } from './icons.js';

// Make getConfig available globally for other modules
window.getConfig = getConfig;

// ── State ─────────────────────────────────────────────────────────────────────
let timerInterval = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  // Apply default API keys on first load (only fills empty localStorage slots)
  applyDefaultsOnce();
  await openDB();
  loadSettings();
  updateHeaderName();
  setupNavigation();
  setupSettings();
  setupSessionButton();
  setupToastSystem();
  setupTrainAlertUI();
  startGPSTracking();
  await requestNotificationPermission();

  // Restore session state if it was active before page reload
  const wasActive = await getSetting("work_session_active", false);
  if (wasActive) {
    await activateSession();
    // Restore timer start time if stored
    const storedStart = await getSetting("session_start_time", null);
    if (storedStart) {
      // Override the session start in train-alert (can't easily, so just use stored)
      window._sessionStartOverride = new Date(storedStart);
    }
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.screen));
  });
}

function navigateTo(screenId) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`screen-${screenId}`)?.classList.add("active");
  document.querySelector(`.nav-btn[data-screen="${screenId}"]`)?.classList.add("active");

  if (screenId === "defect"  && !window._defectInit)  { initDefectReport(getDefectElements());  window._defectInit  = true; }
  if (screenId === "diary"   && !window._diaryInit)   { initGangDiary(getDiaryElements());      window._diaryInit   = true; }
  if (screenId === "weather" && !window._weatherInit) { initWeatherAlert(getWeatherElements()); window._weatherInit = true; }
  if (screenId === "manual"  && !window._manualInit)  { initPWManual(getManualElements());      window._manualInit  = true; }
}

// ── Session Button ────────────────────────────────────────────────────────────
function setupSessionButton() {
  document.getElementById("session-mega-btn")?.addEventListener("click", toggleSession);
}

async function toggleSession() {
  // Unlock audio on first user gesture (required by browsers)
  playAlertTone("PREPARE");

  if (isWorkSessionActive()) {
    await deactivateSession();
  } else {
    await activateSession();
  }
}

async function activateSession() {
  await startWorkSession();
  await setSetting("work_session_active", true);
  await setSetting("session_start_time", new Date().toISOString());

  // Update button UI → ON
  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-off");
  btn?.classList.add("session-on");

  document.getElementById("smb-icon").innerHTML  = Icons.shield(24, '#10B981');
  document.getElementById("smb-dot").className     = "smb-status-dot dot-on";
  document.getElementById("smb-title").textContent = "MONITORING ACTIVE";
  document.getElementById("smb-sub").textContent   = "Train alerts ON — tap to end when leaving track";
  document.getElementById("smb-right").style.display = "flex";
  document.getElementById("smb-right").style.flexDirection = "column";
  document.getElementById("smb-right").style.alignItems = "flex-end";

  // Show live distance panel
  document.getElementById("live-distance-panel")?.classList.add("visible");

  // Start session timer
  startSessionTimer();

  showToast("Work session started — train alerts active!", "ok");
}

async function deactivateSession() {
  stopWorkSession();
  await setSetting("work_session_active", false);
  await setSetting("session_start_time", null);

  // Update button UI → OFF
  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-on", "session-danger");
  btn?.classList.add("session-off");

  document.getElementById("smb-icon").innerHTML  = Icons.shield(24, '#94A3B8');
  document.getElementById("smb-dot").className     = "smb-status-dot dot-off";
  document.getElementById("smb-title").textContent = "START WORK SESSION";
  document.getElementById("smb-sub").textContent   = "Tap when you go on track — alerts will activate";
  document.getElementById("smb-right").style.display = "none";

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  document.getElementById("smb-last").textContent = `Last session ended: ${timeStr}`;

  // Hide live distance panel
  document.getElementById("live-distance-panel")?.classList.remove("visible");

  // Stop timer
  clearInterval(timerInterval);

  // Reset track status
  updateStatusHero("OK", null);
  document.getElementById("train-list").innerHTML =
    `<div class="empty-state"><div class="es-icon">${Icons.shield(40, '#94A3B8')}</div>
     <div class="es-title">Session ended</div>
     <div class="es-sub">Tap "Start Work Session" when back on the track.</div></div>`;

  showToast("Work session ended. Stay safe!", "ok");
}

// ── Session Timer ─────────────────────────────────────────────────────────────
function startSessionTimer() {
  const startTime = new Date();
  timerInterval = setInterval(() => {
    const elapsedMs  = Date.now() - startTime.getTime();
    const totalSec   = Math.floor(elapsedMs / 1000);
    const hours      = Math.floor(totalSec / 3600);
    const minutes    = Math.floor((totalSec % 3600) / 60);
    const seconds    = totalSec % 60;
    const timerEl    = document.getElementById("smb-timer");
    if (timerEl) {
      timerEl.textContent = hours > 0
        ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
        : `${pad(minutes)}:${pad(seconds)}`;
    }
  }, 1000);
}
function pad(n) { return String(n).padStart(2, "0"); }

// ── Train Alert Screen ────────────────────────────────────────────────────────
function setupTrainAlertUI() {
  setTrainsUpdateCallback(renderTrainList);
  setDistanceUpdateCallback(renderLiveDistance);

  document.getElementById("btn-refresh-trains")?.addEventListener("click", () => {
    checkBySchedule();
    showToast("Refreshed", "ok");
  });

  window.addEventListener("trainAlert", (e) => {
    const { train, level } = e.detail;
    showEmergencyBanner(train, level);
    // Flash session button
    flashSessionBtn(level);
  });

  // Initial render (offline timetable)
  renderTrainList(getActiveTrains());
}

function flashSessionBtn(level) {
  const btn = document.getElementById("session-mega-btn");
  if (!btn || !isWorkSessionActive()) return;
  if (level === "CRITICAL") {
    btn.classList.add("session-danger");
    document.getElementById("smb-dot").className = "smb-status-dot dot-crit";
    document.getElementById("smb-icon").innerHTML = Icons.siren(24, '#EF4444');
  } else if (level === "WARN") {
    btn.classList.remove("session-danger");
    document.getElementById("smb-dot").className = "smb-status-dot dot-warn";
    document.getElementById("smb-icon").innerHTML = Icons.alertCircle(24, '#F97316');
  }
}

// ── Display horizon: how far ahead to SHOW trains in the list ─────────────────
// Trains beyond this are irrelevant right now — they caused the "985 min" clutter.
const DISPLAY_HORIZON_MIN = 120; // 2 hours ahead max

function renderTrainList(trains) {
  const list = document.getElementById("train-list");
  if (!list) return;

  // Split: trains worth showing now vs far-future trains (tomorrow's wrap etc.)
  const relevant   = trains.filter(t => t.inSection || t.effectiveMin <= DISPLAY_HORIZON_MIN);
  const laterCount = trains.length - relevant.length;

  const nearest = relevant[0];
  const level   = nearest?.alertLevel || "OK";
  updateStatusHero(level, nearest);

  // Sync status
  const dot  = document.getElementById("sync-dot");
  const text = document.getElementById("sync-text");
  if (dot)  dot.className  = `sync-dot ${navigator.onLine ? "online" : "offline"}`;
  if (text) text.textContent = navigator.onLine
    ? `Live data: synced ${new Date().toLocaleTimeString("en-IN")}`
    : "Offline — timetable only";

  list.innerHTML = "";
  if (trains.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">${Icons.train(48, '#64748B')}</div>
      <div class="es-title">No more trains today</div>
      <div class="es-sub">All scheduled trains have passed. Resume carefully.</div></div>`;
    return;
  }
  if (relevant.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">${Icons.check(48, '#10B981')}</div>
      <div class="es-title">No trains in the next 2 hours</div>
      <div class="es-sub">Next train is ${laterCount > 0 ? "more than 2 hours away" : "not scheduled soon"}. Maintain vigilance.</div></div>`;
    return;
  }
  relevant.slice(0, 12).forEach((train, i) => {
    const card = createTrainCard(train);
    card.style.animationDelay = `${i * 0.04}s`;
    list.appendChild(card);
  });

  // Collapse far-future trains into one quiet line
  if (laterCount > 0) {
    const footer = document.createElement("div");
    footer.style.cssText = "text-align:center;font-size:11px;color:var(--text-sub);padding:10px 0;opacity:0.7;";
    footer.textContent = `+ ${laterCount} more train${laterCount > 1 ? "s" : ""} later today`;
    list.appendChild(footer);
  }
}

function renderLiveDistance(data) {
  const panel     = document.getElementById("live-distance-panel");
  const distEl    = document.getElementById("ldp-distance");
  const nameEl    = document.getElementById("ldp-train-name");
  const badgeEl   = document.getElementById("ldp-source-badge");
  if (!panel || !distEl) return;

  const alertMode = getConfig("alert_mode") || "station";

  if (!data) {
    distEl.textContent  = alertMode === "station"
      ? "All clear — no trains approaching SKM↔UPD section"
      : "All clear — no trains within 15 km";
    distEl.className    = "ldp-value dist-safe";
    nameEl.textContent  = alertMode === "station"
      ? "📡 Station Mode · Timetable + station tracking"
      : "Based on live GPS + timetable data";
    badgeEl.textContent = alertMode === "station" ? "STATION" : "TIMETABLE";
    badgeEl.className   = "ldp-badge sched";
    return;
  }

  const { train, distKm } = data;
  const isLive = !!localStorage.getItem("railradar_key");

  if (alertMode === "station") {
    if (train.inSection) {
      distEl.textContent = "IN SECTION!";
      distEl.className   = "ldp-value dist-crit";
    } else {
      const workMin = train.minutesToWork ?? train.minutesUntil;
      distEl.textContent = workMin <= 0 ? "IN SECTION!" : `${workMin} min to section`;
      distEl.className   = workMin <= 4 ? "ldp-value dist-crit" : workMin <= 8 ? "ldp-value dist-warn" : "ldp-value dist-prepare";
    }
    nameEl.textContent  = `${train.name} (#${train.no}) · ${train.nearStation || ""} · ${train.dir === "D" ? "↓ GDR" : "↑ BZA"}`;
    badgeEl.textContent = isLive ? "LIVE+STATION" : "STATION";
    badgeEl.className   = `ldp-badge ${isLive ? "live" : "sched"}`;
  } else {
    distEl.textContent = `${distKm.toFixed(1)} km away`;
    nameEl.textContent = `${train.name} (${train.no}) — ${train.dir === "D" ? "↓ towards Chennai" : "↑ towards Vijayawada"}`;
    badgeEl.textContent = isLive ? "LIVE GPS" : "TIMETABLE";
    badgeEl.className   = `ldp-badge ${isLive ? "live" : "sched"}`;
  }

  // Color by distance
  if (distKm <= DIST_THRESHOLDS.CRITICAL) {
    distEl.className = "ldp-value dist-crit";
  } else if (distKm <= DIST_THRESHOLDS.WARN) {
    distEl.className = "ldp-value dist-warn";
  } else if (distKm <= DIST_THRESHOLDS.PREPARE) {
    distEl.className = "ldp-value dist-prepare";
  } else {
    distEl.className = "ldp-value dist-safe";
  }
}

function updateStatusHero(level, nearestTrain) {
  const hero = document.getElementById("track-status-hero");
  if (!hero) return;

  // If the nearest relevant train is beyond 120 min, show TRACK CLEAR instead
  const effectiveMin = nearestTrain?.effectiveMin ?? Infinity;
  if (!nearestTrain?.inSection && effectiveMin > DISPLAY_HORIZON_MIN) {
    level = "OK";
    nearestTrain = null;
  }

  hero.className = `track-status-hero status-${
    level === "OK" ? "clear" : level === "CRITICAL" ? "danger" : "caution"}`;

  const alertMode = getConfig("alert_mode") || "station";
  const modeLabel = alertMode === "station" ? "Station Mode" : "GPS Mode";
  const workMin = nearestTrain?.minutesToWork ?? nearestTrain?.minutesUntil;

  const cfg = {
    OK:       { icon: Icons.check(32, '#10B981'), label: "TRACK SAFE",        sub: isWorkSessionActive() ? `${modeLabel} · SKM↔UPD section clear` : "Start session to enable alerts" },
    PREPARE:  { icon: Icons.alert(32, '#F59E0B'), label: "TRAIN APPROACHING", sub: `${nearestTrain?.name} · ${workMin} min to section · ${nearestTrain?.nearStation || ""}` },
    WARN:     { icon: Icons.alertCircle(32, '#F97316'), label: "MOVE OFF TRACK",   sub: `${nearestTrain?.name} · ${workMin} min · Move all tools off track NOW` },
    CRITICAL: { icon: Icons.siren(32, '#EF4444'), label: "CLEAR TRACK NOW!", sub: `${nearestTrain?.name} · ALL WORKERS OFF TRACK IMMEDIATELY!` }
  }[level] || { icon: Icons.check(32, '#10B981'), label: "TRACK SAFE", sub: "" };

  document.getElementById("status-icon").innerHTML    = cfg.icon;
  document.getElementById("status-label").textContent   = cfg.label;
  document.getElementById("status-sublabel").textContent = cfg.sub;
}

function createTrainCard(train) {
  const card = document.createElement("div");
  const alertClass = { CRITICAL:"alert-critical", WARN:"alert-warn", PREPARE:"alert-caution", OK:"alert-ok", PASSED:"alert-passed" }[train.alertLevel] || "alert-ok";
  card.className = `train-card ${alertClass} slide-in-up`;

  const typeIcons = { 
    RAJDHANI: Icons.crown(16, '#FFD700'), 
    SHATABDI: Icons.lightning(16, '#00D9FF'), 
    VANDE_BHARAT: Icons.medal(16, '#FF6B00'), 
    DURONTO: Icons.wind(16, '#06B6D4'), 
    MAIL: Icons.mail(16, '#94A3B8'), 
    JAN_SHATABDI: Icons.ticket(16, '#F59E0B'), 
    FREIGHT: Icons.truck(16, '#EF4444'), 
    EXPRESS: Icons.train(16, '#10B981'), 
    PASSENGER: Icons.train(16, '#64748B') 
  };
  const dirClass  = train.dir === "D" ? "dir-down" : "dir-up";

  // Timing display — show work section ETA if in station mode
  const alertMode = getConfig("alert_mode") || "station";
  const workEta = train.minutesToWork !== undefined ? train.minutesToWork : train.minutesUntil;
  const etaLabel = alertMode === "station" ? "to section" : "to SKM";

  let etaDisplay;
  if (train.inSection) {
    etaDisplay = `<span class="time-to-arrival" style="font-size:15px;color:#ef4444;font-weight:900;">IN SECTION</span>`;
  } else if (train.minutesUntil <= 0) {
    etaDisplay = `<span class="time-to-arrival" style="font-size:13px;">PASSED</span>`;
  } else {
    const displayMin = alertMode === "station" ? Math.max(0, workEta) : train.minutesUntil;
    etaDisplay = `<span class="time-to-arrival">${displayMin}</span><div class="time-unit">min ${etaLabel}</div>`;
  }

  // Non-stopping trains are most dangerous — show warning badge
  const stopBadge = train.stops === false
    ? `<div style="background:rgba(239,68,68,0.2);color:#ef4444;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;margin-top:2px;">${Icons.lightning(10, '#EF4444')} NON-STOP · ${train.speed} km/h</div>`
    : `<div style="background:rgba(16,185,129,0.15);color:#10b981;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;margin-top:2px;">STOPS at SKM</div>`;

  // Station estimation badge
  const stationBadge = train.nearStation
    ? `<div style="font-size:10px;color:var(--text-sub);margin-top:2px;">${Icons.location(10, '#94A3B8')} ${train.nearStation} · ~${train.kmFromSKM} km</div>`
    : "";

  card.innerHTML = `
    <div class="train-dir-badge ${dirClass}">
      <span class="dir-icon">${train.dir === "D" ? Icons.arrowDown(14, 'currentColor') : Icons.arrowUp(14, 'currentColor')}</span>
      <span>${train.dir === "D" ? "↓ GDR" : "↑ BZA"}</span>
    </div>
    <div class="train-info">
      <div class="train-name">${typeIcons[train.type] || Icons.train(16, '#10B981')} ${train.name}</div>
      <div class="train-number">#${train.no} · ${train.type}</div>
      <div class="train-route">${train.from} → ${train.to}</div>
      ${stopBadge}
      ${stationBadge}
    </div>
    <div class="train-timing">${etaDisplay}<div class="scheduled-time">SKM: ${train.time}</div></div>`;
  return card;
}

function showEmergencyBanner(train, level) {
  const banner = document.getElementById("emergency-banner");
  if (!banner) return;
  const alertMode = getConfig("alert_mode") || "station";
  const etaMin = train?.inSection ? null : (alertMode === "station" ? (train?.minutesToWork ?? train?.minutesUntil) : train?.minutesUntil);
  const etaText = etaMin === null ? "IN SECTION" : `${etaMin} min`;
  const msgs = {
    PREPARE:  { icon: Icons.alert(40, '#F59E0B'), title: `Train approaching — ${etaText}`, sub: `${train?.name} — Prepare to clear track` },
    WARN:     { icon: Icons.alertCircle(40, '#F97316'), title: `ALERT — Move off track!`, sub: `${train?.name} — Tools off track NOW!` },
    CRITICAL: { icon: Icons.siren(40, '#EF4444'), title: "CLEAR TRACK NOW!", sub: `${train?.name} — ALL WORKERS OFF TRACK!` }
  }[level] || {};
  banner.querySelector(".emergency-icon").innerHTML    = msgs.icon  || Icons.siren(40, '#EF4444');
  banner.querySelector(".emergency-title").textContent   = msgs.title || "";
  banner.querySelector(".emergency-subtitle").textContent = msgs.sub  || "";
  banner.classList.add("active");
  setTimeout(() => banner.classList.remove("active"), level === "CRITICAL" ? 30000 : 12000);
}

// ── GPS Tracking ──────────────────────────────────────────────────────────────
function startGPSTracking() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      window._lastGPS = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      const gpsEl = document.getElementById("gps-label");
      if (gpsEl) gpsEl.innerHTML = `${Icons.location(16, 'currentColor')} ${pos.coords.latitude.toFixed(4)}°N`;
    },
    () => { window._lastGPS = null; },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
  );
}

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
  const fields = [
    "mate_name", "gang_no", "gang_strength", "section",
    "alert_mode", "work_station_a", "work_station_b",
    "ai_provider", "ai_api_key", "ai_base_url", "ai_model",
    "owm_api_key", "railradar_key",
    "alert_dist_critical", "alert_dist_warn", "alert_dist_prepare",
    "alert_min_critical",  "alert_min_warn",  "alert_min_prepare"
  ];
  fields.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) {
      // Use getConfig so pre-baked defaults appear even if localStorage is empty
      const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
      if (key === "ai_base_url") {
        el.value = cfg(key) || "https://router.bynara.id/v1";
      } else if (key === "ai_model") {
        el.value = cfg(key) || "mistral-medium-3-5";
      } else if (key === "ai_provider") {
        el.value = cfg(key) || "openai_compatible";
      } else if (key === "alert_mode") {
        el.value = cfg(key) || "station";
      } else if (key === "work_station_a") {
        el.value = cfg(key) || "SKM";
      } else if (key === "work_station_b") {
        el.value = cfg(key) || "UPD";
      } else {
        el.value = cfg(key) || "";
      }
    }
  });
  
  // Set up password-protected API keys section
  setupApiKeysSection();
}

const MASTER_PASSWORD = "Basha@1976";

function setupApiKeysSection() {
  const toggleBtn = document.getElementById("btn-toggle-api-keys");
  const lockedDiv = document.getElementById("api-keys-locked");
  const unlockedDiv = document.getElementById("api-keys-unlocked");
  const visibilityBtns = document.querySelectorAll(".btn-toggle-visibility");
  
  if (!toggleBtn || !lockedDiv || !unlockedDiv) return;
  
  let isUnlocked = false;
  
  toggleBtn.addEventListener("click", () => {
    if (!isUnlocked) {
      // Prompt for password
      const entered = prompt("Enter password to view/edit API keys:");
      if (entered === MASTER_PASSWORD) {
        isUnlocked = true;
        lockedDiv.style.display = "none";
        unlockedDiv.style.display = "block";
        toggleBtn.textContent = "Hide Keys";
        toggleBtn.classList.remove("btn-secondary");
        toggleBtn.style.background = "rgba(239,68,68,0.2)";
        toggleBtn.style.borderColor = "rgba(239,68,68,0.5)";
        toggleBtn.style.color = "#FCA5A5";
        
        // Fill in current values
        fillApiKeyFields();
      } else if (entered !== null) {
        showToast("Incorrect password", "error");
      }
    } else {
      // Lock again
      isUnlocked = false;
      lockedDiv.style.display = "block";
      unlockedDiv.style.display = "none";
      toggleBtn.textContent = "Show Keys";
      toggleBtn.classList.add("btn-secondary");
      toggleBtn.style.background = "";
      toggleBtn.style.borderColor = "";
      toggleBtn.style.color = "";
    }
  });
  
  // Toggle visibility buttons
  visibilityBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target;
      const input = document.getElementById(targetId);
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
      } else {
        input.type = "password";
        btn.textContent = "Show";
      }
    });
  });
}

function fillApiKeyFields() {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  
  document.getElementById("setting-ai_provider").value = cfg("ai_provider") || "openai_compatible";
  document.getElementById("setting-ai_model").value = cfg("ai_model") || "mistral-medium-3-5";
  document.getElementById("setting-ai_base_url").value = cfg("ai_base_url") || "https://router.bynara.id/v1";
  document.getElementById("setting-ai_api_key").value = cfg("ai_api_key") || "";
  document.getElementById("setting-owm_api_key").value = cfg("owm_api_key") || "";
  document.getElementById("setting-railradar_key").value = cfg("railradar_key") || "";
}

function setupSettings() {
  document.getElementById("btn-settings")?.addEventListener("click", () => document.getElementById("settings-overlay")?.classList.add("active"));
  document.getElementById("btn-close-settings")?.addEventListener("click", () => document.getElementById("settings-overlay")?.classList.remove("active"));
  document.getElementById("btn-save-settings")?.addEventListener("click", saveSettings);
  document.getElementById("settings-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "settings-overlay") document.getElementById("settings-overlay").classList.remove("active");
  });
}

function saveSettings() {
  const fields = [
    "mate_name", "gang_no", "gang_strength", "section",
    "alert_mode", "work_station_a", "work_station_b",
    "ai_provider", "ai_api_key", "ai_base_url", "ai_model",
    "owm_api_key", "railradar_key",
    "alert_dist_critical", "alert_dist_warn", "alert_dist_prepare",
    "alert_min_critical",  "alert_min_warn",  "alert_min_prepare"
  ];
  fields.forEach(key => {
    const val = document.getElementById(`setting-${key}`)?.value?.trim() || "";
    localStorage.setItem(key, val);
  });
  document.getElementById("settings-overlay")?.classList.remove("active");
  showToast("Settings saved!", "ok");
  updateHeaderName();
}


function updateHeaderName() {
  const name = localStorage.getItem("mate_name") || "";
  const gang = localStorage.getItem("gang_no") || "";
  const el   = document.getElementById("header-subtitle");
  if (el && name) el.textContent = `${name}${gang ? " · Gang " + gang : ""} · SKM`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function setupToastSystem() {
  window.addEventListener("showToast", (e) => showToast(e.detail.msg, e.detail.type));
}
function showToast(msg, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  const icons = { 
    ok: Icons.check(20, '#10B981'), 
    warn: Icons.alert(20, '#F59E0B'), 
    error: Icons.alertCircle(20, '#EF4444'), 
    info: Icons.info(20, '#06B6D4') 
  };
  toast.querySelector(".toast-icon").innerHTML = icons[type] || Icons.info(20, '#06B6D4');
  toast.querySelector(".toast-msg").textContent  = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

// ── Element Getters ───────────────────────────────────────────────────────────
function getDefectElements() {
  return {
    captureZone: document.getElementById("capture-zone"),
    fileInput: document.getElementById("defect-file-input"),
    uploadInput: document.getElementById("defect-upload-input"),
    btnCamera: document.getElementById("btn-camera"),
    btnUpload: document.getElementById("btn-upload"),
    imagePreview: document.getElementById("captured-image-preview"),
    captureIcon: document.getElementById("capture-icon"),
    captureText: document.getElementById("capture-text"),
    btnAnalyze: document.getElementById("btn-analyze-defect"),
    defectAnalysisCard: document.getElementById("defect-analysis-card"),
    defectTypeBadge: document.getElementById("defect-type-badge"),
    detailSeverity: document.getElementById("detail-severity"),
    detailConfidence: document.getElementById("detail-confidence"),
    detailIRPWM: document.getElementById("detail-irpwm"),
    detailSpeed: document.getElementById("detail-speed"),
    detailGPS: document.getElementById("detail-gps"),
    detailTime: document.getElementById("detail-time"),
    detailDescription: document.getElementById("detail-description"),
    recommendedAction: document.getElementById("recommended-action"),
    irpwmReference: document.getElementById("irpwm-reference"),
    btnShareReport: document.getElementById("btn-share-report"),
    btnNewDefect: document.getElementById("btn-new-defect"),
    defectHistoryList: document.getElementById("defect-history-list")
  };
}
function getDiaryElements() {
  return {
    diaryDateText: document.getElementById("diary-date-text"),
    diaryGangInfo: document.getElementById("diary-gang-info"),
    attendanceInput: document.getElementById("attendance-input"),
    attendanceCount: document.getElementById("attendance-count"),
    attendanceBar: document.getElementById("attendance-bar"),
    attendanceSub: document.getElementById("attendance-sub"),
    btnRecord: document.getElementById("btn-record"),
    voiceTitle: document.getElementById("voice-title"),
    voiceSub: document.getElementById("voice-sub"),
    micEmoji: document.getElementById("mic-emoji"),
    transcriptionCard: document.getElementById("transcription-card"),
    transcriptionText: document.getElementById("transcription-text"),
    btnGenerateDiary: document.getElementById("btn-generate-diary"),
    diaryEntryCard: document.getElementById("diary-entry-card"),
    entryDate: document.getElementById("entry-date"),
    entryTime: document.getElementById("entry-time"),
    entryGang: document.getElementById("entry-gang"),
    entryAttendance: document.getElementById("entry-attendance"),
    entryWorkDone: document.getElementById("entry-work-done"),
    entryMaterials: document.getElementById("entry-materials"),
    entryDefects: document.getElementById("entry-defects"),
    entrySafety: document.getElementById("entry-safety"),
    entrySpecial: document.getElementById("entry-special"),
    entryRemarks: document.getElementById("entry-remarks"),
    entryTelugu: document.getElementById("entry-telugu"),
    btnSaveDiary: document.getElementById("btn-save-diary"),
    btnShareDiary: document.getElementById("btn-share-diary"),
    todayEntriesCount: document.getElementById("today-entries-count")
  };
}
function getWeatherElements() {
  return {
    weatherIcon: document.getElementById("weather-icon-large"),
    weatherTemp: document.getElementById("weather-temp"),
    weatherDesc: document.getElementById("weather-desc"),
    weatherHumidity: document.getElementById("weather-humidity"),
    weatherWind: document.getElementById("weather-wind"),
    weatherRain: document.getElementById("weather-rain"),
    riskList: document.getElementById("risk-list"),
    btnRefreshWeather: document.getElementById("btn-refresh-weather")
  };
}
function getManualElements() {
  return {
    searchInput: document.getElementById("manual-search-input"),
    btnSearch: document.getElementById("btn-manual-search"),
    btnVoiceSearch: document.getElementById("btn-voice-search"),
    manualAnswerCard: document.getElementById("manual-answer-card"),
    maaTitle: document.getElementById("maa-title"),
    maaBody: document.getElementById("maa-body"),
    maaSource: document.getElementById("maa-source"),
    quickRulesList: document.getElementById("quick-rules-list")
  };
}
