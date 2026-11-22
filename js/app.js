/**
 * RailRaksha — Main Application Controller v6.0 (app.js)
 *
 * - Direction-aware Track Selector (UP / DOWN / BOTH)
 * - 4-State Resilient GPS Tracker with Along-Track Kalman Filter & Manual Beat Nudge
 * - Continuous Chainage Schedule Math & Delay-Corrected Position Envelope
 * - Single-Voice Bilingual (Telugu + English) Alert Orchestrator & Multi-Tone Siren
 * - Crisp Dual-Rail Corridor Radar SVG
 * - Integrated Defect Report, Gang Diary, Live Weather & IRPWM Manual
 */

import { STATIONS, STATION_BY_CODE, kmToLatLon, nearestStation } from './corridor.js';
import { GpsTracker } from './gps-tracker.js';
import { LiveTrainService } from './live-trains.js';
import {
  ThreatEngine, AlertOrchestrator, VoiceManager, SirenManager, HapticManager, Notifier,
  LEVEL, LEVEL_NAME, TRACK_MODE,
} from './train-alert.js';

import { initDefectReport } from './defect-report.js';
import { initGangDiary }    from './gang-diary.js';
import { initWeatherAlert } from './weather-alert.js';
import { initPWManual }     from './pw-manual.js';
import { openDB, getSetting, setSetting } from './db.js';
import { applyDefaultsOnce, getConfig, getConfigNum } from './config.js';
import { Icons } from './icons.js';

window.getConfig = getConfig;

const FALLBACK_LIVE_API = "https://railraksha.vercel.app/api/live-status";

// ── State & Storage ──────────────────────────────────────────────────────────
const store = {
  get mode() { return localStorage.getItem('rr.trackMode') || TRACK_MODE.BOTH; },
  set mode(v) { localStorage.setItem('rr.trackMode', v); },
  get lang() { return localStorage.getItem('rr.lang') || 'te+en'; },
};

// ── Upstream Live Train Provider ─────────────────────────────────────────────
async function fetchLive(trainNo, runDateISO, signal) {
  const qs = `train=${encodeURIComponent(trainNo)}&date=${encodeURIComponent(runDateISO)}`;
  const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

  // 1. Try same-origin serverless proxy (works on Cloudflare Pages + Vercel)
  if (!isLocal) {
    try {
      const r = await fetch(`/api/live-status?${qs}`, { signal, cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404) {
        const fb = await fetch(`${FALLBACK_LIVE_API}?${qs}`, { signal, cache: 'no-store' });
        if (fb.ok) return await fb.json();
      }
    } catch {}
  }

  // 2. Direct RailRadar v1 API if user entered their own key in Settings
  const railradarKey = getConfig("railradar_key");
  if (railradarKey) {
    const resp = await fetch(`https://api.railradar.in/v1/trains/${trainNo}/live?date=${encodeURIComponent(runDateISO)}`, {
      headers: { "Authorization": `Bearer ${railradarKey}`, "Accept": "application/json" },
      signal,
    });
    if (resp.ok) {
      const raw = await resp.json();
      const d = raw?.data || raw;
      const cur = d?.currentLocation || d?.currentStation || d?.lastStation || {};
      const code = String(cur.stationCode || cur.code || d?.currentStationCode || "").toUpperCase();
      if (code) {
        return {
          last_station_code: code,
          delay_min: Number(d?.delayMinutes ?? d?.delay ?? cur.delayMinutes ?? 0) || 0,
          actual_departure: cur.actualDeparture || cur.actualDepartureTime || null,
          speed_kmh: Number.isFinite(Number(cur.speed)) ? Number(cur.speed) : null,
          updated_at: d?.updatedAt || new Date().toISOString(),
        };
      }
    }
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

function syncEngineConfig() {
  engine.cfg.criticalKm = getConfigNum("alert_dist_critical") || 3;
  engine.cfg.warnKm     = getConfigNum("alert_dist_warn")     || 8;
  engine.cfg.prepareKm  = getConfigNum("alert_dist_prepare")  || 15;
  engine.cfg.clearanceS = (getConfigNum("alert_min_critical") || 3) * 60;
  engine.cfg.warnS      = (getConfigNum("alert_min_warn")     || 5) * 60;
  engine.cfg.prepareS   = (getConfigNum("alert_min_prepare")  || 10) * 60;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  applyDefaultsOnce();
  syncEngineConfig();
  await openDB();

  // Default to SKM beat on first launch if no manual beat saved yet so radar & corridor traffic work immediately
  if (!gps.manual) {
    const defaultCode = STATION_BY_CODE[getConfig("work_station_a")] ? getConfig("work_station_a") : "SKM";
    gps.setManualBeat(defaultCode, 0);
  }

  loadSettings();
  updateHeaderName();
  setupNavigation();
  setupSettings();
  setupToastSystem();
  bindTrackSelector();
  bindBeatPicker();
  setupSessionButton();
  setupAcknowledgeButton();
  setupRefreshTrainsButton();

  // 1 Hz safety loop
  setInterval(loop, 1000);
  // Live API poll loop
  const pollNow = () => {
    const w = gps.getPosition();
    if (w?.km != null) live.poll(w.km);
  };
  pollNow();
  setInterval(pollNow, 15000);

  loop();

  // Register Service Worker (single clean registration)
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
    showToast("Siren silenced temporarily (critical voice stays active)", "info");
  });
}

function setupRefreshTrainsButton() {
  document.getElementById("btn-refresh-trains")?.addEventListener("click", () => {
    const w = gps.getPosition();
    if (w?.km != null) live.poll(w.km);
    loop();
    showToast("Corridor traffic refreshed", "info");
  });
}

async function toggleSession() {
  if (armed) await deactivateSession();
  else await activateSession();
}

async function activateSession() {
  siren.unlock();
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch {}

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch {}
  }

  armed = true;
  document.body.dataset.armed = "true";
  gps.start();

  await setSetting("work_session_active", true);
  await setSetting("session_start_time", new Date().toISOString());

  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-off");
  btn?.classList.add("session-on");

  const iconEl = document.getElementById("smb-icon");
  if (iconEl) iconEl.innerHTML = Icons.shield(22, "#22C55E");
  const dotEl = document.getElementById("smb-dot");
  if (dotEl) dotEl.className = "smb-status-dot dot-on";
  const titleEl = document.getElementById("smb-title");
  if (titleEl) titleEl.textContent = "MONITORING ACTIVE";
  const subEl = document.getElementById("smb-sub");
  if (subEl) subEl.textContent = "Sirens, Telugu/English voice & GPS tracking armed";
  const smbRight = document.getElementById("smb-right");
  if (smbRight) smbRight.hidden = false;

  startSessionTimer();
  loop();
  showToast("Work session armed — track safety active", "ok");
}

