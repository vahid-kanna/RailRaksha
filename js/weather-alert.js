/**
 * RailRaksha — Weather & LWR Track Thermal Risk Monitor v7.0 (weather-alert.js)
 *
 * Uses free keyless Open-Meteo telemetry anchored to worker beat coordinates,
 * optional OpenWeatherMap override, IndexedDB offline cache, and an explicit
 * LWR Rail Temperature thermal gauge mapped to IRPWM Para 2.9 / 2.11 / 2.13.
 */

import { Icons } from './icons.js';
import { dbGet, dbPut, STORES } from './db.js';
import { kmToLatLon, nearestStation } from './corridor.js';

const SKM_FALLBACK = { lat: 15.2380, lon: 80.0270, label: 'Singarayakonda (SKM)' };
const CACHE_KEY = 'latest_weather';

let elements = {};

const WMO_LABELS = {
  0: ['Clear sky', 'Clear'],
  1: ['Mainly clear', 'Clear'],
  2: ['Partly cloudy', 'Clouds'],
  3: ['Overcast', 'Clouds'],
  45: ['Fog', 'Fog'],
  48: ['Depositing rime fog', 'Fog'],
  51: ['Light drizzle', 'Drizzle'],
  53: ['Moderate drizzle', 'Drizzle'],
  55: ['Dense drizzle', 'Drizzle'],
  61: ['Light rain', 'Rain'],
  63: ['Moderate rain', 'Rain'],
  65: ['Heavy rain', 'Rain'],
  80: ['Light showers', 'Rain'],
  81: ['Moderate showers', 'Rain'],
  82: ['Violent showers', 'Rain'],
  95: ['Thunderstorm', 'Thunderstorm'],
  96: ['Thunderstorm with hail', 'Thunderstorm'],
  99: ['Severe thunderstorm', 'Thunderstorm'],
};

export function initWeatherAlert(els) {
  elements = els;
  loadWeatherData();
  elements.btnRefreshWeather?.addEventListener('click', () => loadWeatherData(true));
}

function getTargetCoords() {
  const pos = window._currentWorkerPos;
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
    return { lat: pos.lat, lon: pos.lon, label: pos.stationLabel || SKM_FALLBACK.label };
  }
  if (pos && Number.isFinite(pos.km)) {
    const ll = kmToLatLon(pos.km);
    const st = nearestStation(pos.km);
    if (ll) return { lat: ll.lat, lon: ll.lon, label: `${st.name} (${st.code})` };
  }
  return SKM_FALLBACK;
}

/**
 * Estimate steel rail temperature from ambient temperature, solar hour (IST), and season.
 * Coastal Andhra Pradesh (SCR Zone III): midday direct sun can heat steel 20–24°C above ambient.
 */
export function estimateRailTempC(ambientC, now = new Date()) {
  const istHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now)
  );
  const month = now.getMonth() + 1;
  const isSummer = month >= 3 && month <= 6;
  let solarDelta;
  if (istHour >= 11 && istHour <= 16) solarDelta = isSummer ? 23 : 18;
  else if ((istHour >= 8 && istHour < 11) || (istHour > 16 && istHour <= 18)) solarDelta = isSummer ? 15 : 11;
  else solarDelta = 4;
  return Math.round(ambientC + solarDelta);
}

export async function loadWeatherData(manual = false) {
  const coords = getTargetCoords();
  if (elements.weatherLocation) {
    elements.weatherLocation.textContent = `${coords.label} · Vijayawada Div., SCR`;
  }

  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || '');
  const owmKey = cfg('owm_api_key');

  try {
    const payload = owmKey
      ? await fetchOpenWeatherMap(coords, owmKey)
      : await fetchOpenMeteo(coords);

    payload.locationLabel = coords.label;
    payload.fetchedAt = Date.now();
    try { await dbPut(STORES.WEATHER_CACHE, { key: CACHE_KEY, ...payload }); } catch {}
    renderWeather(payload, false);
    window.dispatchEvent(new CustomEvent("railraksha:weather-updated", { detail: payload }));
    if (manual) showToast('Weather telemetry updated', 'ok');
  } catch {
    try {
      const cached = await dbGet(STORES.WEATHER_CACHE, CACHE_KEY);
      if (cached && Number.isFinite(cached.temp)) {
        renderWeather(cached, true);
        window.dispatchEvent(new CustomEvent("railraksha:weather-updated", { detail: cached }));
        if (manual) showToast('Offline — showing last cached telemetry', 'warn');
        return;
      }
    } catch {}
    showSeasonalFallback();
  }
}

