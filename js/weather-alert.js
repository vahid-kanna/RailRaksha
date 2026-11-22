/**
 * RailRaksha — Weather & Track Vulnerability Monitor (weather-alert.js)
 * Live telemetry via Open-Meteo (free, no API key required) with optional
 * OpenWeatherMap override and IndexedDB offline caching.
 */

import { Icons } from './icons.js';
import { dbGet, dbPut, STORES } from './db.js';
import { kmToLatLon, nearestStation } from './corridor.js';

const SKM_FALLBACK = { lat: 15.2380, lon: 80.0270, label: "Singarayakonda (SKM)" };
const CACHE_KEY = "latest_weather";

let elements = {};

const WMO_LABELS = {
  0: ["Clear sky", "Clear"],
  1: ["Mainly clear", "Clear"],
  2: ["Partly cloudy", "Clouds"],
  3: ["Overcast", "Clouds"],
  45: ["Fog", "Fog"],
  48: ["Depositing rime fog", "Fog"],
  51: ["Light drizzle", "Drizzle"],
  53: ["Moderate drizzle", "Drizzle"],
  55: ["Dense drizzle", "Drizzle"],
  61: ["Light rain", "Rain"],
  63: ["Moderate rain", "Rain"],
  65: ["Heavy rain", "Rain"],
  80: ["Light rain showers", "Rain"],
  81: ["Moderate rain showers", "Rain"],
  82: ["Violent rain showers", "Rain"],
  95: ["Thunderstorm", "Thunderstorm"],
  96: ["Thunderstorm with hail", "Thunderstorm"],
  99: ["Severe thunderstorm", "Thunderstorm"],
};

