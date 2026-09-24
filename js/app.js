/**
 * RailRaksha — Main App Controller v5.0 (app.js)
 * Enterprise-grade safety HUD:
 *  - 1-Tap Direction-Aware Track Selector (UP / DOWN / BOTH)
 *  - 4-State Resilient GPS Tracker with Along-Track Kalman Filter & Manual Beat Nudge
 *  - Continuous Chainage Schedule Math & Delay-Corrected Position Envelope
 *  - Single-Voice Bilingual (Telugu + English) Threat Orchestrator & Multi-Frequency Siren
 *  - Dual-Rail Live Proximity Radar SVG
 *  - Complete integration with Defect Reporter, Gang Diary, Weather Alert & P-Way Manual
 */

import { STATIONS, STATION_BY_CODE } from './corridor.js';
import { GpsTracker, GPS_STATE } from './gps-tracker.js';
import { LiveTrainService } from './live-trains.js';
import {
  ThreatEngine, AlertOrchestrator, VoiceManager, SirenManager, HapticManager, Notifier,
  LEVEL, LEVEL_NAME, TRACK_MODE
} from './train-alert.js';

import { initDefectReport }  from './defect-report.js';
import { initGangDiary }     from './gang-diary.js';
import { initWeatherAlert }  from './weather-alert.js';
import { initPWManual }      from './pw-manual.js';
import { openDB, getSetting, setSetting } from './db.js';
import { applyDefaultsOnce, getConfig } from './config.js';
import { Icons } from './icons.js';

window.getConfig = getConfig;

// ── State & Storage ──────────────────────────────────────────────────────────
const store = {
  get mode() { return localStorage.getItem('rr.trackMode') || TRACK_MODE.BOTH; },
  set mode(v) { localStorage.setItem('rr.trackMode', v); },
  get lang() { return localStorage.getItem('rr.lang') || 'te+en'; },
};

