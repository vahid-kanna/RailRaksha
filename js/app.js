/**
 * RailRaksha — Main Application Controller v8.3 (app.js)
 *
 * Live-Data-First Corridor Safety Instrument:
 *   - Primary Live Feed: Cloudflare Worker `/api/corridor-live` (irctc.dev / RailCore / RailRadar failover)
 *   - Strict Offline Fallback: 53-train corridor schedule activates automatically only when offline/unreached
 *   - Physical Tactile Instrument UI: 232px machined proximity dial, 3-layer pushable keys,
 *     physical rocker switches, precision closure meter, calibrated 7-bar sparkline & debossed screens
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
  openDB, getSetting, setSetting, logAlert, getAlertLogs, clearAlertLogs, exportAllData, getISTDateISO,
} from './db.js';
import { applyDefaultsOnce, getConfig, getConfigNum } from './config.js';
import { checkServerHealth } from './ai-engine.js';
import { Icons } from './icons.js';

window.getConfig = getConfig;

function pulseHaptic(ms = 25) {
  if (!navigator.userActivation || navigator.userActivation.isActive) {
    navigator.vibrate?.(ms);
  }
}

function getRailRadarHeaders() {
  const headers = {};
  const irctcKey = (getConfig('irctc_dev_key') || '').trim();
  const rrKey = (getConfig('railradar_key') || '').trim();
  const rcKey = (getConfig('railcore_key') || '').trim();
  if (irctcKey) headers['X-IRCTC-Key'] = irctcKey;
  if (rrKey) headers['X-RailRadar-Key'] = rrKey;
  if (rcKey) headers['X-RailCore-Key'] = rcKey;
  return headers;
}

// ── Preferences Store ────────────────────────────────────────────────────────
const store = {
  get mode() { return localStorage.getItem('rr.trackMode') || TRACK_MODE.BOTH; },
  set mode(v) { localStorage.setItem('rr.trackMode', v); },
  get lang() { return getConfig('voice_lang') || 'te+en'; },
  get theme() { return getConfig('theme') === 'night' ? 'night' : 'light'; },
  set theme(v) { localStorage.setItem('theme', v); },
  get voiceOn() { return getConfig('voice_enabled') !== '0'; },
  set voiceOn(v) { localStorage.setItem('voice_enabled', v ? '1' : '0'); },
  get preferLive() { return getConfig('prefer_live') !== '0'; },
  set preferLive(v) { localStorage.setItem('prefer_live', v ? '1' : '0'); },
};

// ── Live Corridor Fetcher (Cloudflare Worker `/api/corridor-live` FIRST) ─────
async function fetchCorridorLive(signal, forceFresh = false) {
  const qs = [];
  if (forceFresh) qs.push('fresh=1');
  if (getConfig('quota_saver') === '1') qs.push('quota_saver=1');
  const url = qs.length ? `/api/corridor-live?${qs.join('&')}` : '/api/corridor-live';
  const r = await fetch(url, { signal, cache: 'no-store', headers: getRailRadarHeaders() });
  if (!r.ok) throw new Error(`Corridor feed HTTP ${r.status}`);
  return await r.json();
}

async function fetchLive(trainNo, runDateISO, signal) {
  if (!/^\d{4,5}$/.test(String(trainNo))) throw new Error('Non-NTES freight slot');
  const qs = `train=${encodeURIComponent(trainNo)}&date=${encodeURIComponent(runDateISO)}`;
  const r = await fetch(`/api/live-status?${qs}`, { signal, cache: 'no-store', headers: getRailRadarHeaders() });
  if (r.ok) return await r.json();
  throw new Error('Live status unavailable');
}

// ── Safety Engines ───────────────────────────────────────────────────────────
const gps = new GpsTracker();
const live = new LiveTrainService({ fetchCorridorLive, fetchLive });
live.preferLive = store.preferLive;

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
let gpsWatching = false;
let wakeLock = null;
let timerInterval = null;
let activeTrafficTab = 'trains';
let lastLoggedThreatKey = null;
let drillState = null;

// ── Simulation Drill (130 km/h Vande Bharat Approach -> Critical -> Receding) ─
function startDrill() {
  const worker = gps.getPosition();
  if (!worker) {
    showToast('Select a beat chip before starting a drill', 'warn');
    return;
  }
  const dir = engine.mode === TRACK_MODE.DN ? 'DN' : 'UP';
  const no = dir === 'DN' ? '20678' : '20677';
  const sign = dir === 'UP' ? 1 : -1;
  const sigmaKm = (worker.sigmaM ?? 0) / 1000;
  ['DRILL-12711', 'DRILL-20677', 'DRILL-20678'].forEach(k => engine.mem.delete(k));
  drillState = {
    startedAtMs: Date.now(),
    dir,
    no,
    key: `DRILL-${no}`,
    sigmaKm,
    startKm: worker.km - sign * (11.5 + 0.2 + sigmaKm),
    speedKmh: 130,
    accel: 12.5,
  };
  updateDrillButton();
  loop();
  showToast(`130 km/h Vande Bharat (${no} ${dir}) drill active`, 'info');
}

function stopDrill(silent = false) {
  if (!drillState) return;
  drillState = null;
  ['DRILL-12711', 'DRILL-20677', 'DRILL-20678'].forEach(k => engine.mem.delete(k));
  const bannerTxt = document.querySelector('#drill-banner .drill-strip-text');
  if (bannerTxt) bannerTxt.textContent = 'SIMULATION DRILL · NOT LIVE TRAFFIC';
  if (!armed) siren.set(LEVEL.NONE);
  updateDrillButton();
  loop();
  if (!silent) showToast('Simulation drill ended', 'info');
}

function updateDrillButton() {
  const btn = document.getElementById('btn-drill');
  const banner = document.getElementById('drill-banner');
  if (btn) {
    btn.classList.toggle('pressed', Boolean(drillState));
    btn.setAttribute('aria-pressed', String(Boolean(drillState)));
    const lbl = btn.querySelector('.drill-btn-label');
    if (lbl) lbl.textContent = drillState ? 'End Drill' : 'Run Drill';
  }
  if (banner) banner.hidden = !drillState;
}

function getDrillTrainState(worker, nowMs) {
  if (!drillState || !worker) return null;
  const sign = drillState.dir === 'UP' ? 1 : -1;
  const elapsedH = ((nowMs - drillState.startedAtMs) / 3600000) * drillState.accel;
  const kmNominal = drillState.startKm + sign * drillState.speedKmh * elapsedH;
  const kmLead = kmNominal + sign * 0.2;
  const kmLag = kmNominal - sign * 0.2;

  const distPast = (kmNominal - worker.km) * sign;
  const sigmaKm = (worker.sigmaM ?? drillState.sigmaKm * 1000) / 1000;
  if (distPast > sigmaKm + 3.2) {
    stopDrill(true);
    showToast('Drill complete — 130 km/h Vande Bharat cleared (0 false alarms)', 'ok');
    return null;
  }

  const dLag = (worker.km - kmLag) * sign + sigmaKm;
  const receding = dLag < -(0.4 + 0.2);

  return {
    key: drillState.key,
    no: drillState.no,
    name: 'Vande Bharat Express (DRILL)',
    te: 'వందే భారత్ ఎక్స్‌ప్రెస్ (డ్రిల్)',
    dir: drillState.dir,
    line: drillState.dir,
    vmaxKmh: 130,
    speedKmh: drillState.speedKmh,
    lengthKm: 0.4,
    source: 'DRILL',
    confirmed: true,
    isSimulation: true,
    receding,
    distPastKm: Math.max(0, distPast),
    dataAgeS: 0,
    delayMin: 0,
    phase: receding ? 'RECEDING' : 'RUNNING',
    kmNominal,
    kmLead,
    kmLag,
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
  live.preferLive = store.preferLive;
}

// ── Theme (Cool Titanium Light vs Machined Gunmetal Night) ───────────────────
function applyTheme(theme) {
  const mode = theme === 'night' ? 'night' : 'light';
  document.documentElement.dataset.theme = mode;
  store.theme = mode;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', mode === 'night' ? '#1B222C' : '#D4DCE5');

  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.setAttribute('aria-label', mode === 'night' ? 'Switch to Cool Titanium daylight finish' : 'Switch to Night Gunmetal finish');
    btn.setAttribute('title', mode === 'night' ? 'Cool Titanium (Day)' : 'Gunmetal (Night Shift)');
    btn.innerHTML = mode === 'night'
      ? `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
      : `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  }
}

// ── Top Bar Weather Chip (keyless Open-Meteo quick glance) ───────────────────
async function fetchQuickWeatherChip() {
  if (navigator.onLine === false) return;
  try {
    const pos = window._currentWorkerPos || { lat: 15.238, lon: 80.027 };
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat.toFixed(4)}&longitude=${pos.lon.toFixed(4)}&current=temperature_2m`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!r.ok) return;
    const d = await r.json();
    const t = d?.current?.temperature_2m;
    if (Number.isFinite(t)) updateTopWeatherChip(Math.round(t));
  } catch {}
}

function updateTopWeatherChip(tempC) {
  const el = document.getElementById('top-weather-temp');
  if (el && Number.isFinite(tempC)) el.textContent = `${Math.round(tempC)}°`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  applyDefaultsOnce();
  applyTheme(store.theme);
  syncEngineConfig();
  await openDB();
  const previousShiftActive = await getSetting('work_session_active', false);
  if (previousShiftActive) {
    await setSetting('work_session_active', false);
    await setSetting('session_start_time', null);
  }

  if (!gps.manual) {
    const defaultCode = STATION_BY_CODE[getConfig('work_station_a')] ? getConfig('work_station_a') : 'SKM';
    gps.setManualBeat(defaultCode, 0);
  }

  populateStationSelects();
  initDialTicks();
  loadSettings();
  setupNavigation();
  setupSettings();
  setupSOSModal();
  setupToastSystem();
  if (previousShiftActive) {
    showToast('Previous shift ended on reload — tap Arm Shift to monitor', 'info');
  }
  bindTrackSelector();
  bindBeatPicker();
  bindHardwareRockers();
  setupSessionButton();
  setupDrillButton();
  setupAcknowledgeButton();
  setupRefreshTrainsButton();
  setupTrafficTabs();

  // Top weather chip opens Weather screen
  document.getElementById('top-weather-chip')?.addEventListener('click', () => navigateTo('weather', true));
  window.addEventListener('railraksha:weather-updated', (e) => {
    if (Number.isFinite(e.detail?.temp)) updateTopWeatherChip(e.detail.temp);
  });

  // Theme toggle
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const next = store.theme === 'night' ? 'light' : 'night';
    applyTheme(next);
    const sel = document.getElementById('setting-theme');
    if (sel) sel.value = next;
    showToast(next === 'night' ? 'Night Gunmetal finish active' : 'Cool Titanium finish active', 'info');
  });

  window.addEventListener('online', () => {
    showToast('Online — live corridor feed available', 'ok');
    if (armed || !live.lastSuccessAt) pollCorridorNow(false);
  });
  window.addEventListener('offline', () => {
    showToast('Offline — switched to local corridor timetable', 'warn');
    loop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      closeSOS();
    }
  });

  const initialHash = window.location.hash.replace(/^#/, '');
  const validScreens = new Set(['train-alert', 'defect', 'diary', 'weather', 'manual']);
  if (validScreens.has(initialHash)) navigateTo(initialHash, false);

  // 1 Hz instrument update loop
  setInterval(loop, 1000);

  // Live-Data-First Corridor Poll (once on boot, then every 5 min only while shift is armed)
  const pollCorridorNow = async (forceFresh = false) => {
    if (navigator.onLine === false || !live.preferLive) return;
    const w = gps.getPosition();
    await live.poll(w?.km ?? 293, Date.now(), forceFresh);
    loop();
  };
  window._pollCorridorNow = pollCorridorNow;
  pollCorridorNow(false);
  setInterval(() => {
    if (armed) pollCorridorNow(false);
  }, 300000);

  loop();
  // Quick ambient temp for top bar chip (after loop sets _currentWorkerPos)
  fetchQuickWeatherChip();
  renderAlertAuditLog();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {});
  }
});

// ── Hardware Rocker Switches (Live Feed, Voice Audio, GPS Watch) ─────────────
function bindHardwareRockers() {
  const liveBtn = document.getElementById('toggle-live-feed');
  const voiceBtn = document.getElementById('toggle-voice');
  const gpsBtn = document.getElementById('toggle-gps');

  const syncRockers = () => {
    if (liveBtn) {
      liveBtn.classList.toggle('on', live.preferLive);
      liveBtn.setAttribute('aria-checked', String(live.preferLive));
    }
    if (voiceBtn) {
      voiceBtn.classList.toggle('on', store.voiceOn);
      voiceBtn.setAttribute('aria-checked', String(store.voiceOn));
      const cap = document.getElementById('voice-status-cap');
      if (cap) cap.textContent = store.voiceOn ? (store.lang === 'en' ? 'English' : store.lang === 'te' ? 'Telugu' : 'Telugu + EN') : 'Muted';
      const vu = document.getElementById('audio-vu');
      if (vu) vu.classList.toggle('vu-off', !store.voiceOn);
      const iw = document.getElementById('voice-icon-well');
      if (iw) iw.classList.toggle('well-lit', store.voiceOn);
    }
    if (gpsBtn) {
      gpsBtn.classList.toggle('on', gpsWatching);
      gpsBtn.setAttribute('aria-checked', String(gpsWatching));
      const iw = document.getElementById('gps-icon-well');
      if (iw) iw.classList.toggle('well-lit', gpsWatching);
    }
  };
  window._syncRockers = syncRockers;
  syncRockers();

  liveBtn?.addEventListener('click', () => {
    store.preferLive = !store.preferLive;
    live.preferLive = store.preferLive;
    pulseHaptic(25);
    syncRockers();
    if (live.preferLive) {
      window._pollCorridorNow?.(false);
      showToast('Live RailRadar corridor feed enabled', 'ok');
    } else {
      showToast('Offline corridor timetable fallback selected', 'info');
    }
    loop();
  });

  voiceBtn?.addEventListener('click', () => {
    store.voiceOn = !store.voiceOn;
    if (!store.voiceOn) {
      siren.set(LEVEL.NONE);
      try { window.speechSynthesis?.cancel(); } catch {}
    }
    pulseHaptic(25);
    syncRockers();
    showToast(store.voiceOn ? 'Voice & siren audio armed' : 'Audio muted (visual alerts active)', 'info');
  });

  gpsBtn?.addEventListener('click', () => {
    gpsWatching = !gpsWatching;
    pulseHaptic(25);
    if (gpsWatching) {
      gps.start();
      showToast('Live GPS corridor tracking enabled', 'info');
    } else {
      gps.stop();
      showToast('Locked to manual beat station', 'info');
    }
    syncRockers();
    loop();
  });
}

// ── Session & Control Keys ───────────────────────────────────────────────────
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
    pulseHaptic(60);
    loop();
    showToast('Siren silenced briefly (critical voice stays armed)', 'info');
  });
}

function setupRefreshTrainsButton() {
  document.getElementById('btn-refresh-trains')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-trains');
    btn?.classList.add('pressed');
    if (navigator.onLine === false || !live.preferLive) {
      loop();
      showToast('Offline schedule recalculated', 'info');
    } else {
      showToast('Syncing live OGL · SKM · NLR boards...', 'info');
      await window._pollCorridorNow?.(true);
      const fs = live.feedStatus();
      if (fs.state === 'LIVE') {
        showToast(`Live sync complete — ${fs.liveCount} trains tracked`, 'ok');
      } else if (fs.state === 'QUOTA') {
        showToast('RailRadar API quota reached — schedule fallback active', 'warn');
      } else {
        showToast('Live sync delayed — fallback active', 'warn');
      }
    }
    setTimeout(() => btn?.classList.remove('pressed'), 280);
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
  gpsWatching = true;
  document.body.dataset.armed = 'true';
  gps.start();
  window._syncRockers?.();

  await setSetting('work_session_active', true);
  await setSetting('session_start_time', new Date().toISOString());

  const btn = document.getElementById('session-mega-btn');
  btn?.classList.add('pressed');
  btn?.setAttribute('aria-pressed', 'true');
  const titleEl = document.getElementById('smb-title');
  if (titleEl) titleEl.textContent = 'Armed';
  const timerEl = document.getElementById('smb-timer');
  if (timerEl) { timerEl.hidden = false; timerEl.textContent = '00:00'; }

  startSessionTimer();
  loop();
  showToast('Shift armed — proximity audio, haptics & GPS active', 'ok');
}

async function deactivateSession() {
  armed = false;
  gpsWatching = false;
  document.body.dataset.armed = 'false';
  gps.stop();
  siren.set(LEVEL.NONE);
  window._syncRockers?.();

  if (wakeLock) {
    try { await wakeLock.release(); } catch {}
    wakeLock = null;
  }
  await setSetting('work_session_active', false);
  await setSetting('session_start_time', null);

  const btn = document.getElementById('session-mega-btn');
  btn?.classList.remove('pressed');
  btn?.setAttribute('aria-pressed', 'false');
  const titleEl = document.getElementById('smb-title');
  if (titleEl) titleEl.textContent = 'Arm Shift';
  const timerEl = document.getElementById('smb-timer');
  if (timerEl) timerEl.hidden = true;

  clearInterval(timerInterval);
  loop();
  showToast('Shift disarmed', 'info');
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
        ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
        : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
  }, 1000);
}

// ── Track Mode & Horizontal Beat Chip Row ────────────────────────────────────
function bindTrackSelector() {
  document.querySelectorAll('[data-track]').forEach(btn => {
    btn.addEventListener('click', () => {
      engine.setMode(btn.dataset.track);
      engine.mem.clear();
      store.mode = btn.dataset.track;
      pulseHaptic(25);
      renderTrackSelector();
      loop();
    });
  });
  renderTrackSelector();
}

function renderTrackSelector() {
  document.querySelectorAll('[data-track]').forEach(b => {
    const active = b.dataset.track === engine.mode;
    b.setAttribute('aria-checked', String(active));
    b.classList.toggle('pressed', active);
  });
  document.body.dataset.track = engine.mode;
}

// Order core SKM–UPD beat stations first for instant thumb reach, followed by full corridor
const BEAT_ORDER = ['SKM', 'UPD', 'INGR', 'TGU', 'OGL', 'KVZ', 'NLR', 'GDR', 'ANB', 'CL', 'BPP', 'TEL', 'BZA', 'BVRT'];

function bindBeatPicker() {
  const grid = document.getElementById('beat-grid');
  if (grid) {
    const ordered = BEAT_ORDER.map(c => STATION_BY_CODE[c]).filter(Boolean);
    grid.innerHTML = ordered.map(s => `
      <button type="button" class="beat-chip" data-code="${s.code}" title="${s.name} · km ${s.km}">
        <span class="chip-pilot" aria-hidden="true"></span>
        <span>${s.code}</span>
      </button>`).join('');

    grid.addEventListener('click', e => {
      const b = e.target.closest('[data-code]');
      if (!b) return;
      gps.setManualBeat(b.dataset.code);
      engine.mem.clear();
      pulseHaptic(25);
      highlightSelectedBeat();
      loop();
      showToast(`Beat set to ${b.dataset.code} · km ${STATION_BY_CODE[b.dataset.code]?.km}`, 'ok');
    });
  }
  highlightSelectedBeat();

  document.getElementById('nudge-minus')?.addEventListener('click', () => { gps.nudgeManual(-0.5); engine.mem.clear(); loop(); });
  document.getElementById('nudge-plus')?.addEventListener('click', () => { gps.nudgeManual(+0.5); engine.mem.clear(); loop(); });
}

function highlightSelectedBeat() {
  const activeCode = gps.manual?.code;
  document.querySelectorAll('#beat-grid .beat-chip').forEach(btn => {
    const sel = btn.dataset.code === activeCode;
    btn.classList.toggle('pressed', sel);
    btn.setAttribute('aria-pressed', String(sel));
  });
}

// ── 1 Hz Safety & Telemetry Render Loop ──────────────────────────────────────
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

  const drillTrain = getDrillTrainState(worker, now);
  const trains = drillTrain ? [drillTrain] : live.getTrainStates(worker?.km, now);

  const result = engine.update(worker, trains, now);

  if (armed) {
    if (store.voiceOn) {
      orchestrator.process(result);
    } else {
      siren.set(LEVEL.NONE);
    }
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

  render(worker, result, trains, drillTrain);
}

const fmtClock = s => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const LEVEL_TE = {
  0: 'సురక్షితం',
  1: 'సురక్షితం',
  2: 'సిద్ధంగా ఉండండి',
  3: 'జాగ్రత్త · సామాను తొలగించండి',
  4: 'ప్రమాదం · ఖాళీ చేయండి!',
};

const DIAL_CIRCUMFERENCE = 527.79; // 2 * pi * 84

function initDialTicks() {
  const g = document.getElementById('dial-ticks');
  if (!g || g.childElementCount > 0) return;
  const ns = 'http://www.w3.org/2000/svg';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 60; i++) {
    const rad = (i * 6 * Math.PI) / 180;
    const major = i % 5 === 0;
    const r1 = major ? 90.5 : 93;
    const r2 = 96.5;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', (100 + r1 * Math.cos(rad)).toFixed(2));
    line.setAttribute('y1', (100 + r1 * Math.sin(rad)).toFixed(2));
    line.setAttribute('x2', (100 + r2 * Math.cos(rad)).toFixed(2));
    line.setAttribute('y2', (100 + r2 * Math.sin(rad)).toFixed(2));
    line.setAttribute('class', major ? 'dial-tick major' : 'dial-tick');
    frag.appendChild(line);
  }
  g.appendChild(frag);
}

function render(worker, r, allCorridorTrains, drillTrain = null) {
  const p = r.primary;
  const lvl = p ? p.level : LEVEL.NONE;
  document.body.dataset.level = r.noLocation ? 'NOLOC' : LEVEL_NAME[lvl];

  const drillBannerTxt = document.querySelector('#drill-banner .drill-strip-text');
  if (drillBannerTxt && drillState && drillTrain) {
    if (p?.isSimulation && p.atSite) {
      drillBannerTxt.textContent = `DRILL · ${drillTrain.no} VB 130 KM/H · PASSING`;
    } else if (p?.isSimulation && lvl === LEVEL.CRITICAL) {
      drillBannerTxt.textContent = `DRILL · ${drillTrain.no} VB 130 KM/H · CRITICAL`;
    } else if (p?.isSimulation && lvl === LEVEL.WARN) {
      drillBannerTxt.textContent = `DRILL · ${drillTrain.no} VB 130 KM/H · WARN`;
    } else if (p?.isSimulation) {
      drillBannerTxt.textContent = `DRILL · ${drillTrain.no} VB 130 KM/H · PREPARE`;
    } else if (drillTrain.receding) {
      drillBannerTxt.textContent = `DRILL · ${drillTrain.no} RECEDING · CLEARED (0 FALSE ALARM)`;
    }
  }

  const fs = live.feedStatus();
  const isOnline = navigator.onLine !== false;

  // 1. Feed Well inside Dial Card
  const feedText = document.getElementById('feed-badge-text');
  const feedDot = document.getElementById('feed-dot');
  if (drillState) {
    if (feedText) feedText.textContent = 'DRILL';
    if (feedDot) feedDot.className = 'pilot-dot dot-live';
  } else if (!isOnline || !live.preferLive) {
    if (feedText) feedText.textContent = 'OFFLINE SCH';
    if (feedDot) feedDot.className = 'pilot-dot';
  } else if (fs.state === 'LIVE') {
    if (feedText) feedText.textContent = `LIVE · ${fs.liveCount}`;
    if (feedDot) feedDot.className = 'pilot-dot dot-live';
  } else if (fs.state === 'STALE') {
    if (feedText) feedText.textContent = `LIVE ${Math.round(fs.ageS / 60)}M`;
    if (feedDot) feedDot.className = 'pilot-dot dot-live';
  } else if (fs.state === 'QUOTA') {
    if (feedText) feedText.textContent = 'QUOTA · SCH';
    if (feedDot) feedDot.className = 'pilot-dot';
  } else {
    if (feedText) feedText.textContent = 'FALLBACK';
    if (feedDot) feedDot.className = 'pilot-dot';
  }

  // 2. Brushed-Aluminum 240px Proximity Dial
  const dialNum = document.getElementById('dial-num');
  const dialCap = document.getElementById('dial-caption');
  const dialTe = document.getElementById('dial-te');
  const dialArc = document.getElementById('dial-arc');
  const dialLed = document.getElementById('dial-led');

  // Nearest relevant movement (either primary threat or closest upcoming ambient train)
  const closest = p || r.ambient[0] || null;

  if (p) {
    const dist = Math.max(0, p.dLeadKm);
    const pct = p.atSite ? 1 : Math.max(0.08, Math.min(1, 1 - (dist / 20)));
    if (dialArc) dialArc.style.strokeDashoffset = String((DIAL_CIRCUMFERENCE * (1 - pct)).toFixed(2));
    if (dialLed) dialLed.classList.add('lit');
    if (dialNum) {
      dialNum.textContent = p.atSite ? 'PASS' : fmtClock(p.etaLowerS);
      dialNum.classList.toggle('num-word', p.atSite);
    }
    const delayTxt = p.delayMin > 0 ? ` · +${p.delayMin}M` : '';
    if (dialCap) dialCap.textContent = `${p.no} ${p.line} · ${dist.toFixed(1)} KM${delayTxt}`;
    if (dialTe) dialTe.textContent = LEVEL_TE[lvl];
  } else {
    // Calm standby state: gentle ambient arc if a train is 20–45 km out, else clean ring
    const ambientPct = closest && closest.dLeadKm > 0 && closest.dLeadKm < 45
      ? Math.max(0.06, (1 - closest.dLeadKm / 50) * 0.35)
      : 0.08;
    if (dialArc) dialArc.style.strokeDashoffset = String((DIAL_CIRCUMFERENCE * (1 - ambientPct)).toFixed(2));
    if (dialLed) dialLed.classList.toggle('lit', armed || fs.state === 'LIVE');
    if (dialNum) {
      dialNum.textContent = r.noLocation ? 'BEAT' : 'CLEAR';
      dialNum.classList.add('num-word');
    }
    if (dialCap) {
      dialCap.textContent = worker
        ? `${worker.label.toUpperCase()} · ${engine.mode}`
        : 'SELECT CORRIDOR BEAT';
    }
    if (dialTe) dialTe.textContent = r.noLocation ? 'బీట్ ఎంచుకోండి' : LEVEL_TE[0];
  }

  // Acknowledge button strictly only when armed & WARN/CRITICAL
  const ackBtn = document.getElementById('ack');
  if (ackBtn) ackBtn.hidden = !p || lvl < LEVEL.WARN || !armed;

  // 3. Nearest Movement Instrument Card + Knurled Proximity Bar
  const nWell = document.getElementById('nearest-icon-well');
  const nTitle = document.getElementById('nearest-title');
  const nSub = document.getElementById('nearest-sub');
  const proxFill = document.getElementById('prox-fill');
  const proxThumb = document.getElementById('prox-thumb');
  const proxLeft = document.getElementById('prox-left');
  const proxRight = document.getElementById('prox-right');

  if (drillTrain?.receding && !p) {
    if (nTitle) nTitle.textContent = `${drillTrain.no} ${drillTrain.name}`;
    if (nSub) nSub.textContent = `${drillTrain.dir} · ${drillTrain.speedKmh} km/h · Receding (${drillTrain.distPastKm.toFixed(1)} km past)`;
    if (nWell) nWell.classList.remove('well-lit');
    if (proxFill) proxFill.style.width = '6%';
    if (proxThumb) proxThumb.style.left = '6%';
    if (proxLeft) proxLeft.textContent = 'Cleared worksite';
    if (proxRight) proxRight.textContent = '0 FALSE ALARM';
  } else if (closest) {
    const distKm = Math.max(0, closest.dLeadKm);
    const delayLabel = closest.isSimulation
      ? 'SIMULATED DRILL'
      : closest.confirmed
      ? (closest.delayMin > 0 ? `+${closest.delayMin}m late · LIVE` : 'On time · LIVE')
      : 'Offline schedule';
    if (nTitle) nTitle.textContent = `${closest.no} ${closest.name}`;
    if (nSub) nSub.textContent = `${closest.line} · ${Math.round(closest.speedKmh)} km/h · ${delayLabel}`;
    if (nWell) nWell.classList.toggle('well-lit', Boolean(p || distKm <= 25));

    const barPct = closest.atSite ? 100 : Math.max(6, Math.min(100, Math.round((1 - Math.min(distKm, 40) / 40) * 100)));
    if (proxFill) proxFill.style.width = `${barPct}%`;
    if (proxThumb) proxThumb.style.left = `${barPct}%`;
    if (proxLeft) proxLeft.textContent = closest.atSite ? 'At worksite now' : `${distKm.toFixed(1)} km away`;
    if (proxRight) proxRight.textContent = closest.atSite ? '0:00' : fmtClock(closest.etaLowerS);
  } else {
    if (nTitle) nTitle.textContent = 'No Approaching Train';
    if (nSub) nSub.textContent = fs.state === 'LIVE' ? 'Live corridor clear' : 'Offline timetable clear';
    if (nWell) nWell.classList.remove('well-lit');
    if (proxFill) proxFill.style.width = '6%';
    if (proxThumb) proxThumb.style.left = '6%';
    if (proxLeft) proxLeft.textContent = '40 km horizon';
    if (proxRight) proxRight.textContent = 'CLEAR';
  }

  // 4. Position Card & Lookout Guard Pill
  const gpsText = document.getElementById('gps-text');
  const posPill = document.getElementById('pos-mode-pill');
  if (gpsText) gpsText.textContent = worker ? worker.label : 'Select Beat';
  if (posPill) {
    posPill.textContent = worker?.source === 'GPS' ? 'GPS LOCK' : gpsWatching ? 'SEARCHING' : 'BEAT LOCK';
  }

  const guardText = document.getElementById('guard-pill-text');
  const guardPill = document.getElementById('guard-pill');
  if (guardText) {
    guardText.textContent = drillTrain?.receding && !p ? 'CLEARED' : drillState ? 'DRILL' : lvl === LEVEL.CRITICAL ? 'CLEAR NOW' : armed ? 'ARMED' : 'STANDBY';
  }
  if (guardPill) {
    guardPill.classList.toggle('pill-danger', lvl === LEVEL.CRITICAL);
  }

  // 5. Debossed Corridor Meter Screen & 7-Bar Traffic Sparkline
  const allShown = [...r.threats, ...r.ambient];
  const meterEyebrow = document.getElementById('meter-eyebrow');
  const meterReading = document.getElementById('meter-reading');
  const meterDelta = document.getElementById('meter-delta');
  const meterAge = document.getElementById('meter-sync-age');

  const trackedTotal = allCorridorTrains.length;
  const liveCount = allCorridorTrains.filter(t => t.source === 'LIVE').length;
  const delayedCount = allCorridorTrains.filter(t => (t.delayMin || 0) >= 5).length;

  if (meterEyebrow) {
    meterEyebrow.textContent = fs.state === 'LIVE'
      ? 'LIVE CORRIDOR'
      : fs.state === 'QUOTA'
      ? 'QUOTA · SCHEDULE'
      : !live.preferLive || !isOnline
      ? 'OFFLINE SCHEDULE'
      : 'CORRIDOR FEED';
  }
  if (meterReading) {
    meterReading.textContent = `${trackedTotal} train${trackedTotal === 1 ? '' : 's'}`;
  }
  if (meterDelta) {
    if (liveCount > 0) {
      meterDelta.textContent = delayedCount > 0
        ? `OGL · SKM · NLR · ${delayedCount} delayed live`
        : 'OGL · SKM · NLR · running live';
    } else if (fs.state === 'QUOTA') {
      meterDelta.textContent = 'RailRadar quota reached — using 53-train schedule';
    } else {
      meterDelta.textContent = 'Embedded 53-train BZA–GDR fallback';
    }
  }
  if (meterAge) {
    meterAge.textContent = fs.state === 'LIVE'
      ? `${Math.max(0, Math.round(fs.ageS))}s ago`
      : fs.state === 'QUOTA'
      ? 'QUOTA'
      : 'LOCAL';
  }

  renderTrafficSparkline(allShown);

  // 6. Corridor Traffic Rows inside Debossed Screen
  const ambientList = document.getElementById('ambient');
  if (ambientList) {
    const rows = allShown.slice(0, 12);
    if (rows.length > 0) {
      ambientList.innerHTML = rows.map(a => {
        const delayTag = a.isSimulation
          ? '<span class="row-tag tag-live">DRILL</span>'
          : a.confirmed
          ? `<span class="row-tag tag-live">${a.delayMin > 0 ? `+${a.delayMin}m` : 'LIVE'}</span>`
          : '<span class="row-tag">SCH</span>';
        const distTxt = a.dLeadKm > 0 ? `${a.dLeadKm.toFixed(1)} km` : a.confirmed ? 'Passing' : 'Due';
        const etaTxt = a.dLeadKm > 0 ? fmtClock(a.etaLowerS) : '—';
        return `
          <li class="corridor-row" data-level="${LEVEL_NAME[a.level]}" data-active="${a.active}">
            <span class="row-no mono">${escapeHtml(a.no)}</span>
            <span class="row-name">${escapeHtml(a.name)}</span>
            ${delayTag}
            <span class="row-dir mono">${a.line}</span>
            <span class="row-dist mono">${distTxt}</span>
            <span class="row-eta mono">${etaTxt}</span>
          </li>`;
      }).join('');
    } else {
      ambientList.innerHTML = '<li class="empty">No trains within range right now. Tap Run Drill to preview alerts.</li>';
    }
  }
}

/** Update the 7-bar etched SVG sparkline (15-min arrival buckets across next 105 min). */
function renderTrafficSparkline(rows) {
  const svg = document.getElementById('corridor-sparkline');
  if (!svg) return;
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    if (!Number.isFinite(r.etaLowerS) || r.etaLowerS < 0) continue;
    const mins = r.etaLowerS / 60;
    const idx = Math.min(6, Math.floor(mins / 15));
    buckets[idx] += 1;
  }
  const maxVal = Math.max(2, ...buckets);
  const bars = svg.querySelectorAll('rect.spark-bar');
  // Display oldest/farthest left -> imminent now on right (matching Haven's right-most lit active bar!)
  const ordered = [...buckets].reverse();
  bars.forEach((rect, i) => {
    const val = ordered[i] || 0;
    const h = Math.max(6, Math.round((val / maxVal) * 34) + (val > 0 ? 4 : 0));
    rect.setAttribute('height', String(h));
    rect.setAttribute('y', String(42 - h));
    rect.classList.toggle('active', i === 6 && val > 0);
  });
}