export function initWeatherAlert(els) {
  elements = els;
  loadWeatherData();
  elements.btnRefreshWeather?.addEventListener("click", () => loadWeatherData(true));
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

export async function loadWeatherData(manual = false) {
  const coords = getTargetCoords();
  if (elements.weatherLocation) {
    elements.weatherLocation.textContent = `${coords.label} · Prakasam / SCR`;
  }

  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  const owmKey = cfg("owm_api_key");

  try {
    let payload;
    if (owmKey) {
      payload = await fetchOpenWeatherMap(coords, owmKey);
    } else {
      payload = await fetchOpenMeteo(coords);
    }
    payload.locationLabel = coords.label;
    payload.fetchedAt = Date.now();
    try { await dbPut(STORES.WEATHER_CACHE, { key: CACHE_KEY, ...payload }); } catch {}
    renderWeather(payload, false);
    if (manual) showToast("Weather updated", "ok");
  } catch (err) {
    console.warn("[Weather] Live fetch failed:", err.message);
    try {
      const cached = await dbGet(STORES.WEATHER_CACHE, CACHE_KEY);
      if (cached && Number.isFinite(cached.temp)) {
        renderWeather(cached, true);
        if (manual) showToast("Offline — showing last cached weather", "warn");
        return;
      }
    } catch {}
    showSeasonalFallback();
  }
}

async function fetchOpenMeteo({ lat, lon }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,rain,weather_code,wind_speed_10m&hourly=rain&forecast_days=1&timezone=Asia%2FKolkata`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const d = await resp.json();
  const c = d.current || {};
  const [desc, main] = WMO_LABELS[c.weather_code] || ["Clear conditions", "Clear"];

  // Check next 6 hours for heavy rain forecast
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
    rainfall: Number(c.rain ?? 0),
    desc,
    main,
    upcomingRainMm,
    upcomingRainHrs,
    source: "Open-Meteo Live",
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
    const heavy = forecast.list.find(f => (f.rain?.["3h"] || 0) > 15);
    if (heavy) {
      upcomingRainMm = heavy.rain["3h"];
      upcomingRainHrs = Math.max(1, Math.round((heavy.dt * 1000 - Date.now()) / 3600000));
    }
  }

  const w = current.weather?.[0];
  return {
    temp: Math.round(current.main?.temp ?? 30),
    humidity: Math.round(current.main?.humidity ?? 65),
    windSpeed: Math.round((current.wind?.speed || 0) * 3.6),
    rainfall: Number(current.rain?.["1h"] || 0),
    desc: w?.description ? w.description.charAt(0).toUpperCase() + w.description.slice(1) : "Clear sky",
    main: w?.main || "Clear",
    upcomingRainMm,
    upcomingRainHrs,
    source: "OpenWeatherMap Live",
  };
}

function renderWeather(data, isCached) {
  const ageMin = data.fetchedAt ? Math.max(0, Math.round((Date.now() - data.fetchedAt) / 60000)) : 0;
  const suffix = isCached ? ` (Cached ${ageMin}m ago)` : "";

  if (elements.weatherIcon) elements.weatherIcon.innerHTML = getWeatherIcon(data.main);
  if (elements.weatherTemp) elements.weatherTemp.textContent = `${data.temp}°C`;
  if (elements.weatherDesc) elements.weatherDesc.textContent = `${data.desc}${suffix}`;
  if (elements.weatherHumidity) elements.weatherHumidity.textContent = `${data.humidity}%`;
  if (elements.weatherWind) elements.weatherWind.textContent = `${data.windSpeed} km/h`;
  if (elements.weatherRain) elements.weatherRain.textContent = `${data.rainfall.toFixed(1)} mm/hr`;

  const risks = analyzeRisks(data);
  renderRisks(risks);
}

function getWeatherIcon(main) {
  const map = {
    Clear: Icons.sun(28, '#F59E0B'),
    Clouds: Icons.cloud(28, '#94A3B8'),
    Rain: Icons.rain(28, '#38BDF8'),
    Thunderstorm: Icons.lightning(28, '#F59E0B'),
    Drizzle: Icons.rain(28, '#38BDF8'),
    Fog: Icons.cloud(28, '#64748B'),
  };
  return map[main] || Icons.sun(28, '#94A3B8');
}

function analyzeRisks({ temp, humidity, rainfall, windSpeed, upcomingRainMm, upcomingRainHrs }) {
  const risks = [];
  const month = new Date().getMonth() + 1;
  const isMonsoon = month >= 6 && month <= 10;
  const isSummer = month >= 3 && month <= 5;
  const railTemp = isSummer ? temp + 24 : temp + 14;

  if (railTemp >= 65) {
    risks.push({
      level: "high",
      icon: Icons.sun(20, '#EF4444'),
      title: "Sun Kink (Rail Buckling) Risk",
      desc: `Estimated rail temperature ~${railTemp}°C (ambient ${temp}°C). Exceeds 65°C LWR threshold for hot-weather patrolling.`,
      action: "Inspect curves and SEJ gaps. Avoid disturbing ballast during peak heat. Inform PWI.",
      irpwm: "IRPWM Para 2.9 — Hot Weather Patrolling",
    });
  } else if (railTemp >= 55) {
    risks.push({
      level: "medium",
      icon: Icons.sun(20, '#F59E0B'),
      title: "Elevated Rail Temperature",
      desc: `Estimated rail temperature ~${railTemp}°C. Monitor curves for rail creep and expansion.`,
      action: "Verify joint clearances on curves and alert lookout man.",
      irpwm: "IRPWM Para 2.9",
    });
  }

  if (rainfall >= 30) {
    risks.push({
      level: "high",
      icon: Icons.siren(20, '#EF4444'),
      title: "Heavy Rainfall — Waterlogging & Scour Risk",
      desc: `Current rainfall ${rainfall.toFixed(1)} mm/hr. Low-lying cuttings and bridge approaches require immediate patrol.`,
      action: "Inspect bridge waterways, culverts, and embankment slopes. Stop trains if water nears rail foot.",
      irpwm: "IRPWM Para 2.11 — Monsoon Patrolling",
    });
  } else if (rainfall >= 10 || (isMonsoon && humidity >= 92)) {
    risks.push({
      level: "medium",
      icon: Icons.rain(20, '#38BDF8'),
      title: "Monsoon / High-Moisture Watch",
      desc: `Rainfall ${rainfall.toFixed(1)} mm/hr, humidity ${humidity}%. Monitor side drains and vulnerable embankments.`,
      action: "Check catch-water drains and bridge abutments along beat.",
      irpwm: "IRPWM Para 2.11",
    });
  }

  if (windSpeed >= 55) {
    risks.push({
      level: "high",
      icon: Icons.wind(20, '#EF4444'),
      title: "High Wind — Coastal Cyclone Precaution",
      desc: `Wind speed ${windSpeed} km/h. Risk of OHE mast debris and uprooted trees fouling track.`,
      action: "Suspend overhead/trolley work. Clear loose materials. Seek shelter above 80 km/h.",
      irpwm: "IRPWM Para 2.13 — Cyclone Precautions",
    });
  }

  if (upcomingRainMm >= 15 && upcomingRainHrs != null) {
    risks.push({
      level: "medium",
      icon: Icons.rain(20, '#F59E0B'),
      title: `Rain Forecast in ~${upcomingRainHrs}h`,
      desc: `Expected rainfall ~${upcomingRainMm.toFixed(0)} mm. Plan open-track packing accordingly.`,
      action: "Close open ballast beds before heavy showers arrive.",
      irpwm: "IRPWM Para 2.11",
    });
  }

  if (risks.length === 0) {
    risks.push({
      level: "low",
      icon: Icons.check(20, '#22C55E'),
      title: "Track Weather Conditions Normal",
      desc: `Ambient ${temp}°C (est. rail ~${railTemp}°C), humidity ${humidity}%, wind ${windSpeed} km/h. No active weather hazards.`,
      action: "Proceed with normal maintenance and standard lookout protocol.",
      irpwm: "Routine Patrol",
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
  `).join("");
}

function showSeasonalFallback() {
  const month = new Date().getMonth() + 1;
  const isMonsoon = month >= 6 && month <= 10;
  const isSummer = month >= 3 && month <= 5;
  const temp = isSummer ? 38 : isMonsoon ? 29 : 27;

  if (elements.weatherIcon) elements.weatherIcon.innerHTML = isMonsoon ? Icons.rain(28, '#38BDF8') : isSummer ? Icons.sun(28, '#F59E0B') : Icons.cloud(28, '#94A3B8');
  if (elements.weatherTemp) elements.weatherTemp.textContent = `${temp}°C`;
  if (elements.weatherDesc) elements.weatherDesc.textContent = "Offline — Seasonal Estimate";
  if (elements.weatherHumidity) elements.weatherHumidity.textContent = isMonsoon ? "82%" : "60%";
  if (elements.weatherWind) elements.weatherWind.textContent = "12 km/h";
  if (elements.weatherRain) elements.weatherRain.textContent = "0.0 mm/hr";

  renderRisks(analyzeRisks({ temp, humidity: isMonsoon ? 82 : 60, rainfall: 0, windSpeed: 12 }));
}

function showToast(msg, type = "info") {
  window.dispatchEvent(new CustomEvent("showToast", { detail: { msg, type } }));
}