// ── Upstream Live Train Provider ─────────────────────────────────────────────
async function fetchLive(trainNo, runDateISO, signal) {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  const railradarKey = cfg("railradar_key") || localStorage.getItem("railradar_key") || "";
  
  // Try proxy first if hosted on Vercel
  try {
    const r = await fetch(`/api/live-status?train=${encodeURIComponent(trainNo)}&date=${runDateISO}`, { signal, cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch {}

  // Direct RailRadar API fallback if API key is configured
  if (railradarKey) {
    try {
      const resp = await fetch(`https://api.railradar.in/v2/trains/${trainNo}/status`, {
        headers: { "Authorization": `Bearer ${railradarKey}`, "Accept": "application/json" },
        signal
      });
      if (resp.ok) {
        const d = await resp.json();
        const b = d?.data || d;
        const stations = b?.stations || b?.stationList || [];
        let lastPassed = null;
        for (const st of stations) {
          const act = st.actualDepartureTime || st.actDep || st.actualDep || st.departedAt;
          if (act && act !== "--" && act !== "00:00") lastPassed = st;
        }
        if (!lastPassed && (b?.currentStation || b?.lastStation)) {
          const cur = b.currentStation || b.lastStation;
          lastPassed = { stationCode: cur.code || cur.stationCode || cur, actualDepartureTime: cur.departureTime };
        }
        if (lastPassed) {
          return {
            last_station_code: (lastPassed.stationCode || lastPassed.stnCode || lastPassed.code || "").toUpperCase(),
            delay_min: parseInt(b?.delay || b?.delayInMinutes || lastPassed.delay || "0") || 0,
            actual_departure: lastPassed.actualDepartureTime || lastPassed.actDep || null,
            speed_kmh: b?.speed || null,
            updated_at: new Date().toISOString()
          };
        }
      }
    } catch {}
  }
  throw new Error("No live feed data");
}

// ── Instantiate Safety Engines ───────────────────────────────────────────────
const gps = new GpsTracker();
const live = new LiveTrainService({ fetchLive });
const engine = new ThreatEngine();
const siren = new SirenManager();
const orchestrator = new AlertOrchestrator({
  voice: new VoiceManager({ lang: store.lang }),
  siren,
  haptics: new HapticManager(),
  notifier: new Notifier(),
});
engine.setMode(store.mode);

let armed = false;
let wakeLock = null;
let timerInterval = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  applyDefaultsOnce();
  await openDB();
  loadSettings();
  updateHeaderName();
  setupNavigation();
  setupSettings();
  setupToastSystem();
  bindTrackSelector();
  bindBeatPicker();
  setupSessionButton();
  setupAcknowledgeButton();

  // Periodic safety tick (1 Hz)
  setInterval(loop, 1000);
  // Live API poll interval
  setInterval(() => {
    const w = gps.getPosition();
    live.poll(w?.km);
  }, 12000);

  // Initial render
  loop();

  // Restore work session if previously active
  const wasActive = await getSetting("work_session_active", false);
  if (wasActive) {
    await activateSession();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
});

// ── Arming & Session Control ──────────────────────────────────────────────────
function setupSessionButton() {
  document.getElementById("session-mega-btn")?.addEventListener("click", toggleSession);
}

function setupAcknowledgeButton() {
  document.getElementById("ack")?.addEventListener("click", () => {
    orchestrator.acknowledge();
    navigator.vibrate?.(60);
    loop();
    showToast("Alarm silenced for 45s (critical voice continues)", "info");
  });
}

async function toggleSession() {
  if (armed) {
    await deactivateSession();
  } else {
    await activateSession();
  }
}

async function activateSession() {
  siren.unlock();
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
  
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  // Android Chrome TTS unlock
  if ("speechSynthesis" in window) {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  }

  armed = true;
  document.body.dataset.armed = "true";
  gps.start();

  await setSetting("work_session_active", true);
  await setSetting("session_start_time", new Date().toISOString());

  // Update button UI -> ON
  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-off");
  btn?.classList.add("session-on");

  document.getElementById("smb-icon").innerHTML = Icons.shield(24, "#10B981");
  document.getElementById("smb-dot").className = "smb-status-dot dot-on";
  document.getElementById("smb-title").textContent = "MONITORING ACTIVE";
  document.getElementById("smb-sub").textContent = "Track safety active — sirens & voice enabled";
  const smbRight = document.getElementById("smb-right");
  if (smbRight) {
    smbRight.style.display = "flex";
    smbRight.style.flexDirection = "column";
    smbRight.style.alignItems = "flex-end";
  }

  startSessionTimer();
  loop();
  showToast("Work session started — track safety active!", "ok");
}

async function deactivateSession() {
  armed = false;
  document.body.dataset.armed = "false";
  gps.stop();
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  await setSetting("work_session_active", false);
  await setSetting("session_start_time", null);

  // Update button UI -> OFF
  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-on", "session-danger");
  btn?.classList.add("session-off");

  document.getElementById("smb-icon").innerHTML = Icons.shield(24, "#94A3B8");
  document.getElementById("smb-dot").className = "smb-status-dot dot-off";
  document.getElementById("smb-title").textContent = "START WORK SESSION";
  document.getElementById("smb-sub").textContent = "Tap when on track — enables sirens, audio & live GPS alerts";
  const smbRight = document.getElementById("smb-right");
  if (smbRight) smbRight.style.display = "none";

  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const smbLast = document.getElementById("smb-last");
  if (smbLast) smbLast.textContent = `Last session ended: ${timeStr}`;

  clearInterval(timerInterval);
  loop();
  showToast("Work session ended. Stay safe!", "ok");
}

function startSessionTimer() {
  const startTime = new Date();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsedMs = Date.now() - startTime.getTime();
    const totalSec = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    const timerEl = document.getElementById("smb-timer");
    if (timerEl) {
      timerEl.textContent = hours > 0
        ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
  }, 1000);
}

// ── Controls & Track Switcher ────────────────────────────────────────────────
function bindTrackSelector() {
  document.querySelectorAll("[data-track]").forEach(btn => {
    btn.addEventListener("click", () => {
      engine.setMode(btn.dataset.track);
      store.mode = btn.dataset.track;
      navigator.vibrate?.(40);
      renderTrackSelector();
      loop();
    });
  });
  renderTrackSelector();
}

function renderTrackSelector() {
  document.querySelectorAll("[data-track]").forEach(b => {
    b.setAttribute("aria-checked", String(b.dataset.track === engine.mode));
  });
  document.body.dataset.track = engine.mode;
}

function bindBeatPicker() {
  const grid = document.getElementById("beat-grid");
  if (grid) {
    grid.innerHTML = STATIONS.map(s => `
      <button type="button" class="beat" data-code="${s.code}">
        <b>${s.code}</b>
        <span>${s.te}</span>
        <i>km ${s.km}</i>
      </button>`).join("");
    grid.addEventListener("click", e => {
      const b = e.target.closest("[data-code]");
      if (!b) return;
      gps.setManualBeat(b.dataset.code);
      navigator.vibrate?.(40);
      loop();
      showToast(`Work beat set to ${b.dataset.code} (km ${STATION_BY_CODE[b.dataset.code]?.km})`, "info");
    });
  }
  document.getElementById("nudge-minus")?.addEventListener("click", () => { gps.nudgeManual(-0.5); loop(); });
  document.getElementById("nudge-plus")?.addEventListener("click", () => { gps.nudgeManual(+0.5); loop(); });
  document.getElementById("beat-toggle")?.addEventListener("click", () => {
    const p = document.getElementById("beat-panel");
    if (p) p.hidden = !p.hidden;
  });
}

// ── 1 Hz Safety Loop ──────────────────────────────────────────────────────────
function loop() {
  const now = Date.now();
  const worker = gps.getPosition();
  const trains = live.getTrainStates(worker?.km);
  const result = engine.update(worker, trains, now);
  
  if (armed) {
    orchestrator.process(result);
  }
  render(worker, result, now);
}

const fmtClock = s => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const LINE_LABEL = { UP: "UP · BZA", DN: "DOWN · GDR", BOTH: "BOTH" };
const LEVEL_TE = {
  0: "సురక్షితం",
  1: "సురక్షితం",
  2: "సిద్ధంగా ఉండండి",
  3: "జాగ్రత్త",
  4: "ప్రమాదం · ట్రాక్ ఖాళీ చేయండి!"
};
const LEVEL_EN = {
  0: "NO TRAIN NEAR",
  1: "NO TRAIN NEAR",
  2: "PREPARE · HEADS UP",
  3: "WARNING · REMOVE TOOLS",
  4: "DANGER · CLEAR TRACK NOW"
};

function render(worker, r, now) {
  // 1. Header & Location Badges
  const gpsBadge = document.getElementById("gps-badge");
  const gpsBadgeText = document.getElementById("gps-badge-text");
  const gpsText = document.getElementById("gps-text");

  if (worker) {
    if (gpsBadgeText) gpsBadgeText.textContent = worker.badge;
    if (gpsBadge) {
      gpsBadge.className = `badge-status ${worker.source === "GPS" ? "badge-ok" : worker.source === "MANUAL" ? "badge-manual" : "badge-warn"}`;
    }
    if (gpsText) gpsText.textContent = worker.label;
    const workerLabel = document.getElementById("worker-label");
    if (workerLabel) workerLabel.textContent = worker.label;
  } else {
    if (gpsBadgeText) gpsBadgeText.textContent = "SELECT BEAT";
    if (gpsBadge) gpsBadge.className = "badge-status badge-bad";
    if (gpsText) gpsText.textContent = "Location Unknown";
  }

  // 2. Feed status badge
  const fs = live.feedStatus();
  const feedBadge = document.getElementById("feed-badge");
  const feedBadgeText = document.getElementById("feed-badge-text");
  if (feedBadgeText) {
    feedBadgeText.textContent = fs.state === "LIVE" ? "LIVE FEED" : fs.state === "STALE" ? `FEED ${Math.round(fs.ageS / 60)}m OLD` : "SCHEDULE ONLY";
  }
  if (feedBadge) {
    feedBadge.className = `badge-status ${fs.state === "LIVE" ? "badge-ok" : fs.state === "STALE" ? "badge-warn" : "badge-bad"}`;
  }

  // 3. Status Band
  const p = r.primary;
  const lvl = p ? p.level : LEVEL.NONE;
  document.body.dataset.level = LEVEL_NAME[lvl];

  const statusEn = document.getElementById("status-en");
  const statusTe = document.getElementById("status-te");
  if (statusEn) statusEn.textContent = r.noLocation ? "LOCATION UNKNOWN" : LEVEL_EN[lvl];
  if (statusTe) statusTe.textContent = r.noLocation ? "మీ బీట్ ఎంచుకోండి" : LEVEL_TE[lvl];

  // 4. Primary Threat Card
  const threatCard = document.getElementById("threat");
  const ackBtn = document.getElementById("ack");
  if (threatCard) threatCard.hidden = !p;
  if (ackBtn) ackBtn.hidden = !p || lvl < LEVEL.WARN;

  if (p) {
    const tNo = document.getElementById("t-no");
    const tName = document.getElementById("t-name");
    const tLine = document.getElementById("t-line");
    const tDist = document.getElementById("t-dist");
    const tEta = document.getElementById("t-eta");
    const tSpeed = document.getElementById("t-speed");
    const tSrc = document.getElementById("t-src");
    const tMore = document.getElementById("t-more");

    if (tNo) tNo.textContent = p.no;
    if (tName) tName.textContent = p.name;
    if (tLine) tLine.textContent = LINE_LABEL[p.line] || p.line;
    if (tDist) tDist.textContent = p.atSite ? "AT SITE" : `${Math.max(0, p.dLeadKm).toFixed(1)}`;
    if (tEta) tEta.textContent = p.atSite ? "0:00" : fmtClock(p.etaLowerS);
    if (tSpeed) tSpeed.textContent = `${Math.round(p.speedKmh)} km/h`;
    if (tSrc) {
      tSrc.textContent = p.confirmed ? `LIVE · ${p.delayMin > 0 ? '+' + p.delayMin + 'm late' : 'on time'}` : "SCHEDULE";
      tSrc.dataset.state = p.confirmed ? "ok" : "warn";
    }
    const extra = r.threats.length - 1;
    if (tMore) tMore.textContent = extra > 0 ? `+${extra} more on active track` : "";
  }

  // 5. Radar rendering
  renderRadar(worker, [...r.threats, ...r.ambient]);

  // 6. Ambient Traffic list
  const ambientList = document.getElementById("ambient");
  if (ambientList) {
    const items = r.ambient.slice(0, 8);
    if (items.length > 0) {
      ambientList.innerHTML = items.map(a => `
        <li data-active="${a.active}" data-line="${a.line}">
          <b>${a.no}</b>
          <span>${a.name.slice(0, 18)}</span>
          <span>${a.dLeadKm > 0 ? a.dLeadKm.toFixed(1) + ' km' : a.confirmed ? 'passing' : 'scheduled'}</span>
          <span>${a.dLeadKm > 0 ? fmtClock(a.etaLowerS) : ''}</span>
        </li>`).join("");
    } else {
      ambientList.innerHTML = '<li class="empty">No approaching trains within 30 minutes</li>';
    }
  }

  // Flash session button on danger
  const smbBtn = document.getElementById("session-mega-btn");
  if (smbBtn && armed) {
    if (lvl === LEVEL.CRITICAL) {
      smbBtn.classList.add("session-danger");
      const dot = document.getElementById("smb-dot");
      if (dot) dot.className = "smb-status-dot dot-crit";
    } else {
      smbBtn.classList.remove("session-danger");
      const dot = document.getElementById("smb-dot");
      if (dot) dot.className = "smb-status-dot dot-on";
    }
  }
}

const RADAR_KM = 20;
function renderRadar(worker, rows) {
  const svg = document.getElementById("radar-trains");
  if (!svg) return;
  if (!worker || !Number.isFinite(worker.km)) {
    svg.innerHTML = "";
    return;
  }
  // x: 0..1000, worker at 500. North (BZA, higher km) to the RIGHT.
  const x = km => 500 + ((km - worker.km) / RADAR_KM) * 500;
  svg.innerHTML = rows
    .filter(t => Number.isFinite(t.kmNominal) && Math.abs(t.kmNominal - worker.km) <= RADAR_KM)
    .map(t => {
      const y = t.dir === "UP" ? 40 : 100;
      const cx = Math.max(10, Math.min(990, x(t.kmNominal)));
      const lead = Math.max(10, Math.min(990, x(t.kmLead)));
      const arrow = t.dir === "UP"
        ? `M${cx - 14},${y - 12} L${cx + 14},${y} L${cx - 14},${y + 12} Z`
        : `M${cx + 14},${y - 12} L${cx - 14},${y} L${cx + 14},${y + 12} Z`;
      return `<g class="rt lvl-${LEVEL_NAME[t.level]}" data-active="${t.active}">
        <line x1="${Math.min(cx, lead)}" x2="${Math.max(cx, lead)}" y1="${y}" y2="${y}" class="env"/>
        <path d="${arrow}"/>
        <text x="${cx}" y="${y + (t.dir === "UP" ? -18 : 32)}">${t.no}</text>
      </g>`;
    }).join("");
}

// ── Tab Navigation ────────────────────────────────────────────────────────────
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
      const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
      el.value = cfg(key) || "";
    }
  });
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
      const entered = prompt("Enter password to view/edit API keys:");
      if (entered === MASTER_PASSWORD) {
        isUnlocked = true;
        lockedDiv.style.display = "none";
        unlockedDiv.style.display = "block";
        toggleBtn.textContent = "Hide Keys";
        fillApiKeyFields();
      } else if (entered !== null) {
        showToast("Incorrect password", "error");
      }
    } else {
      isUnlocked = false;
      lockedDiv.style.display = "block";
      unlockedDiv.style.display = "none";
      toggleBtn.textContent = "Show Keys";
    }
  });

  visibilityBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
        btn.textContent = input.type === "password" ? "Show" : "Hide";
      }
    });
  });
}

function fillApiKeyFields() {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  setVal("setting-ai_provider", cfg("ai_provider") || "openai_compatible");
  setVal("setting-ai_model", cfg("ai_model") || "agnes-2.5-flash");
  setVal("setting-ai_base_url", cfg("ai_base_url") || "https://router.bynara.id/v1");
  setVal("setting-ai_api_key", cfg("ai_api_key") || "");
  setVal("setting-owm_api_key", cfg("owm_api_key") || "");
  setVal("setting-railradar_key", cfg("railradar_key") || "");
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
  const el = document.getElementById("header-subtitle");
  if (el) el.textContent = name ? `${name}${gang ? " · Gang " + gang : ""} · SKM` : "ALPHA · SKM SECTION";
}

// ── Toast System ──────────────────────────────────────────────────────────────
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
  const iconEl = toast.querySelector(".toast-icon");
  const msgEl = toast.querySelector(".toast-msg");
  if (iconEl) iconEl.innerHTML = icons[type] || Icons.info(20, '#06B6D4');
  if (msgEl) msgEl.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

// ── Element Getters for Other Modules ─────────────────────────────────────────
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