async function fetchOpenMeteo({ lat, lon }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,rain,weather_code,wind_speed_10m,wind_gusts_10m&hourly=rain&forecast_days=1&timezone=Asia%2FKolkata`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const d = await resp.json();
  const c = d.current || {};
  const [desc, main] = WMO_LABELS[c.weather_code] || ['Clear conditions', 'Clear'];

  let upcomingRainMm = 0;
  let upcomingRainHrs = null;
  const times = d.hourly?.time || [];
  const rains = d.hourly?.rain || [];
  const nowMs = Date.now();
  for (let i = 0; i < times.length; i++) {
    const tMs = Date.parse(times[i]);
    const diffH = (tMs - nowMs) / 3600000;
    if (diffH >= 0 && diffH <= 12 && (rains[i] || 0) > upcomingRainMm) {
      upcomingRainMm = rains[i];
      upcomingRainHrs = Math.max(1, Math.round(diffH));
    }
  }

  return {
    temp: Math.round(c.temperature_2m ?? 30),
    humidity: Math.round(c.relative_humidity_2m ?? 65),
    windSpeed: Math.round(c.wind_speed_10m ?? 0),
    windGusts: Math.round(c.wind_gusts_10m ?? c.wind_speed_10m ?? 0),
    rainfall: Number(c.rain ?? 0),
    desc,
    main,
    upcomingRainMm,
    upcomingRainHrs,
    source: 'Open-Meteo Live',
  };
}

async function fetchOpenWeatherMap({ lat, lon }, apiKey) {
  const [curR, fcR] = await Promise.all([
    fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`, { signal: AbortSignal.timeout(10000) }),
    fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&cnt=4`, { signal: AbortSignal.timeout(10000) }),
  ]);
  if (!curR.ok) throw new Error(`OWM HTTP ${curR.status}`);
  const current = await curR.json();
  const forecast = fcR.ok ? await fcR.json() : null;

  let upcomingRainMm = 0;
  let upcomingRainHrs = null;
  if (forecast?.list) {
    const heavy = forecast.list.find(f => (f.rain?.['3h'] || 0) > 15);
    if (heavy) {
      upcomingRainMm = heavy.rain['3h'];
      upcomingRainHrs = Math.max(1, Math.round((heavy.dt * 1000 - Date.now()) / 3600000));
    }
  }

  const w = current.weather?.[0];
  return {
    temp: Math.round(current.main?.temp ?? 30),
    humidity: Math.round(current.main?.humidity ?? 65),
    windSpeed: Math.round((current.wind?.speed || 0) * 3.6),
    windGusts: Math.round(((current.wind?.gust || current.wind?.speed || 0)) * 3.6),
    rainfall: Number(current.rain?.['1h'] || 0),
    desc: w?.description ? w.description.charAt(0).toUpperCase() + w.description.slice(1) : 'Clear sky',
    main: w?.main || 'Clear',
    upcomingRainMm,
    upcomingRainHrs,
    source: 'OpenWeatherMap Live',
  };
}

function renderWeather(data, isCached) {
  const ageMin = data.fetchedAt ? Math.max(0, Math.round((Date.now() - data.fetchedAt) / 60000)) : 0;
  const suffix = isCached ? ` · Cached ${ageMin}m ago` : ` · ${data.source || 'Live'}`;
  const railTemp = estimateRailTempC(data.temp);

  if (elements.weatherIcon) elements.weatherIcon.innerHTML = getWeatherIcon(data.main);
  if (elements.weatherTemp) elements.weatherTemp.textContent = `${data.temp}°C`;
  if (elements.weatherRailTemp) elements.weatherRailTemp.textContent = `~${railTemp}°C`;
  if (elements.weatherDesc) elements.weatherDesc.textContent = `${data.desc}${suffix}`;
  if (elements.weatherHumidity) elements.weatherHumidity.textContent = `${data.humidity}%`;
  if (elements.weatherWind) elements.weatherWind.textContent = `${data.windSpeed} km/h`;
  if (elements.weatherRain) elements.weatherRain.textContent = `${Number(data.rainfall || 0).toFixed(1)} mm/h`;
  if (elements.weatherForecastRain) {
    elements.weatherForecastRain.textContent = data.upcomingRainMm > 0
      ? `${data.upcomingRainMm.toFixed(1)} mm (~${data.upcomingRainHrs}h)`
      : 'Dry (12h)';
  }

  // Update thermal bar against 75°C full scale (65°C = IRPWM Hot Weather Patrol threshold)
  if (elements.railThermalBar) {
    const pct = Math.max(8, Math.min(100, Math.round((railTemp / 75) * 100)));
    elements.railThermalBar.style.width = `${pct}%`;
    elements.railThermalBar.dataset.state = railTemp >= 65 ? 'danger' : railTemp >= 55 ? 'warn' : 'ok';
  }
  if (elements.railThermalStatus) {
    elements.railThermalStatus.textContent = railTemp >= 65
      ? 'HOT WEATHER PATROL REQUIRED (≥ 65°C)'
      : railTemp >= 55
      ? 'ELEVATED RAIL STRESS — MONITOR CURVES'
      : 'NORMAL LWR THERMAL BAND (< 55°C)';
    elements.railThermalStatus.dataset.state = railTemp >= 65 ? 'danger' : railTemp >= 55 ? 'warn' : 'ok';
  }

  renderRisks(analyzeRisks({ ...data, railTemp }));
}

function getWeatherIcon(main) {
  const map = {
    Clear: Icons.sun(26, '#E5481F'),
    Clouds: Icons.cloud(26, '#94A3B8'),
    Rain: Icons.rain(26, '#38BDF8'),
    Thunderstorm: Icons.lightning(26, '#E5481F'),
    Drizzle: Icons.rain(26, '#38BDF8'),
    Fog: Icons.cloud(26, '#64748B'),
  };
  return map[main] || Icons.sun(26, '#94A3B8');
}

function analyzeRisks({ temp, railTemp, humidity, rainfall, windSpeed, windGusts, upcomingRainMm, upcomingRainHrs }) {
  const risks = [];
  const month = new Date().getMonth() + 1;
  const isMonsoon = month >= 6 && month <= 10;

  if (railTemp >= 65) {
    risks.push({
      level: 'high',
      icon: Icons.sun(18, '#C81E1E'),
      title: 'Sun Kink / LWR Buckling Hazard',
      desc: `Estimated rail steel temperature ~${railTemp}°C (ambient ${temp}°C) exceeds the 65°C (Td+20°C) BG LWR hot-weather threshold.`,
      action: 'Deploy hot-weather patrolmen at curves and SEJs. Do not open ballast beds during peak heat. Notify PWI.',
      irpwm: 'IRPWM Para 2.9 — Hot Weather Patrolling',
    });
  } else if (railTemp >= 55) {
    risks.push({
      level: 'medium',
      icon: Icons.sun(18, '#E5481F'),
      title: 'Elevated Rail Thermal Stress',
      desc: `Estimated rail temperature ~${railTemp}°C. Monitor LWR curves, SEJ gaps, and weld zones for lateral creep.`,
      action: 'Verify SEJ clearances and avoid heavy ballast disturbance in afternoon hours.',
      irpwm: 'IRPWM Para 2.9',
    });
  }

  if (rainfall >= 30) {
    risks.push({
      level: 'high',
      icon: Icons.siren(18, '#C81E1E'),
      title: 'Heavy Rainfall — Waterlogging & Scour',
      desc: `Current rainfall ${rainfall.toFixed(1)} mm/hr. Low-lying cuttings, culverts, and bridge approaches require immediate patrol.`,
      action: 'Inspect bridge waterways and embankment toes. Stop trains immediately if floodwater reaches rail foot.',
      irpwm: 'IRPWM Para 2.11 — Monsoon Patrolling',
    });
  } else if (rainfall >= 10 || (isMonsoon && humidity >= 92)) {
    risks.push({
      level: 'medium',
      icon: Icons.rain(18, '#38BDF8'),
      title: 'Monsoon / High-Moisture Watch',
      desc: `Rainfall ${rainfall.toFixed(1)} mm/hr, humidity ${humidity}%. Watch catch-water drains and vulnerable formations.`,
      action: 'Inspect side drains, ballast shoulders, and bridge abutments along beat.',
      irpwm: 'IRPWM Para 2.11',
    });
  }

  const peakWind = Math.max(windSpeed || 0, windGusts || 0);
  if (peakWind >= 55) {
    risks.push({
      level: 'high',
      icon: Icons.wind(18, '#C81E1E'),
      title: 'Coastal High-Wind / Cyclone Precaution',
      desc: `Wind / gusts at ${peakWind} km/h. High risk of OHE mast debris and uprooted trees fouling track.`,
      action: 'Suspend trolley/overhead work, secure loose tools, and shelter crew above 80 km/h.',
      irpwm: 'IRPWM Para 2.13 — Cyclone Precautions',
    });
  }

  if (upcomingRainMm >= 15 && upcomingRainHrs != null) {
    risks.push({
      level: 'medium',
      icon: Icons.rain(18, '#E5481F'),
      title: `Heavy Rain Forecast (~${upcomingRainHrs}h ahead)`,
      desc: `Expected peak rainfall ~${upcomingRainMm.toFixed(1)} mm/hr within 12 hours.`,
      action: 'Close open sleeper packing and clear side drains before rainfall arrives.',
      irpwm: 'IRPWM Para 2.11',
    });
  }

  if (risks.length === 0) {
    risks.push({
      level: 'low',
      icon: Icons.check(18, 'currentColor'),
      title: 'Track Weather Conditions Normal',
      desc: `Ambient ${temp}°C (est. rail ~${railTemp}°C), humidity ${humidity}%, wind ${windSpeed} km/h. No active weather patrol triggers.`,
      action: 'Proceed with normal maintenance under standard lookout and safety rules.',
      irpwm: 'Routine Patrol',
    });
  }

  return risks;
}

function renderRisks(risks) {
  if (!elements.riskList) return;
  elements.riskList.innerHTML = risks.map(risk => `
    <div class="risk-card risk-${risk.level}">
      <div class="risk-icon">${risk.icon}</div>
      <div class="risk-content">
        <div class="risk-title">${risk.title}</div>
        <div class="risk-desc">${risk.desc}</div>
        <div class="risk-action">${risk.action}</div>
        <div class="risk-ref">${risk.irpwm}</div>
      </div>
    </div>
  `).join('');
}

function showSeasonalFallback() {
  const month = new Date().getMonth() + 1;
  const isMonsoon = month >= 6 && month <= 10;
  const isSummer = month >= 3 && month <= 5;
  const temp = isSummer ? 38 : isMonsoon ? 29 : 27;

  renderWeather({
    temp,
    humidity: isMonsoon ? 82 : 60,
    windSpeed: 12,
    windGusts: 16,
    rainfall: 0,
    desc: 'Offline seasonal estimate',
    main: isMonsoon ? 'Rain' : isSummer ? 'Clear' : 'Clouds',
    upcomingRainMm: 0,
    upcomingRainHrs: null,
    source: 'Offline Estimate',
  }, false);
}

function showToast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { msg, type } }));
}
