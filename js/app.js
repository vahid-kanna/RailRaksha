/**
 * RailRaksha — Main Application Controller v7.0 (app.js)
 *
 * Enterprise offline-first railway field safety console:
 *   - 100% Cloudflare-native edge proxies (/api/live-status, /api/chat, /api/health)
 *   - Direction-aware Track Selector (UP / DOWN / BOTH) + 14-station SCR Beat Picker
 *   - 4-State Resilient GPS Tracker with Along-Track Kalman Filter
 *   - Dual-Rail Corridor Radar SVG with dynamic nearby station landmarks
 *   - Built-in Safety Drill Simulator (clearly badged SIMULATION DRILL — NOT LIVE TRAFFIC)
 *   - Emergency Line Protection Sheet (GR 3.62 detonator schematic + 1-tap GPS SMS copy + quick dial)
 *   - Outdoor Daylight High-Contrast & Industrial Field Dark themes
 *   - Persistent IndexedDB Shift Alert Audit Log + Full JSON Data Export
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
import {
  openDB, setSetting, logAlert, getAlertLogs, clearAlertLogs, exportAllData, getISTDateISO,
} from './db.js';
import { applyDefaultsOnce, getConfig, getConfigNum } from './config.js';
import { checkServerHealth } from './ai-engine.js';
import { Icons } from './icons.js';

window.getConfig = getConfig;

// ── Preferences Store ────────────────────────────────────────────────────────
const store = {
  get mode() { return localStorage.getItem('rr.trackMode') || TRACK_MODE.BOTH; },
  set mode(v) { localStorage.setItem('rr.trackMode', v); },
  get lang() { return getConfig('voice_lang') || 'te+en'; },
  get theme() { return getConfig('theme') || 'dark'; },
  set theme(v) { localStorage.setItem('theme', v); },
};

// ── Live Train Fetcher (Cloudflare Worker /api/live-status + optional personal key) ──
async function fetchLive(trainNo, runDateISO, signal) {
  if (!/^\d{4,5}$/.test(String(trainNo))) throw new Error('Non-NTES freight slot');
  const qs = `train=${encodeURIComponent(trainNo)}&date=${encodeURIComponent(runDateISO)}`;

  // 1. Same-origin Cloudflare Worker proxy
  try {
    const r = await fetch(`/api/live-status?${qs}`, { signal, cache: 'no-store' });
    if (r.ok) return await r.json();
  } catch {}

  // 2. Direct RailRadar v1 API only if user configured their own personal key in Settings
  const railradarKey = getConfig('railradar_key');
  if (railradarKey) {
    const resp = await fetch(`https://api.railradar.in/v1/trains/${trainNo}/live?date=${encodeURIComponent(runDateISO)}`, {
      headers: { 'Authorization': `Bearer ${railradarKey}`, 'Accept': 'application/json' },
      signal,
    });
    if (resp.ok) {
      const raw = await resp.json();
      const d = raw?.data || raw;
      const cur = d?.currentLocation || d?.currentStation || d?.lastStation || {};
      const code = String(cur.stationCode || cur.code || d?.currentStationCode || '').toUpperCase();
      if (code) {
        return {
          last_station_code: code,
          delay_min: Number(d?.delayMinutes ?? d?.delay ?? cur.delayMinutes ?? 0) || 0,
          actual_departure: cur.actualDeparture || cur.actualDepartureTime || null,
          speed_kmh: Number.isFinite(Number(cur.speed)) ? Number(cur.speed) : null,
          updated_at: d?.lastUpdatedAt || d?.updatedAt || new Date().toISOString(),
        };
      }
    }
  }
  throw new Error('Schedule mode active');
}

// ── Safety Engines ───────────────────────────────────────────────────────────
const gps = new GpsTracker();
const live = new LiveTrainService({ fetchLive });
const engine = new ThreatEngine();
const siren = new SirenManager();
const voice = new VoiceManager({ lang: store.lang });
const orchestrator = new AlertOrchestrator({
  voice,
  siren,
  haptics: new HapticManager(),
  notifier: new Notifier(),
});
engine.setMode(store.mode);

let armed = false;
let wakeLock = null;
let timerInterval = null;
let activeTrafficTab = 'trains'; // 'trains' | 'log'
let lastLoggedThreatKey = null;

// ── Simulation Drill State (strictly isolated from live traffic) ─────────────
let drillState = null; // { startedAtMs, dir, startKm, speedKmh, accel }

function startDrill() {
  const worker = gps.getPosition();
  if (!worker) {
    showToast('Select a work beat before starting a drill', 'warn');
    return;
  }
  const dir = engine.mode === TRACK_MODE.DN ? 'DN' : 'UP';
  const sign = dir === 'UP' ? 1 : -1;
  drillState = {
    startedAtMs: Date.now(),
    dir,
    startKm: worker.km - sign * 9.5, // starts 9.5 km upstream
    speedKmh: 115,
    accel: 3.0, // compressed drill clock (~115 km/h * 3x -> traverses 9.5 km in ~99s)
  };
  updateDrillButton();
  loop();
  showToast('Safety drill active — simulated train approaching on radar', 'info');
}

function stopDrill(silent = false) {
  if (!drillState) return;
  drillState = null;
  engine.mem.delete('DRILL-12711');
  if (!armed) siren.set(LEVEL.NONE);
  updateDrillButton();
  loop();
  if (!silent) showToast('Safety drill ended', 'info');
}

function updateDrillButton() {
  const btn = document.getElementById('btn-drill');
  const banner = document.getElementById('drill-banner');
  if (btn) {
    btn.classList.toggle('active', Boolean(drillState));
    btn.setAttribute('aria-pressed', String(Boolean(drillState)));
    const lbl = btn.querySelector('.drill-btn-label');
    if (lbl) lbl.textContent = drillState ? 'End Drill' : 'Safety Drill';
  }
  if (banner) banner.hidden = !drillState;
}

function getDrillTrainState(worker, nowMs) {
  if (!drillState || !worker) return null;
  const sign = drillState.dir === 'UP' ? 1 : -1;
  const elapsedH = ((nowMs - drillState.startedAtMs) / 3600000) * drillState.accel;
  const kmNominal = drillState.startKm + sign * drillState.speedKmh * elapsedH;

  // Auto-finish drill 2.5 km past worker
  const distPast = (kmNominal - worker.km) * sign;
  if (distPast > 2.5) {
    stopDrill(true);
    showToast('Safety drill completed — simulated train passed worksite', 'ok');
    return null;
  }

  return {
    key: 'DRILL-12711',
    no: '12711',
    name: 'Pinakini Express (DRILL)',
    te: 'పినాకిని ఎక్స్‌ప్రెస్ (డ్రిల్)',
    dir: drillState.dir,
    line: drillState.dir,
    vmaxKmh: 120,
    speedKmh: drillState.speedKmh,
    lengthKm: 0.55,
    source: 'DRILL',
    confirmed: true,
    isSimulation: true,
    dataAgeS: 0,
    delayMin: 0,
    phase: 'RUNNING',
    kmNominal,
    kmLead: kmNominal + sign * 0.2,
    kmLag: kmNominal - sign * 0.25,
  };
}

function syncEngineConfig() {
  engine.cfg.criticalKm = getConfigNum('alert_dist_critical') || 3;
  engine.cfg.warnKm     = getConfigNum('alert_dist_warn')     || 8;
  engine.cfg.prepareKm  = getConfigNum('alert_dist_prepare')  || 15;
  engine.cfg.clearanceS = (getConfigNum('alert_min_critical') || 3) * 60;
  engine.cfg.warnS      = (getConfigNum('alert_min_warn')     || 5) * 60;
  engine.cfg.prepareS   = (getConfigNum('alert_min_prepare')  || 10) * 60;
  voice.lang = store.lang;
}

// ── Theme Management ─────────────────────────────────────────────────────────
function applyTheme(theme) {
  const mode = theme === 'daylight' ? 'daylight' : 'dark';
  document.documentElement.dataset.theme = mode;
  store.theme = mode;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', mode === 'daylight' ? '#F1F5F9' : '#0B0E14');

  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.setAttribute('aria-label', mode === 'daylight' ? 'Switch to dark field mode' : 'Switch to outdoor daylight high-contrast mode');
    btn.setAttribute('title', mode === 'daylight' ? 'Field Dark Mode' : 'Outdoor Daylight Mode');
    btn.innerHTML = mode === 'daylight'
      ? `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
      : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  }
}

// ── Network Connectivity Status ──────────────────────────────────────────────
function updateNetworkBadge() {
  const badge = document.getElementById('net-badge');
  const text = document.getElementById('net-badge-text');
  const online = navigator.onLine !== false;
  if (badge) badge.className = `badge-status ${online ? 'badge-ok' : 'badge-warn'}`;
  if (text) text.textContent = online ? 'ONLINE' : 'OFFLINE · LOCAL READY';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  applyDefaultsOnce();
  applyTheme(store.theme);
  syncEngineConfig();
  await openDB();

  // Default to SKM beat on first launch so radar & timetable work immediately
  if (!gps.manual) {
    const defaultCode = STATION_BY_CODE[getConfig('work_station_a')] ? getConfig('work_station_a') : 'SKM';
    gps.setManualBeat(defaultCode, 0);
  }

  populateStationSelects();
  loadSettings();
  updateHeaderName();
  updateNetworkBadge();
  setupNavigation();
  setupSettings();
  setupSOSModal();
  setupToastSystem();
  bindTrackSelector();
  bindBeatPicker();
  setupSessionButton();
  setupDrillButton();
  setupAcknowledgeButton();
  setupRefreshTrainsButton();
  setupTrafficTabs();

  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const next = store.theme === 'daylight' ? 'dark' : 'daylight';
    applyTheme(next);
    const sel = document.getElementById('setting-theme');
    if (sel) sel.value = next;
    showToast(next === 'daylight' ? 'Outdoor Daylight High-Contrast enabled' : 'Industrial Field Dark mode enabled', 'info');
  });

  window.addEventListener('online', () => {
    updateNetworkBadge();
    showToast('Connection restored — live feeds available', 'ok');
  });
  window.addEventListener('offline', () => {
    updateNetworkBadge();
    showToast('Offline mode active — local timetable, diary, defects & IRPWM ready', 'warn');
  });

  // Escape closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      closeSOS();
    }
  });

  // Initial route from hash (supports PWA manifest shortcuts like /#defect, /#diary)
  const initialHash = window.location.hash.replace(/^#/, '');
  const validScreens = new Set(['train-alert', 'defect', 'diary', 'weather', 'manual']);
  if (validScreens.has(initialHash)) {
    navigateTo(initialHash, false);
  }

  // 1 Hz safety loop
  setInterval(loop, 1000);

  // Live API poll loop (only when online)
  const pollNow = () => {
    if (navigator.onLine === false) return;
    const w = gps.getPosition();
    if (w?.km != null) live.poll(w.km);
  };
  pollNow();
  setInterval(pollNow, 20000);

  loop();
  renderAlertAuditLog();

  // Register Service Worker with clean update handling
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
            showToast('RailRaksha updated to latest offline build', 'info');
          }
        });
      });
    }).catch(() => {});
  }
});

// ── Session & Drill Controls ─────────────────────────────────────────────────
function setupSessionButton() {
  document.getElementById('session-mega-btn')?.addEventListener('click', toggleSession);
}

function setupDrillButton() {
  document.getElementById('btn-drill')?.addEventListener('click', () => {
    if (drillState) stopDrill();
    else startDrill();
  });
  document.getElementById('btn-end-drill-banner')?.addEventListener('click', () => stopDrill());
}

function setupAcknowledgeButton() {
  document.getElementById('ack')?.addEventListener('click', () => {
    orchestrator.acknowledge();
    navigator.vibrate?.(60);
    loop();
    showToast('Siren silenced temporarily (critical voice stays active)', 'info');
  });
}

function setupRefreshTrainsButton() {
  document.getElementById('btn-refresh-trains')?.addEventListener('click', () => {
    const w = gps.getPosition();
    if (w?.km != null && navigator.onLine !== false) live.poll(w.km);
    loop();
    showToast(navigator.onLine === false ? 'Offline schedule recalculated' : 'Corridor traffic refreshed', 'info');
  });
}

function setupTrafficTabs() {
  document.querySelectorAll('[data-traffic-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTrafficTab = btn.dataset.trafficTab;
      document.querySelectorAll('[data-traffic-tab]').forEach(b => {
        const isAct = b.dataset.trafficTab === activeTrafficTab;
        b.classList.toggle('active', isAct);
        b.setAttribute('aria-selected', String(isAct));
      });
      const trainsPane = document.getElementById('traffic-trains-pane');
      const logPane = document.getElementById('traffic-log-pane');
      if (trainsPane) trainsPane.hidden = activeTrafficTab !== 'trains';
      if (logPane) logPane.hidden = activeTrafficTab !== 'log';
      if (activeTrafficTab === 'log') renderAlertAuditLog();
    });
  });

  document.getElementById('btn-clear-alert-log')?.addEventListener('click', async () => {
    await clearAlertLogs();
    await renderAlertAuditLog();
    showToast('Alert history cleared', 'info');
  });
}

async function toggleSession() {
  if (armed) await deactivateSession();
  else await activateSession();
}

async function activateSession() {
  siren.unlock();
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
  if ('speechSynthesis' in window) {
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch {}
  }

  armed = true;
  document.body.dataset.armed = 'true';
  gps.start();

  await setSetting('work_session_active', true);
  await setSetting('session_start_time', new Date().toISOString());

  const btn = document.getElementById('session-mega-btn');
  btn?.classList.remove('session-off');
  btn?.classList.add('session-on');
  btn?.setAttribute('aria-pressed', 'true');

  const iconEl = document.getElementById('smb-icon');
  if (iconEl) iconEl.innerHTML = Icons.shield(20, '#22C55E');
  const dotEl = document.getElementById('smb-dot');
  if (dotEl) dotEl.className = 'smb-status-dot dot-on';
  const titleEl = document.getElementById('smb-title');
  if (titleEl) titleEl.textContent = 'MONITORING ACTIVE';
  const subEl = document.getElementById('smb-sub');
  if (subEl) subEl.textContent = 'Sirens, Telugu/English voice & GPS armed';
  const smbRight = document.getElementById('smb-right');
  if (smbRight) smbRight.hidden = false;

  startSessionTimer();
  loop();
  showToast('Work session armed — safety audio & GPS active', 'ok');
}

async function deactivateSession() {
  armed = false;
  document.body.dataset.armed = 'false';
  gps.stop();
  siren.set(LEVEL.NONE);
  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  await setSetting('work_session_active', false);
  await setSetting('session_start_time', null);

  const btn = document.getElementById('session-mega-btn');
  btn?.classList.remove('session-on', 'session-danger');
  btn?.classList.add('session-off');
  btn?.setAttribute('aria-pressed', 'false');

  const iconEl = document.getElementById('smb-icon');
  if (iconEl) iconEl.innerHTML = Icons.shield(20, 'currentColor');
  const dotEl = document.getElementById('smb-dot');
  if (dotEl) dotEl.className = 'smb-status-dot dot-off';
  const titleEl = document.getElementById('smb-title');
  if (titleEl) titleEl.textContent = 'START WORK SESSION';
  const subEl = document.getElementById('smb-sub');
  if (subEl) subEl.textContent = 'Tap on track to arm sirens, voice & live GPS';
  const smbRight = document.getElementById('smb-right');
  if (smbRight) smbRight.hidden = true;

  const timeStr = new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
  const smbLast = document.getElementById('smb-last');
  if (smbLast) smbLast.textContent = `Last session ended at ${timeStr} IST`;

  clearInterval(timerInterval);
  loop();
  showToast('Work session ended', 'info');
}

function startSessionTimer() {
  const startTime = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const totalSec = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const timerEl = document.getElementById('smb-timer');
    if (timerEl) {
      timerEl.textContent = h > 0
        ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
  }, 1000);
}

// ── Track Selector & Beat Picker ─────────────────────────────────────────────
function bindTrackSelector() {
  document.querySelectorAll('[data-track]').forEach(btn => {
    btn.addEventListener('click', () => {
      engine.setMode(btn.dataset.track);
      store.mode = btn.dataset.track;
      navigator.vibrate?.(30);
      renderTrackSelector();
      loop();
    });
  });
  renderTrackSelector();
}

function renderTrackSelector() {
  document.querySelectorAll('[data-track]').forEach(b => {
    b.setAttribute('aria-checked', String(b.dataset.track === engine.mode));
  });
  document.body.dataset.track = engine.mode;
}

function bindBeatPicker() {
  const grid = document.getElementById('beat-grid');
  if (grid) {
    grid.innerHTML = STATIONS.map(s => `
      <button type="button" class="beat" data-code="${s.code}">
        <b>${s.code}</b>
        <span lang="te">${s.te}</span>
        <i>km ${s.km}</i>
      </button>`).join('');
    grid.addEventListener('click', e => {
      const b = e.target.closest('[data-code]');
      if (!b) return;
      gps.setManualBeat(b.dataset.code);
      navigator.vibrate?.(30);
      highlightSelectedBeat();
      loop();
      showToast(`Beat set to ${b.dataset.code} (km ${STATION_BY_CODE[b.dataset.code]?.km})`, 'ok');
    });
  }
  highlightSelectedBeat();

  document.getElementById('nudge-minus')?.addEventListener('click', () => { gps.nudgeManual(-0.5); loop(); });
  document.getElementById('nudge-plus')?.addEventListener('click', () => { gps.nudgeManual(+0.5); loop(); });
  document.getElementById('btn-use-gps')?.addEventListener('click', () => {
    gps.start();
    showToast('Requesting high-accuracy corridor GPS...', 'info');
  });

  const toggle = document.getElementById('beat-toggle');
  const panel = document.getElementById('beat-panel');
  toggle?.addEventListener('click', () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
  });
}

function highlightSelectedBeat() {
  const activeCode = gps.manual?.code;
  document.querySelectorAll('#beat-grid .beat').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.code === activeCode);
  });
}

// ── 1 Hz Safety Loop ──────────────────────────────────────────────────────────
function loop() {
  const now = Date.now();
  const worker = gps.getPosition();

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
  const drillTrain = getDrillTrainState(worker, now);
  if (drillTrain) trains.push(drillTrain);

  const result = engine.update(worker, trains, now);

  if (armed) {
    orchestrator.process(result);
    // Audit real WARN/CRITICAL escalations (never pollute audit log with drills)
    const p = result.primary;
    if (p && !p.isSimulation && p.level >= LEVEL.WARN) {
      const sig = `${p.key}:${p.level}`;
      if (sig !== lastLoggedThreatKey) {
        lastLoggedThreatKey = sig;
        logAlert({
          trainNo: p.no,
          trainName: p.name,
          line: p.line,
          distanceKm: Number(Math.max(0, p.dLeadKm).toFixed(1)),
          etaSec: Math.max(0, Math.round(p.etaLowerS)),
          level: LEVEL_NAME[p.level],
          source: p.confirmed ? 'LIVE' : 'SCHEDULE',
          workerKm: worker?.km ?? null,
        }).then(() => {
          if (activeTrafficTab === 'log') renderAlertAuditLog();
        }).catch(() => {});
      }
    }
  }

  render(worker, result);
}

const fmtClock = s => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const LINE_LABEL = { UP: 'UP · BZA', DN: 'DOWN · GDR', BOTH: 'BOTH' };
const LEVEL_TE = {
  0: 'సురక్షితం · రైలు సమీపంలో లేదు',
  1: 'సురక్షితం · రైలు సమీపంలో లేదు',
  2: 'సిద్ధంగా ఉండండి · రైలు వస్తోంది',
  3: 'జాగ్రత్త · సామాను తొలగించండి',
  4: 'ప్రమాదం · వెంటనే ట్రాక్ ఖాళీ చేయండి!',
};
const LEVEL_EN = {
  0: 'TRACK CLEAR',
  1: 'TRACK CLEAR',
  2: 'PREPARE · TRAIN APPROACHING',
  3: 'WARNING · CLEAR TOOLS',
  4: 'DANGER · CLEAR TRACK NOW',
};

function render(worker, r) {
  // 1. GPS / Beat badge
  const gpsBadge = document.getElementById('gps-badge');
  const gpsBadgeText = document.getElementById('gps-badge-text');
  const gpsText = document.getElementById('gps-text');

  if (worker) {
    if (gpsBadgeText) gpsBadgeText.textContent = worker.badge;
    if (gpsBadge) {
      gpsBadge.className = `badge-status ${worker.source === 'GPS' ? 'badge-ok' : worker.source === 'MANUAL' ? 'badge-manual' : 'badge-warn'}`;
    }
    if (gpsText) gpsText.textContent = worker.label;
  } else {
    if (gpsBadgeText) gpsBadgeText.textContent = 'SELECT BEAT';
    if (gpsBadge) gpsBadge.className = 'badge-status badge-bad';
    if (gpsText) gpsText.textContent = 'Select Beat';
  }

  // 2. Feed badge
  const fs = live.feedStatus();
  const feedBadge = document.getElementById('feed-badge');
  const feedBadgeText = document.getElementById('feed-badge-text');
  if (drillState) {
    if (feedBadgeText) feedBadgeText.textContent = 'SIMULATION DRILL';
    if (feedBadge) feedBadge.className = 'badge-status badge-sim';
  } else {
    if (feedBadgeText) {
      feedBadgeText.textContent = fs.state === 'LIVE'
        ? 'LIVE NTES FEED'
        : fs.state === 'STALE'
        ? `FEED ${Math.round(fs.ageS / 60)}m OLD`
        : 'SCHEDULE MODE';
    }
    if (feedBadge) {
      feedBadge.className = `badge-status ${fs.state === 'LIVE' ? 'badge-ok' : fs.state === 'STALE' ? 'badge-warn' : 'badge-neutral'}`;
    }
  }

  // 3. Status Band
  const p = r.primary;
  const lvl = p ? p.level : LEVEL.NONE;
  document.body.dataset.level = r.noLocation ? 'NOLOC' : LEVEL_NAME[lvl];

  const statusEn = document.getElementById('status-en');
  const statusTe = document.getElementById('status-te');
  if (statusEn) statusEn.textContent = r.noLocation ? 'SELECT WORK BEAT' : LEVEL_EN[lvl];
  if (statusTe) statusTe.textContent = r.noLocation ? 'మీ బీట్ ఎంచుకోండి' : LEVEL_TE[lvl];

  // 4. Primary Threat Card & Acknowledge Button
  const threatCard = document.getElementById('threat');
  const ackBtn = document.getElementById('ack');
  if (threatCard) threatCard.hidden = !p;
  if (ackBtn) ackBtn.hidden = !p || lvl < LEVEL.WARN || !armed;

  if (p) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('t-no', p.no);
    set('t-name', p.name);
    set('t-line', LINE_LABEL[p.line] || p.line);
    set('t-dist', p.atSite ? 'AT SITE' : `${Math.max(0, p.dLeadKm).toFixed(1)}`);
    set('t-eta', p.atSite ? '0:00' : fmtClock(p.etaLowerS));
    set('t-speed', `${Math.round(p.speedKmh)} km/h`);

    const tPill = document.getElementById('t-pill');
    if (tPill) tPill.textContent = p.isSimulation ? `DRILL · ${LEVEL_NAME[p.level]}` : LEVEL_NAME[p.level];

    const tSrc = document.getElementById('t-src');
    if (tSrc) {
      if (p.isSimulation) {
        tSrc.textContent = 'SIMULATED';
        tSrc.dataset.state = 'sim';
      } else {
        tSrc.textContent = p.confirmed
          ? `LIVE · ${p.delayMin > 0 ? `+${p.delayMin}m late` : 'on time'}`
          : 'SCHEDULED';
        tSrc.dataset.state = p.confirmed ? 'ok' : 'warn';
      }
    }
    const extra = r.threats.length - 1;
    set('t-more', extra > 0 ? `+${extra} more on active line` : '');
  }

  // 5. Corridor Radar (with dynamic nearby station markers)
  renderRadar(worker, [...r.threats, ...r.ambient]);

  // 6. Corridor Traffic List
  const ambientList = document.getElementById('ambient');
  if (ambientList) {
    const allItems = [...r.threats, ...r.ambient].slice(0, 12);
    if (allItems.length > 0) {
      ambientList.innerHTML = allItems.map(a => `
        <li data-active="${a.active}" data-line="${a.line}" data-level="${LEVEL_NAME[a.level]}" data-sim="${Boolean(a.isSimulation)}">
          <span class="amb-no">${a.no}</span>
          <span class="amb-name">${escapeHtml(a.name)}</span>
          <span class="amb-src">${a.isSimulation ? 'DRILL' : a.confirmed ? 'LIVE' : 'SCHED'}</span>
          <span class="amb-dir">${a.line}</span>
          <span class="amb-dist">${a.dLeadKm > 0 ? `${a.dLeadKm.toFixed(1)} km` : a.confirmed ? 'Passing' : 'Due'}</span>
          <span class="amb-eta">${a.dLeadKm > 0 ? fmtClock(a.etaLowerS) : '—'}</span>
        </li>`).join('');
    } else {
      ambientList.innerHTML = '<li class="empty">No scheduled or live trains within 30 minutes for this beat. Tap Safety Drill above to preview alert behavior.</li>';
    }
  }

  // Session button critical state
  const smbBtn = document.getElementById('session-mega-btn');
  if (smbBtn && armed) {
    smbBtn.classList.toggle('session-danger', lvl === LEVEL.CRITICAL);
    const dot = document.getElementById('smb-dot');
    if (dot) dot.className = `smb-status-dot ${lvl === LEVEL.CRITICAL ? 'dot-crit' : 'dot-on'}`;
  }
}

const RADAR_KM = 20;
function renderRadar(worker, rows) {
  const trainsLayer = document.getElementById('radar-trains');
  const stationsLayer = document.getElementById('radar-stations');
  const workerLabel = document.getElementById('radar-worker-km');

  if (!worker || !Number.isFinite(worker.km)) {
    if (trainsLayer) trainsLayer.innerHTML = '';
    if (stationsLayer) stationsLayer.innerHTML = '';
    if (workerLabel) workerLabel.textContent = 'YOU';
    return;
  }

  const x = km => 300 + ((km - worker.km) / RADAR_KM) * 276;
  if (workerLabel) workerLabel.textContent = `YOU · km ${worker.km.toFixed(1)}`;

  // Dynamic nearby stations inside ±20 km corridor window
  if (stationsLayer) {
    stationsLayer.innerHTML = STATIONS
      .filter(s => Math.abs(s.km - worker.km) <= RADAR_KM && Math.abs(s.km - worker.km) >= 1.2)
      .map(s => {
        const sx = Math.max(24, Math.min(576, x(s.km)));
        return `<g class="radar-stn">
          <line x1="${sx}" y1="30" x2="${sx}" y2="112" stroke="currentColor" stroke-dasharray="2 3" opacity="0.28"/>
          <text x="${sx}" y="74" text-anchor="middle">${s.code}</text>
        </g>`;
      }).join('');
  }

  if (trainsLayer) {
    trainsLayer.innerHTML = rows
      .filter(t => Number.isFinite(t.kmNominal) && Math.abs(t.kmNominal - worker.km) <= RADAR_KM)
      .map(t => {
        const y = t.dir === 'UP' ? 42 : 98;
        const cx = Math.max(20, Math.min(580, x(t.kmNominal)));
        const lead = Math.max(20, Math.min(580, x(t.kmLead)));
        const arrow = t.dir === 'UP'
          ? `M${cx - 8},${y - 7} L${cx + 9},${y} L${cx - 8},${y + 7} Z`
          : `M${cx + 8},${y - 7} L${cx - 9},${y} L${cx + 8},${y + 7} Z`;
        const labelY = t.dir === 'UP' ? y - 12 : y + 19;
        const lvlCls = t.isSimulation ? 'lvl-SIM' : `lvl-${LEVEL_NAME[t.level]}`;
        return `<g class="rt ${lvlCls}" data-active="${t.active}">
          <line x1="${Math.min(cx, lead)}" x2="${Math.max(cx, lead)}" y1="${y}" y2="${y}" class="env"/>
          <path d="${arrow}"/>
          <text x="${cx}" y="${labelY}" text-anchor="middle">${t.no}</text>
        </g>`;
      }).join('');
  }
}

async function renderAlertAuditLog() {
  const list = document.getElementById('alert-log-list');
  if (!list) return;
  const logs = await getAlertLogs(25);
  if (logs.length === 0) {
    list.innerHTML = '<li class="empty">No warning or critical alerts recorded during armed shifts yet.</li>';
    return;
  }
  list.innerHTML = logs.map(l => {
    const timeStr = new Date(l.timestamp).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
    });
    return `<li class="alert-log-row" data-level="${l.level}">
      <span class="al-lvl">${escapeHtml(l.level)}</span>
      <span class="al-main"><strong>${escapeHtml(l.trainNo)}</strong> ${escapeHtml(l.trainName || '')} (${escapeHtml(l.line || '')})</span>
      <span class="al-meta">${l.distanceKm != null ? `${l.distanceKm} km` : ''} · ${timeStr}</span>
    </li>`;
  }).join('');
}

// ── Tab Navigation (strict hidden + aria-selected + hash sync) ───────────────
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.screen, true));
  });
}

function navigateTo(screenId, updateHash = true) {
  document.querySelectorAll('.screen').forEach(s => {
    const match = s.id === `screen-${screenId}`;
    s.classList.toggle('active', match);
    s.hidden = !match;
  });

  document.querySelectorAll('.nav-btn').forEach(b => {
    const match = b.dataset.screen === screenId;
    b.classList.toggle('active', match);
    b.setAttribute('aria-selected', String(match));
    if (match) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  if (updateHash && window.location.hash !== `#${screenId}`) {
    history.replaceState(null, '', `#${screenId}`);
  }

  document.getElementById('main-content')?.scrollTo({ top: 0 });

  if (screenId === 'defect'  && !window._defectInit)  { initDefectReport(getDefectElements());  window._defectInit  = true; }
  if (screenId === 'diary'   && !window._diaryInit)   { initGangDiary(getDiaryElements());      window._diaryInit   = true; }
  if (screenId === 'weather' && !window._weatherInit) { initWeatherAlert(getWeatherElements()); window._weatherInit = true; }
  if (screenId === 'manual'  && !window._manualInit)  { initPWManual(getManualElements());      window._manualInit  = true; }
}

// ── Emergency Line Protection Sheet (SOS) ────────────────────────────────────
function setupSOSModal() {
  const overlay = document.getElementById('sos-overlay');
  document.getElementById('btn-sos')?.addEventListener('click', openSOS);
  document.getElementById('btn-close-sos')?.addEventListener('click', closeSOS);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeSOS(); });

  document.getElementById('btn-copy-sos-loc')?.addEventListener('click', async () => {
    const loc = window._currentLocationLabel || 'km 293.0 · SKM (15.2380°N, 80.0270°E)';
    const gang = localStorage.getItem('gang_no') || '—';
    const mate = localStorage.getItem('mate_name') || '—';
    const msg = `RAILWAY EMERGENCY — RailRaksha\nLocation: ${loc}\nGang: ${gang} | Mate: ${mate}\nLine: ${engine.mode}\nTime: ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
    try {
      await navigator.clipboard.writeText(msg);
      showToast('Emergency location message copied', 'ok');
    } catch {
      showToast('Location: ' + loc, 'info');
    }
  });
}

function openSOS() {
  const overlay = document.getElementById('sos-overlay');
  if (!overlay) return;
  const locEl = document.getElementById('sos-current-loc');
  if (locEl) locEl.textContent = window._currentLocationLabel || 'km 293.0 · SKM';

  const pwiRow = document.getElementById('sos-pwi-link');
  const pwiPhone = (getConfig('pwi_phone') || '').replace(/[^+\d]/g, '');
  if (pwiRow) {
    if (pwiPhone) {
      pwiRow.hidden = false;
      pwiRow.href = `tel:${pwiPhone}`;
      const numEl = document.getElementById('sos-pwi-number');
      if (numEl) numEl.textContent = getConfig('pwi_phone');
    } else {
      pwiRow.hidden = true;
    }
  }

  overlay.hidden = false;
  document.getElementById('btn-close-sos')?.focus();
}

function closeSOS() {
  const overlay = document.getElementById('sos-overlay');
  if (overlay) overlay.hidden = true;
}

// ── Settings Modal ────────────────────────────────────────────────────────────
const SETTING_FIELDS = [
  'mate_name', 'gang_no', 'gang_strength', 'section', 'pwi_phone',
  'work_station_a', 'work_station_b',
  'voice_lang', 'theme',
  'ai_base_url', 'ai_model', 'ai_api_key',
  'owm_api_key', 'railradar_key',
  'alert_dist_critical', 'alert_dist_warn', 'alert_dist_prepare',
  'alert_min_critical',  'alert_min_warn',  'alert_min_prepare',
];

function populateStationSelects() {
  const opts = STATIONS.map(s => `<option value="${s.code}">${s.code} — ${s.name} (km ${s.km})</option>`).join('');
  ['setting-work_station_a', 'setting-work_station_b'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
}

function loadSettings() {
  SETTING_FIELDS.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) el.value = getConfig(key) || '';
  });

  document.querySelectorAll('.btn-toggle-visibility').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
      }
    });
  });
}

function setupSettings() {
  const overlay = document.getElementById('settings-overlay');
  document.getElementById('btn-settings')?.addEventListener('click', openSettings);
  document.getElementById('btn-close-settings')?.addEventListener('click', closeSettings);
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });

  document.getElementById('btn-export-backup')?.addEventListener('click', async () => {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `railraksha-backup-${getISTDateISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Offline field data exported (JSON)', 'ok');
  });
}

async function openSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (!overlay) return;
  loadSettings();
  overlay.hidden = false;
  document.getElementById('btn-close-settings')?.focus();

  const statusEl = document.getElementById('edge-health-status');
  if (statusEl) {
    statusEl.textContent = 'Checking Cloudflare edge endpoints...';
    const health = await checkServerHealth();
    if (health.offline) {
      statusEl.textContent = 'Offline — local PWA, timetable, diary, defects & IRPWM active';
    } else if (health.reachable && health.services) {
      const aiTxt = health.services.ai?.configured ? `AI Proxy: Ready (${health.services.ai.provider})` : 'AI Proxy: Server key pending (Offline fallback active)';
      const liveTxt = health.services.liveTrains?.configured ? 'Live Feed: RailRadar v1' : 'Live Feed: Schedule Mode';
      statusEl.textContent = `Cloudflare Edge Connected · ${aiTxt} · ${liveTxt} · Weather: Open-Meteo`;
    } else {
      statusEl.textContent = 'Local preview mode — Cloudflare Worker APIs activate on railraksha.tech';
    }
  }
}

function closeSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.hidden = true;
}

function saveSettings() {
  SETTING_FIELDS.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) localStorage.setItem(key, el.value.trim());
  });
  applyTheme(getConfig('theme'));
  syncEngineConfig();
  closeSettings();
  updateHeaderName();
  window.dispatchEvent(new CustomEvent('railraksha:settings-updated'));
  loop();
  showToast('Settings saved', 'ok');
}

function updateHeaderName() {
  const name = localStorage.getItem('mate_name') || '';
  const gang = localStorage.getItem('gang_no') || '';
  const stA = getConfig('work_station_a') || 'SKM';
  const stB = getConfig('work_station_b') || 'UPD';
  const el = document.getElementById('header-subtitle');
  if (!el) return;
  if (name || gang) {
    el.textContent = [name, gang ? `Gang ${gang}` : '', `${stA}–${stB}`].filter(Boolean).join(' · ');
  } else {
    el.textContent = `${stA}–${stB} · Vijayawada Div.`;
  }
}

// ── Toast System ──────────────────────────────────────────────────────────────
let toastTimer = null;
function setupToastSystem() {
  window.addEventListener('showToast', (e) => showToast(e.detail.msg, e.detail.type));
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const icons = {
    ok: Icons.check(16, '#22C55E'),
    warn: Icons.alert(16, '#F59E0B'),
    error: Icons.alertCircle(16, '#EF4444'),
    info: Icons.info(16, '#94A3B8'),
  };
  const iconEl = toast.querySelector('.toast-icon');
  const msgEl = toast.querySelector('.toast-msg');
  if (iconEl) iconEl.innerHTML = icons[type] || icons.info;
  if (msgEl) msgEl.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ── Element Maps ──────────────────────────────────────────────────────────────
function getDefectElements() {
  return {
    captureZone: document.getElementById('capture-zone'),
    capturePlaceholder: document.getElementById('capture-placeholder'),
    fileInput: document.getElementById('defect-file-input'),
    uploadInput: document.getElementById('defect-upload-input'),
    btnCamera: document.getElementById('btn-camera'),
    btnUpload: document.getElementById('btn-upload'),
    imagePreview: document.getElementById('captured-image-preview'),
    photoActionRow: document.getElementById('photo-action-row'),
    btnAnalyze: document.getElementById('btn-analyze-defect'),
    btnRetake: document.getElementById('btn-retake-photo'),
    btnToggleManualDefect: document.getElementById('btn-toggle-manual-defect'),
    manualDefectPanel: document.getElementById('manual-defect-panel'),
    offlineDefectSelect: document.getElementById('offline-defect-select'),
    offlineDefectNotes: document.getElementById('offline-defect-notes'),
    btnLogOfflineDefect: document.getElementById('btn-log-offline-defect'),
    defectAnalysisCard: document.getElementById('defect-analysis-card'),
    defectTypeBadge: document.getElementById('defect-type-badge'),
    detailSeverity: document.getElementById('detail-severity'),
    detailConfidence: document.getElementById('detail-confidence'),
    detailIRPWM: document.getElementById('detail-irpwm'),
    detailSpeed: document.getElementById('detail-speed'),
    detailGPS: document.getElementById('detail-gps'),
    detailTime: document.getElementById('detail-time'),
    detailGeneralInfo: document.getElementById('detail-general-info'),
    detailDescription: document.getElementById('detail-description'),
    recommendedAction: document.getElementById('recommended-action'),
    irpwmReference: document.getElementById('irpwm-reference'),
    btnShareReport: document.getElementById('btn-share-report'),
    btnNewDefect: document.getElementById('btn-new-defect'),
    defectFilterBar: document.getElementById('defect-filter-bar'),
    btnExportDefects: document.getElementById('btn-export-defects'),
    defectHistoryList: document.getElementById('defect-history-list'),
  };
}

function getDiaryElements() {
  return {
    diaryDateText: document.getElementById('diary-date-text'),
    diaryGangInfo: document.getElementById('diary-gang-info'),
    attendanceInput: document.getElementById('attendance-input'),
    btnAttMinus: document.getElementById('btn-att-minus'),
    btnAttPlus: document.getElementById('btn-att-plus'),
    attendanceCount: document.getElementById('attendance-count'),
    attendanceBar: document.getElementById('attendance-bar'),
    attendanceSub: document.getElementById('attendance-sub'),
    speechLangToggle: document.getElementById('speech-lang-toggle'),
    btnRecord: document.getElementById('btn-record'),
    btnRecordLabel: document.getElementById('btn-record-label'),
    btnClearNotes: document.getElementById('btn-clear-notes'),
    voiceTitle: document.getElementById('voice-title'),
    voiceSub: document.getElementById('voice-sub'),
    micEmoji: document.getElementById('mic-emoji'),
    notesInput: document.getElementById('diary-notes-input'),
    diaryPhraseChips: document.getElementById('diary-phrase-chips'),
    btnGenerateDiary: document.getElementById('btn-generate-diary'),
    diaryEntryCard: document.getElementById('diary-entry-card'),
    entryDate: document.getElementById('entry-date'),
    entryTime: document.getElementById('entry-time'),
    entryGang: document.getElementById('entry-gang'),
    entryAttendance: document.getElementById('entry-attendance'),
    entryWorkDone: document.getElementById('entry-work-done'),
    entryMaterials: document.getElementById('entry-materials'),
    entryDefects: document.getElementById('entry-defects'),
    entrySafety: document.getElementById('entry-safety'),
    entrySpecial: document.getElementById('entry-special'),
    entryRemarks: document.getElementById('entry-remarks'),
    entryTelugu: document.getElementById('entry-telugu'),
    btnSaveDiary: document.getElementById('btn-save-diary'),
    btnShareDiary: document.getElementById('btn-share-diary'),
    diaryHistoryScope: document.getElementById('diary-history-scope'),
    btnExportDiary: document.getElementById('btn-export-diary'),
    todayEntriesCount: document.getElementById('today-entries-count'),
    savedEntriesList: document.getElementById('saved-entries-list'),
  };
}

function getWeatherElements() {
  return {
    weatherIcon: document.getElementById('weather-icon-large'),
    weatherLocation: document.getElementById('weather-location-text'),
    weatherTemp: document.getElementById('weather-temp'),
    weatherRailTemp: document.getElementById('weather-rail-temp'),
    weatherDesc: document.getElementById('weather-desc'),
    weatherHumidity: document.getElementById('weather-humidity'),
    weatherWind: document.getElementById('weather-wind'),
    weatherRain: document.getElementById('weather-rain'),
    weatherForecastRain: document.getElementById('weather-forecast-rain'),
    railThermalBar: document.getElementById('rail-thermal-bar'),
    railThermalStatus: document.getElementById('rail-thermal-status'),
    riskList: document.getElementById('risk-list'),
    btnRefreshWeather: document.getElementById('btn-refresh-weather'),
  };
}

function getManualElements() {
  return {
    searchInput: document.getElementById('manual-search-input'),
    btnSearch: document.getElementById('btn-manual-search'),
    btnVoiceSearch: document.getElementById('btn-voice-search'),
    manualCategoryBar: document.getElementById('manual-category-bar'),
    rulesCountLabel: document.getElementById('rules-count-label'),
    manualAnswerCard: document.getElementById('manual-answer-card'),
    maaTitle: document.getElementById('maa-title'),
    maaBody: document.getElementById('maa-body'),
    maaSource: document.getElementById('maa-source'),
    btnCopyRule: document.getElementById('btn-copy-rule'),
    quickRulesList: document.getElementById('quick-rules-list'),
  };
}
