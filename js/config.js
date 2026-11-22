/**
 * RailRaksha — Central Configuration (config.js)
 *
 * Security: No secret API keys are bundled in client-side JS.
 * Production deployments route AI and live-train requests through server-side
 * proxies (/api/chat, /api/live-status). Users can optionally override keys
 * locally in Settings (stored only in their own browser's localStorage).
 */

export const DEFAULT_CONFIG = {
  // ── AI Provider (proxied server-side by default; user may override in Settings)
  ai_provider:  "openai_compatible",
  ai_model:     "auto",
  ai_base_url:  "https://generativelanguage.googleapis.com/v1beta/openai",
  ai_api_key:   "",

  // ── Live Train Tracking (RailRadar — proxied server-side by default)
  railradar_key: "",

  // ── Weather (Open-Meteo works free with zero key; optional OWM key override)
  owm_api_key:  "",

  // ── Gang Identity
  mate_name:     "",
  gang_no:       "",
  gang_strength: "25",
  section:       "SKM–UPD, Vijayawada Div.",

  // ── Alert Distance Thresholds (km)
  alert_dist_critical: "3",
  alert_dist_warn:     "8",
  alert_dist_prepare:  "15",

  // ── Alert Time Thresholds (minutes)
  alert_min_critical:  "3",
  alert_min_warn:      "5",
  alert_min_prepare:   "10",

  // ── Work Section
  work_station_a: "SKM",
  work_station_b: "UPD",
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
  const val = parseFloat(getConfig(key));
  return Number.isFinite(val) ? val : (parseFloat(DEFAULT_CONFIG[key]) || 0);
}

/**
 * Migrate legacy settings and fill missing defaults once.
 * Never overwrites valid user-entered identity or custom keys.
 */
export function applyDefaultsOnce() {
  const configVersion = localStorage.getItem("_config_version");
  if (configVersion !== "6.0") {
    const oldModel = localStorage.getItem("ai_model");
    const legacyModels = new Set([
      "agnes-2.5-flash",
      "llama-3.3-70b-versatile",
      "qwen/qwen3.6-27b",
      "mistral-medium-3-5",
    ]);
    if (!oldModel || legacyModels.has(oldModel)) {
      localStorage.setItem("ai_model", DEFAULT_CONFIG.ai_model);
    }
    const oldBase = localStorage.getItem("ai_base_url");
    if (!oldBase || oldBase.includes("router.bynara.id")) {
      localStorage.setItem("ai_base_url", DEFAULT_CONFIG.ai_base_url);
    }
    localStorage.removeItem("image_ai_provider");
    localStorage.removeItem("image_ai_model");
    localStorage.removeItem("image_ai_api_key");
    localStorage.removeItem("gemini_api_key");
    localStorage.setItem("_config_version", "6.0");
  }

  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (!localStorage.getItem(key) && value !== "") {
      localStorage.setItem(key, String(value));
    }
  }
}