async function renderAlertAuditLog() {
  const list = document.getElementById('alert-log-list');
  if (!list) return;
  const logs = await getAlertLogs(25);
  if (logs.length === 0) {
    list.innerHTML = '<li class="empty">No WARN or CRITICAL shifts recorded yet.</li>';
    return;
  }
  list.innerHTML = logs.map(l => {
    const timeStr = new Date(l.timestamp).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit',
    });
    return `<li class="corridor-row" data-level="${escapeHtml(l.level)}">
      <span class="row-tag tag-live">${escapeHtml(l.level)}</span>
      <span class="row-name"><strong>${escapeHtml(l.trainNo)}</strong> ${escapeHtml(l.trainName || '')}</span>
      <span class="row-dist mono">${l.distanceKm != null ? `${l.distanceKm} km` : ''}</span>
      <span class="row-eta mono">${timeStr}</span>
    </li>`;
  }).join('');
}

// ── Navigation ───────────────────────────────────────────────────────────────
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

  window.scrollTo({ top: 0, behavior: 'instant' });

  if (screenId === 'defect'  && !window._defectInit)  { initDefectReport(getDefectElements());  window._defectInit  = true; }
  if (screenId === 'diary'   && !window._diaryInit)   { initGangDiary(getDiaryElements());      window._diaryInit   = true; }
  if (screenId === 'weather' && !window._weatherInit) { initWeatherAlert(getWeatherElements()); window._weatherInit = true; }
  if (screenId === 'manual'  && !window._manualInit)  { initPWManual(getManualElements());      window._manualInit  = true; }
}

