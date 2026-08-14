/**
 * RailRaksha — Weather & Vulnerability Alerts (weather-alert.js)
 * Correlates IMD/OpenWeatherMap data with track section vulnerability.
 * Singarayakonda, Prakasam District, Andhra Pradesh.
 */

import { Icons } from './icons.js';

const OWM_API_URL = "https://api.openweathermap.org/data/2.5/weather";
const FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";
// Singarayakonda coordinates
const SKM_LAT = 15.2333;
const SKM_LON = 80.0167;

let elements = {};

export function initWeatherAlert(els) {
  elements = els;
  loadWeatherData();
  elements.btnRefreshWeather?.addEventListener("click", loadWeatherData);
}

export async function loadWeatherData() {
  const cfg = (window.getConfig) ? window.getConfig : (k) => localStorage.getItem(k) || "";
  const apiKey = cfg("owm_api_key") || localStorage.getItem("owm_api_key") || "";
  if (!apiKey) {
    showOfflineWeather();
    return;
  }
  try {
    const [current, forecast] = await Promise.all([
      fetch(`${OWM_API_URL}?lat=${SKM_LAT}&lon=${SKM_LON}&appid=${apiKey}&units=metric`).then(r => r.json()),
      fetch(`${FORECAST_URL}?lat=${SKM_LAT}&lon=${SKM_LON}&appid=${apiKey}&units=metric&cnt=8`).then(r => r.json())
    ]);
    renderWeather(current, forecast);
  } catch {
    showOfflineWeather();
  }
}

function renderWeather(current, forecast) {
  const temp = Math.round(current.main?.temp || 35);
  const humidity = current.main?.humidity || 70;
  const windSpeed = Math.round(current.wind?.speed * 3.6 || 0); // m/s to km/h
  const rainfall = current.rain?.["1h"] || 0;
  const weather = current.weather?.[0];
  const desc = weather?.description || "Clear sky";
  const icon = getWeatherEmoji(weather?.main || "Clear");

  // Update hero card
  if (elements.weatherIcon) elements.weatherIcon.innerHTML = icon;
  if (elements.weatherTemp) elements.weatherTemp.textContent = `${temp}°C`;
  if (elements.weatherDesc) elements.weatherDesc.textContent = desc.charAt(0).toUpperCase() + desc.slice(1);
  if (elements.weatherHumidity) elements.weatherHumidity.textContent = `${humidity}%`;
  if (elements.weatherWind) elements.weatherWind.textContent = `${windSpeed} km/h`;
  if (elements.weatherRain) elements.weatherRain.textContent = `${rainfall.toFixed(1)} mm/hr`;

  // Analyze risks
  const risks = analyzeRisks(temp, humidity, rainfall, windSpeed, forecast);
  renderRisks(risks);
}

function getWeatherEmoji(main) {
  const map = { 
    Clear: Icons.sun(28, '#F59E0B'), 
    Clouds: Icons.cloud(28, '#94A3B8'), 
    Rain: Icons.rain(28, '#06B6D4'), 
    Thunderstorm: Icons.lightning(28, '#F59E0B'), 
    Drizzle: Icons.rain(28, '#06B6D4'), 
    Mist: Icons.cloud(28, '#64748B'), 
    Haze: Icons.cloud(28, '#64748B'), 
    Fog: Icons.cloud(28, '#64748B'), 
    Snow: Icons.cloud(28, '#E2E8F0') 
  };
  return map[main] || Icons.sun(28, '#94A3B8');
}