async function deactivateSession() {
  armed = false;
  document.body.dataset.armed = "false";
  gps.stop();
  siren.set(LEVEL.NONE);
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  await setSetting("work_session_active", false);
  await setSetting("session_start_time", null);

  const btn = document.getElementById("session-mega-btn");
  btn?.classList.remove("session-on", "session-danger");
  btn?.classList.add("session-off");

  const iconEl = document.getElementById("smb-icon");
  if (iconEl) iconEl.innerHTML = Icons.shield(22, "#94A3B8");
  const dotEl = document.getElementById("smb-dot");
  if (dotEl) dotEl.className = "smb-status-dot dot-off";
  const titleEl = document.getElementById("smb-title");
  if (titleEl) titleEl.textContent = "START WORK SESSION";
  const subEl = document.getElementById("smb-sub");
  if (subEl) subEl.textContent = "Tap when on track to arm sirens, voice & live GPS";
  const smbRight = document.getElementById("smb-right");
  if (smbRight) smbRight.hidden = true;

  const timeStr = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const smbLast = document.getElementById("smb-last");
  if (smbLast) smbLast.textContent = `Last session ended at ${timeStr}`;

  clearInterval(timerInterval);
  loop();
  showToast("Work session ended", "info");
}

function startSessionTimer() {
  const startTime = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const timerEl = document.getElementById("smb-timer");
    if (timerEl) {
      timerEl.textContent = h > 0
        ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
        : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }, 1000);
}

// ── Track Selector & Beat Picker ─────────────────────────────────────────────
function bindTrackSelector() {
  document.querySelectorAll("[data-track]").forEach(btn => {
    btn.addEventListener("click", () => {
      engine.setMode(btn.dataset.track);
      store.mode = btn.dataset.track;
      navigator.vibrate?.(35);
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
      navigator.vibrate?.(35);
      highlightSelectedBeat();
      loop();
      showToast(`Work beat set to ${b.dataset.code} (km ${STATION_BY_CODE[b.dataset.code]?.km})`, "ok");
    });
  }
  highlightSelectedBeat();

  document.getElementById("nudge-minus")?.addEventListener("click", () => { gps.nudgeManual(-0.5); loop(); });
  document.getElementById("nudge-plus")?.addEventListener("click", () => { gps.nudgeManual(+0.5); loop(); });

  const toggle = document.getElementById("beat-toggle");
  const panel = document.getElementById("beat-panel");
  toggle?.addEventListener("click", () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
}

function highlightSelectedBeat() {
  const activeCode = gps.manual?.code;
  document.querySelectorAll("#beat-grid .beat").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.code === activeCode);
  });
}