// ── SOS Modal ────────────────────────────────────────────────────────────────
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
      showToast('Emergency SMS text copied', 'ok');
    } catch {
      showToast(loc, 'info');
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

// ── Settings Modal ───────────────────────────────────────────────────────────
const SETTING_FIELDS = [
  'mate_name', 'gang_no', 'gang_strength', 'section', 'pwi_phone',
  'work_station_a', 'work_station_b',
  'voice_lang', 'theme',
  'ai_base_url', 'ai_model', 'ai_api_key',
  'owm_api_key', 'irctc_dev_key', 'railradar_key', 'railcore_key',
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
    btn.onclick = () => {
      const input = document.getElementById(btn.dataset.target);
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.textContent = input.type === 'password' ? 'Show' : 'Hide';
      }
    };
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
    showToast('Offline backup exported (JSON)', 'ok');
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
    statusEl.textContent = 'Checking Cloudflare Edge...';
    const health = await checkServerHealth();
    if (health.offline) {
      statusEl.textContent = 'Offline — local schedule, defects, diary & IRPWM ready';
    } else if (health.reachable && health.services) {
      const aiTxt = health.services.ai?.configured ? `AI: ${health.services.ai.model}` : 'AI: Offline fallback';
      const lt = health.services.liveTrains;
      const providerLabels = { irctcdev: 'irctc.dev', railcore: 'RailCore', railradar: 'RailRadar' };
      const hasPersonal = Boolean(getConfig('irctc_dev_key') || getConfig('railcore_key') || getConfig('railradar_key'));
      const liveTxt = lt?.configured
        ? `Live Feed: ${providerLabels[lt.provider] || lt.provider || 'connected'}`
        : hasPersonal
        ? 'Live Feed: Personal Key'
        : 'Live Feed: Schedule';
      statusEl.textContent = `Cloudflare Edge · ${aiTxt} · ${liveTxt}`;
    } else {
      statusEl.textContent = 'Local preview mode';
    }
  }
}