function analyzeRisks(temp, humidity, rainfall, windSpeed, forecast) {
  const risks = [];
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const isMonsoon = month >= 6 && month <= 10;
  const isSummer = month >= 3 && month <= 5;

  // Rail temperature (rough estimate: ambient + 20-25°C for black steel rail in sun)
  const railTemp = isSummer ? temp + 25 : temp + 15;

  // ── Sun Kink / Rail Buckling Risk (Summer) ───────────────────────
  if (railTemp >= 65) {
    risks.push({
      id: "sun_kink",
      level: "high",
      icon: Icons.sun(24, '#EF4444'),
      title: "Sun Kink (Rail Buckling) Risk",
      desc: `Estimated rail temperature: ${railTemp}°C. IRPWM mandates hot-weather patrolling when rail temp exceeds 65°C. Immediate inspection of curves and points required.`,
      action: "Inspect curves km 232–237. Apply oil to rail joints. Report to PWI.",
      irpwm: "IRPWM Para 2.9 — Hot Weather Patrolling"
    });
  } else if (railTemp >= 55) {
    risks.push({
      id: "sun_kink_warn",
      level: "medium",
      icon: Icons.sun(24, '#F59E0B'),
      title: "Elevated Rail Temperature",
      desc: `Estimated rail temperature: ${railTemp}°C. Monitor curves for rail creep and expansion.`,
      action: "Verify rail joints clearance on curves. Alert lookout man.",
      irpwm: "IRPWM Para 2.9"
    });
  }

  // ── Flash Flood / Embankment Risk (Monsoon) ───────────────────────
  if (rainfall > 50) {
    risks.push({
      id: "flood",
      level: "high",
      icon: Icons.siren(24, '#EF4444'),
      title: "FLOOD RISK — Heavy Rainfall Alert",
      desc: `Current rainfall: ${rainfall.toFixed(1)} mm/hr (>50mm threshold). Singarayakonda low-lying sections (km 232, km 237) and Bridge 47 approach are HIGH RISK for waterlogging.`,
      action: "IMMEDIATE: Inspect Bridge 47, km 232 low-section, km 237 embankment. Inform PWI if water level approaches rail.",
      irpwm: "IRPWM Para 2.11 — Monsoon Patrolling"
    });
  } else if (rainfall > 20 || (isMonsoon && humidity > 90)) {
    risks.push({
      id: "rain_watch",
      level: "medium",
      icon: Icons.rain(24, '#06B6D4'),
      title: "Monsoon Watch — Moderate Rainfall",
      desc: `Rainfall: ${rainfall.toFixed(1)} mm/hr. Monsoon season vulnerability active. Monitor drains and bridge scour points.`,
      action: "Check drain clearance at km 233. Monitor bridge 47 foundation.",
      irpwm: "IRPWM Para 2.11"
    });
  }

  // ── Bridge Scour Risk ─────────────────────────────────────────────
  if (isMonsoon && rainfall > 30) {
    risks.push({
      id: "scour",
      level: "high",
      icon: Icons.rain(24, '#06B6D4'),
      title: "Bridge Scour Alert",
      desc: "Heavy rainfall increases scour risk at bridge foundations. Krishnapatnam catchment area drains through this section.",
      action: "Inspect waterway below Bridge 47. Check for undermining of abutments. Report abnormalities.",
      irpwm: "IRPWM Para 2.12 — Bridge Inspection"
    });
  }

  // ── Cyclone / High Wind Risk ───────────────────────────────────────
  if (windSpeed > 60) {
    risks.push({
      id: "cyclone",
      level: "high",
      icon: Icons.wind(24, '#EF4444'),
      title: "High Wind Alert — Cyclone Precautions",
      desc: `Wind speed: ${windSpeed} km/h. Prakasam district is in the Bay of Bengal cyclone belt. Flying debris is a hazard to track workers.`,
      action: "Suspend overhead work. Clear loose materials from track. Seek shelter if wind exceeds 80 km/h.",
      irpwm: "IRPWM Para 2.13 — Cyclone Precautions"
    });
  }

  // ── All Clear ─────────────────────────────────────────────────────
  if (risks.length === 0) {
    risks.push({
      id: "ok",
      level: "low",
      icon: Icons.check(24, '#10B981'),
      title: "Track Conditions — Normal",
      desc: `Temperature: ${temp}°C, Humidity: ${humidity}%, Wind: ${windSpeed} km/h. No immediate weather hazards detected.`,
      action: "Normal maintenance operations. Maintain standard lookout procedures.",
      irpwm: "Continue regular gang patrol as per schedule"
    });
  }

  // ── Forecast alerts ────────────────────────────────────────────────
  if (forecast?.list) {
    const upcomingRain = forecast.list.find(f => (f.rain?.["3h"] || 0) > 30);
    if (upcomingRain) {
      const forecastTime = new Date(upcomingRain.dt * 1000);
      const hrs = Math.round((forecastTime - new Date()) / 3600000);
      risks.push({
        id: "forecast_rain",
        level: "medium",
        icon: Icons.rain(24, '#F59E0B'),
        title: `Heavy Rain Forecast — In ${hrs} Hours`,
        desc: `IMD forecast: ${(upcomingRain.rain?.["3h"] || 0).toFixed(0)}mm expected in next 3 hours. Prepare monsoon precautions.`,
        action: "Complete exposed track work before rain arrives. Clear all drainage channels.",
        irpwm: "IRPWM Para 2.11"
      });
    }
  }

  return risks;
}