// ── 1 Hz Safety Loop ──────────────────────────────────────────────────────────
function loop() {
  const now = Date.now();
  const worker = gps.getPosition();

  // Share current location cleanly with Defect Report & Weather modules
  if (worker) {
    const ll = gps.lastFix && !gps.lastFix.offCorridor
      ? { lat: gps.lastFix.lat, lon: gps.lastFix.lon }
      : kmToLatLon(worker.km);
    const st = nearestStation(worker.km);
    window._currentWorkerPos = {
      km: worker.km,
      lat: ll?.lat ?? st.lat,
      lon: ll?.lon ?? st.lon,
      label: worker.label,
      stationLabel: `${st.name} (${st.code})`,
    };
    window._currentLocationLabel = ll
      ? `${worker.label} (${ll.lat.toFixed(4)}°N, ${ll.lon.toFixed(4)}°E)`
      : worker.label;
  }

  const trains = live.getTrainStates(worker?.km);
  const result = engine.update(worker, trains, now);

  if (armed) orchestrator.process(result);
  render(worker, result);
}

const fmtClock = s => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const LINE_LABEL = { UP: "UP · BZA", DN: "DOWN · GDR", BOTH: "BOTH" };
const LEVEL_TE = {
  0: "సురక్షితం · రైలు సమీపంలో లేదు",
  1: "సురక్షితం · రైలు సమీపంలో లేదు",
  2: "సిద్ధంగా ఉండండి",
  3: "జాగ్రత్త · సామాను తొలగించండి",
  4: "ప్రమాదం · వెంటనే ట్రాక్ ఖాళీ చేయండి!",
};
const LEVEL_EN = {
  0: "TRACK CLEAR",
  1: "TRACK CLEAR",
  2: "PREPARE · TRAIN APPROACHING",
  3: "WARNING · CLEAR TOOLS",
  4: "DANGER · CLEAR TRACK NOW",
};

