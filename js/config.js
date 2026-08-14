/**
 * RailRaksha — Central Configuration (config.js)
 *
 * API keys are pre-loaded for your dad — no setup needed.
 * Users can override any value via ⚙️ Settings (protected by password).
 * localStorage values always take priority over these defaults.
 *
 * SECURITY: Keys live in js/config-keys.js (gitignored). On Vercel/Netlify
 * that file is regenerated at deploy time from environment variables by
 * build-keys.sh — real keys never enter the git repo.
 */

import { API_KEYS } from './config-keys.js';

export const DEFAULT_CONFIG = {
  // ── AI Provider (Bynara Router) — one model for text AND image tasks ─────
  ai_provider:  "openai_compatible",
  ai_model:     "mistral-medium-3-5",
  ai_base_url:  "https://router.bynara.id/v1",
  ai_api_key:   API_KEYS.bynara,

  // ── Live Train Tracking (RailRadar) ────────────────────────────────────────
  // Free at https://railradar.in/login
  railradar_key: API_KEYS.railradar,

  // ── Weather (OpenWeatherMap) ────────────────────────────────────────────────
  // Free at https://openweathermap.org/api
  owm_api_key:  API_KEYS.owm,

  // ── Gang Identity ──────────────────────────────────────────────────────────
  mate_name:    "",
  gang_no:      "",
  gang_strength: "25",
  section:      "SKM-OGL",

  // ── Alert Distance Thresholds (km) ─────────────────────────────────────────
  // These control GPS-based live alerts.
  // CRITICAL = all workers must clear the track immediately
  // WARN     = move all tools and equipment off the track
  // PREPARE  = heads up, a train is approaching
  alert_dist_critical: "4",    // km — default 4 km
  alert_dist_warn:     "8",    // km — default 8 km
  alert_dist_prepare:  "15",   // km — default 15 km

  // ── Alert Time Thresholds (minutes, schedule-based) ────────────────────────
  alert_min_critical:  "7",    // minutes until train reaches SKM
  alert_min_warn:      "15",
  alert_min_prepare:   "25",

  // ── Alert Mode ──────────────────────────────────────────────────────────────
  // "station" = alerts based on train crossing neighboring stations (default)
  // "gps"     = alerts based on live GPS distance (requires location permission)
  alert_mode:  "station",

  // ── Work Section ───────────────────────────────────────────────────────────
  // The section your gang works on. Trains approaching THIS section trigger alerts.
  work_station_a: "SKM",   // Singarayakonda (north end, BZA side)
  work_station_b: "UPD",   // Ulavapadu (south end, GDR side)
};

/**
 * Read a config value with priority:
 *   1. localStorage (user saved via Settings)
 *   2. DEFAULT_CONFIG above
 */
export function getConfig(key) {
  const stored = localStorage.getItem(key);
  if (stored !== null && stored !== "") return stored;
  return DEFAULT_CONFIG[key] ?? "";
}

/** Number helper — returns parsed float or the fallback default */
export function getConfigNum(key) {
  return parseFloat(getConfig(key)) || parseFloat(DEFAULT_CONFIG[key]) || 0;
}

/**
 * Apply all DEFAULT_CONFIG values to localStorage on first run.
 * Only fills keys that are currently empty — never overwrites user preferences.
 */
export function applyDefaultsOnce() {
  let configVersion = localStorage.getItem("_config_version");
  if (configVersion !== "2.4") {
    // Force-update AI settings to Bynara Router (Gemini removed in v2.2,
    // Groq rate-limited in v2.3, Bynara default from v2.4).
    // Only overwrite if the stored values are old defaults or missing.
    const oldProvider = localStorage.getItem("ai_provider");
    const oldModel = localStorage.getItem("ai_model");
    if (!oldProvider || oldProvider === "gemini" || oldModel === "llama-3.3-70b-versatile" || oldModel === "gemini-2.5-flash" || oldModel === "qwen/qwen3.6-27b" || !oldModel) {
      localStorage.setItem("ai_provider",  DEFAULT_CONFIG.ai_provider);
      localStorage.setItem("ai_model",     DEFAULT_CONFIG.ai_model);
      localStorage.setItem("ai_base_url",  DEFAULT_CONFIG.ai_base_url);
      localStorage.setItem("ai_api_key",   DEFAULT_CONFIG.ai_api_key);
    }
    // Remove the now-unused separate image AI settings
    localStorage.removeItem("image_ai_provider");
    localStorage.removeItem("image_ai_model");
    localStorage.removeItem("image_ai_api_key");
    localStorage.removeItem("gemini_api_key");
    localStorage.setItem("_config_version", "2.4");
  }

  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!localStorage.getItem(key) && value !== "") {
      localStorage.setItem(key, String(value));
    }
  }
}