function renderRisks(risks) {
  if (!elements.riskList) return;
  elements.riskList.innerHTML = "";
  risks.forEach((risk, i) => {
    const card = document.createElement("div");
    card.className = `risk-card risk-${risk.level} slide-in-up`;
    card.style.animationDelay = `${i * 0.08}s`;
    card.innerHTML = `
      <div class="risk-icon">${risk.icon}</div>
      <div class="risk-content">
        <div class="risk-title">${risk.title}</div>
        <div class="risk-desc">${risk.desc}</div>
        <div class="risk-action">→ ${risk.action}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">${risk.irpwm}</div>
      </div>`;
    elements.riskList.appendChild(card);
  });
}

function showOfflineWeather() {
  // Show season-based warnings without API
  const month = new Date().getMonth() + 1;
  const isMonsoon = month >= 6 && month <= 10;
  const isSummer = month >= 3 && month <= 5;

  if (elements.weatherIcon) elements.weatherIcon.innerHTML = isMonsoon ? Icons.rain(28, '#06B6D4') : isSummer ? Icons.sun(28, '#F59E0B') : Icons.cloud(28, '#94A3B8');
  if (elements.weatherTemp) elements.weatherTemp.textContent = isSummer ? "38°C" : isMonsoon ? "28°C" : "30°C";
  if (elements.weatherDesc) elements.weatherDesc.textContent = isMonsoon ? "Monsoon Season — Set OWM key for live data" : "Add OpenWeatherMap API key for live weather";

  const seasonRisks = isMonsoon
    ? [{ id:"monsoon",level:"medium",icon:Icons.rain(24, '#06B6D4'),title:"Monsoon Season Active",desc:"June–October: High risk period for Prakasam district. Cyclonic rainfall, bridge scour, embankment erosion.",action:"Daily inspection of Bridge 47 and low-lying sections. Clear drainage channels weekly.",irpwm:"IRPWM Para 2.11" }]
    : isSummer
    ? [{ id:"summer",level:"medium",icon:Icons.sun(24, '#F59E0B'),title:"Summer Hot Weather Patrolling",desc:"March–May: Rail temperatures can exceed 65°C. Sun kink risk on curves.",action:"Hot weather patrolling on curves km 233–235. Check rail joint expansion gaps.",irpwm:"IRPWM Para 2.9" }]
    : [{ id:"ok",level:"low",icon:Icons.check(24, '#10B981'),title:"Normal Season",desc:"Standard maintenance conditions. Add OWM API key for live weather data.",action:"Continue regular gang patrol.",irpwm:"Standard patrol schedule" }];

  renderRisks(seasonRisks);
  // Add pre-monsoon checklist reminder
  if (month === 5) {
    const risks = seasonRisks.concat([{id:"premonsoon",level:"high",icon:Icons.cloud(24, '#EF4444'),title:"Pre-Monsoon Checklist Due",desc:"May: Annual pre-monsoon track inspection and drain clearance must be completed before June 1.",action:"Submit completed SEN Form 1 (Pre-monsoon inspection) to AEN.",irpwm:"IRPWM Para 2.11.1"}]);
    renderRisks(risks);
  }
}