function render(worker, r) {
  // 1. Header & Telemetry Badges
  const gpsBadge = document.getElementById("gps-badge");
  const gpsBadgeText = document.getElementById("gps-badge-text");
  const gpsText = document.getElementById("gps-text");

  if (worker) {
    if (gpsBadgeText) gpsBadgeText.textContent = worker.badge;
    if (gpsBadge) {
      gpsBadge.className = `badge-status ${worker.source === "GPS" ? "badge-ok" : worker.source === "MANUAL" ? "badge-manual" : "badge-warn"}`;
    }
    if (gpsText) gpsText.textContent = worker.label;
  } else {
    if (gpsBadgeText) gpsBadgeText.textContent = "SELECT BEAT";
    if (gpsBadge) gpsBadge.className = "badge-status badge-bad";
    if (gpsText) gpsText.textContent = "Select Beat";
  }

  // 2. Feed Status Badge
  const fs = live.feedStatus();
  const feedBadge = document.getElementById("feed-badge");
  const feedBadgeText = document.getElementById("feed-badge-text");
  if (feedBadgeText) {
    feedBadgeText.textContent = fs.state === "LIVE"
      ? "LIVE NTES FEED"
      : fs.state === "STALE"
      ? `FEED ${Math.round(fs.ageS / 60)}m OLD`
      : "SCHEDULE MODE";
  }
  if (feedBadge) {
    feedBadge.className = `badge-status ${fs.state === "LIVE" ? "badge-ok" : fs.state === "STALE" ? "badge-warn" : "badge-neutral"}`;
  }

  // 3. Status Band
  const p = r.primary;
  const lvl = p ? p.level : LEVEL.NONE;
  document.body.dataset.level = LEVEL_NAME[lvl];

  const statusEn = document.getElementById("status-en");
  const statusTe = document.getElementById("status-te");
  if (statusEn) statusEn.textContent = r.noLocation ? "SELECT WORK BEAT" : LEVEL_EN[lvl];
  if (statusTe) statusTe.textContent = r.noLocation ? "మీ బీట్ ఎంచుకోండి" : LEVEL_TE[lvl];

  // 4. Primary Threat Card & Acknowledge Button
  const threatCard = document.getElementById("threat");
  const ackBtn = document.getElementById("ack");
  if (threatCard) threatCard.hidden = !p;
  if (ackBtn) ackBtn.hidden = !p || lvl < LEVEL.WARN || !armed;

  if (p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("t-no", p.no);
    set("t-name", p.name);
    set("t-line", LINE_LABEL[p.line] || p.line);
    set("t-dist", p.atSite ? "AT SITE" : `${Math.max(0, p.dLeadKm).toFixed(1)}`);
    set("t-eta", p.atSite ? "0:00" : fmtClock(p.etaLowerS));
    set("t-speed", `${Math.round(p.speedKmh)} km/h`);

    const tPill = document.getElementById("t-pill");
    if (tPill) tPill.textContent = LEVEL_NAME[p.level];

    const tSrc = document.getElementById("t-src");
    if (tSrc) {
      tSrc.textContent = p.confirmed
        ? `LIVE · ${p.delayMin > 0 ? `+${p.delayMin}m late` : "on time"}`
        : "SCHEDULED";
      tSrc.dataset.state = p.confirmed ? "ok" : "warn";
    }
    const extra = r.threats.length - 1;
    set("t-more", extra > 0 ? `+${extra} more on active line` : "");
  }

  // 5. Corridor Radar
  renderRadar(worker, [...r.threats, ...r.ambient]);

  // 6. Corridor Traffic List
  const ambientList = document.getElementById("ambient");
  if (ambientList) {
    const allItems = [...r.threats, ...r.ambient].slice(0, 10);
    if (allItems.length > 0) {
      ambientList.innerHTML = allItems.map(a => `
        <li data-active="${a.active}" data-line="${a.line}" data-level="${LEVEL_NAME[a.level]}">
          <span class="amb-no">${a.no}</span>
          <span class="amb-name">${a.name}</span>
          <span class="amb-dir">${a.line}</span>
          <span class="amb-dist">${a.dLeadKm > 0 ? `${a.dLeadKm.toFixed(1)} km` : a.confirmed ? "Passing" : "Due"}</span>
          <span class="amb-eta">${a.dLeadKm > 0 ? fmtClock(a.etaLowerS) : "—"}</span>
        </li>`).join("");
    } else {
      ambientList.innerHTML = '<li class="empty">No scheduled or live trains within 30 minutes</li>';
    }
  }

  // Session button danger state
  const smbBtn = document.getElementById("session-mega-btn");
  if (smbBtn && armed) {
    smbBtn.classList.toggle("session-danger", lvl === LEVEL.CRITICAL);
    const dot = document.getElementById("smb-dot");
    if (dot) dot.className = `smb-status-dot ${lvl === LEVEL.CRITICAL ? "dot-crit" : "dot-on"}`;
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
  // viewBox 0..600, worker at 300. North (BZA, higher km) to the RIGHT.
  const x = km => 300 + ((km - worker.km) / RADAR_KM) * 280;
  svg.innerHTML = rows
    .filter(t => Number.isFinite(t.kmNominal) && Math.abs(t.kmNominal - worker.km) <= RADAR_KM)
    .map(t => {
      const y = t.dir === "UP" ? 38 : 94;
      const cx = Math.max(18, Math.min(582, x(t.kmNominal)));
      const lead = Math.max(18, Math.min(582, x(t.kmLead)));
      const arrow = t.dir === "UP"
        ? `M${cx - 8},${y - 7} L${cx + 9},${y} L${cx - 8},${y + 7} Z`
        : `M${cx + 8},${y - 7} L${cx - 9},${y} L${cx + 8},${y + 7} Z`;
      const labelY = t.dir === "UP" ? y - 12 : y + 20;
      return `<g class="rt lvl-${LEVEL_NAME[t.level]}" data-active="${t.active}">
        <line x1="${Math.min(cx, lead)}" x2="${Math.max(cx, lead)}" y1="${y}" y2="${y}" class="env"/>
        <path d="${arrow}"/>
        <text x="${cx}" y="${labelY}" text-anchor="middle">${t.no}</text>
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
  document.getElementById("main-content")?.scrollTo({ top: 0 });

  if (screenId === "defect"  && !window._defectInit)  { initDefectReport(getDefectElements());  window._defectInit  = true; }
  if (screenId === "diary"   && !window._diaryInit)   { initGangDiary(getDiaryElements());      window._diaryInit   = true; }
  if (screenId === "weather" && !window._weatherInit) { initWeatherAlert(getWeatherElements()); window._weatherInit = true; }
  if (screenId === "manual"  && !window._manualInit)  { initPWManual(getManualElements());      window._manualInit  = true; }
}

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTING_FIELDS = [
  "mate_name", "gang_no", "gang_strength", "section",
  "work_station_a", "work_station_b",
  "ai_base_url", "ai_model", "ai_api_key",
  "owm_api_key", "railradar_key",
  "alert_dist_critical", "alert_dist_warn", "alert_dist_prepare",
  "alert_min_critical",  "alert_min_warn",  "alert_min_prepare",
];

function loadSettings() {
  SETTING_FIELDS.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) el.value = getConfig(key) || "";
  });

  document.querySelectorAll(".btn-toggle-visibility").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === "password" ? "text" : "password";
        btn.textContent = input.type === "password" ? "Show" : "Hide";
      }
    });
  });
}

function setupSettings() {
  const overlay = document.getElementById("settings-overlay");
  document.getElementById("btn-settings")?.addEventListener("click", () => overlay?.classList.add("active"));
  document.getElementById("btn-close-settings")?.addEventListener("click", () => overlay?.classList.remove("active"));
  document.getElementById("btn-save-settings")?.addEventListener("click", saveSettings);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("active");
  });
}

function saveSettings() {
  SETTING_FIELDS.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) localStorage.setItem(key, el.value.trim());
  });
  syncEngineConfig();
  document.getElementById("settings-overlay")?.classList.remove("active");
  updateHeaderName();
  loop();
  showToast("Settings saved", "ok");
}

function updateHeaderName() {
  const name = localStorage.getItem("mate_name") || "";
  const gang = localStorage.getItem("gang_no") || "";
  const el = document.getElementById("header-subtitle");
  if (!el) return;
  if (name || gang) {
    el.textContent = [name, gang ? `Gang ${gang}` : "", "SKM–UPD"].filter(Boolean).join(" · ");
  } else {
    el.textContent = "SKM–UPD · Vijayawada Div.";
  }
}

// ── Toast System ──────────────────────────────────────────────────────────────
let toastTimer = null;
function setupToastSystem() {
  window.addEventListener("showToast", (e) => showToast(e.detail.msg, e.detail.type));
}

function showToast(msg, type = "info") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  const icons = {
    ok: Icons.check(18, '#22C55E'),
    warn: Icons.alert(18, '#F59E0B'),
    error: Icons.alertCircle(18, '#EF4444'),
    info: Icons.info(18, '#94A3B8'),
  };
  const iconEl = toast.querySelector(".toast-icon");
  const msgEl = toast.querySelector(".toast-msg");
  if (iconEl) iconEl.innerHTML = icons[type] || icons.info;
  if (msgEl) msgEl.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// ── Element Getters ───────────────────────────────────────────────────────────
function getDefectElements() {
  return {
    captureZone: document.getElementById("capture-zone"),
    capturePlaceholder: document.getElementById("capture-placeholder"),
    fileInput: document.getElementById("defect-file-input"),
    uploadInput: document.getElementById("defect-upload-input"),
    btnCamera: document.getElementById("btn-camera"),
    btnUpload: document.getElementById("btn-upload"),
    imagePreview: document.getElementById("captured-image-preview"),
    btnAnalyze: document.getElementById("btn-analyze-defect"),
    defectAnalysisCard: document.getElementById("defect-analysis-card"),
    defectTypeBadge: document.getElementById("defect-type-badge"),
    detailSeverity: document.getElementById("detail-severity"),
    detailConfidence: document.getElementById("detail-confidence"),
    detailIRPWM: document.getElementById("detail-irpwm"),
    detailSpeed: document.getElementById("detail-speed"),
    detailGPS: document.getElementById("detail-gps"),
    detailTime: document.getElementById("detail-time"),
    detailGeneralInfo: document.getElementById("detail-general-info"),
    detailDescription: document.getElementById("detail-description"),
    recommendedAction: document.getElementById("recommended-action"),
    irpwmReference: document.getElementById("irpwm-reference"),
    btnShareReport: document.getElementById("btn-share-report"),
    btnNewDefect: document.getElementById("btn-new-defect"),
    defectHistoryList: document.getElementById("defect-history-list"),
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
    btnTypeDiary: document.getElementById("btn-type-diary"),
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
    todayEntriesCount: document.getElementById("today-entries-count"),
    savedEntriesList: document.getElementById("saved-entries-list"),
  };
}

function getWeatherElements() {
  return {
    weatherIcon: document.getElementById("weather-icon-large"),
    weatherLocation: document.getElementById("weather-location-text"),
    weatherTemp: document.getElementById("weather-temp"),
    weatherDesc: document.getElementById("weather-desc"),
    weatherHumidity: document.getElementById("weather-humidity"),
    weatherWind: document.getElementById("weather-wind"),
    weatherRain: document.getElementById("weather-rain"),
    riskList: document.getElementById("risk-list"),
    btnRefreshWeather: document.getElementById("btn-refresh-weather"),
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
    quickRulesList: document.getElementById("quick-rules-list"),
  };
}