function closeSettings() {
  const overlay = document.getElementById('settings-overlay');
  if (overlay) overlay.hidden = true;
}

function saveSettings() {
  const prevIRCTC = (getConfig('irctc_dev_key') || '').trim();
  const prevRR = (getConfig('railradar_key') || '').trim();
  const prevRC = (getConfig('railcore_key') || '').trim();
  SETTING_FIELDS.forEach(key => {
    const el = document.getElementById(`setting-${key}`);
    if (el) localStorage.setItem(key, el.value.trim());
  });
  applyTheme(getConfig('theme'));
  syncEngineConfig();
  window._syncRockers?.();
  closeSettings();
  window.dispatchEvent(new CustomEvent('railraksha:settings-updated'));
  loop();
  const nextIRCTC = (getConfig('irctc_dev_key') || '').trim();
  const nextRR = (getConfig('railradar_key') || '').trim();
  const nextRC = (getConfig('railcore_key') || '').trim();
  if (nextIRCTC !== prevIRCTC || nextRR !== prevRR || nextRC !== prevRC) {
    window._pollCorridorNow?.(true);
    showToast('Settings saved — syncing live feed...', 'info');
  } else {
    showToast('Settings saved', 'ok');
  }
}

// ── Toast System ─────────────────────────────────────────────────────────────
let toastTimer = null;
function setupToastSystem() {
  window.addEventListener('showToast', (e) => showToast(e.detail.msg, e.detail.type));
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const color = type === 'error' ? '#C81E1E' : type === 'warn' || type === 'ok' ? '#E5481F' : 'currentColor';
  const icons = {
    ok: Icons.check(15, color),
    warn: Icons.alert(15, color),
    error: Icons.alertCircle(15, color),
    info: Icons.info(15, color),
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

// ── Sub-module Element Maps ──────────────────────────────────────────────────
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
