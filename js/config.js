/**
 * RailRaksha — Central Configuration v7.0 (config.js)
 *
 * Security invariant: No secret API keys exist in client-side JS.
 * Cloud AI and live-train requests route through Cloudflare edge handlers
 * (/api/chat, /api/live-status). Optional personal key overrides live only
 * in the user's own browser localStorage.
 */

export const DEFAULT_CONFIG = {
  // ── Display & Audio Preferences
  theme:        'dark',     // 'dark' | 'daylight'
  voice_lang:   'te+en',    // 'te+en' | 'en' | 'te'

  // ── AI Provider (optional personal override; blank = Cloudflare /api/chat proxy)
  ai_provider:  'openai_compatible',
  ai_model:     'auto',
  ai_base_url:  'https://generativelanguage.googleapis.com/v1beta/openai',
  ai_api_key:   '',

  // ── Live Train Tracking (optional direct key; blank = Cloudflare /api/live-status proxy)
  railradar_key: '',

  // ── Weather (Open-Meteo works free with zero key; optional OWM override)
  owm_api_key:  '',

  // ── Gang Identity & Emergency Contact
  mate_name:     '',
  gang_no:       '',
  gang_strength: '25',
  section:       'SKM–UPD, Vijayawada Div.',
  pwi_phone:     '',

  // ── Alert Distance Thresholds (km)
  alert_dist_critical: '3',
  alert_dist_warn:     '8',
  alert_dist_prepare:  '15',

  // ── Alert Time Thresholds (minutes)
  alert_min_critical:  '3',
  alert_min_warn:      '5',
  alert_min_prepare:   '10',

  // ── Work Section
  work_station_a: 'SKM',
  work_station_b: 'UPD',
};

/** Read config value with priority: localStorage > DEFAULT_CONFIG. */
export function getConfig(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && stored !== '') return stored;
  } catch {}
  return DEFAULT_CONFIG[key] ?? '';
}

/** Read numeric config value safely. */
export function getConfigNum(key) {
  const val = parseFloat(getConfig(key));
  return Number.isFinite(val) ? val : (parseFloat(DEFAULT_CONFIG[key]) || 0);
}

/** Migrate legacy settings and backfill missing defaults once. */
export function applyDefaultsOnce() {
  try {
    const version = localStorage.getItem('_config_version');
    if (version !== '7.0') {
      const oldModel = localStorage.getItem('ai_model');
      const legacyModels = new Set([
        'agnes-2.5-flash',
        'llama-3.3-70b-versatile',
        'qwen/qwen3.6-27b',
        'mistral-medium-3-5',
      ]);
      if (!oldModel || legacyModels.has(oldModel)) {
        localStorage.setItem('ai_model', DEFAULT_CONFIG.ai_model);
      }
      const oldBase = localStorage.getItem('ai_base_url');
      if (!oldBase || oldBase.includes('router.bynara.id')) {
        localStorage.setItem('ai_base_url', DEFAULT_CONFIG.ai_base_url);
      }
      ['image_ai_provider', 'image_ai_model', 'image_ai_api_key', 'gemini_api_key'].forEach(k => {
        localStorage.removeItem(k);
      });
      // Migrate legacy rr.lang if present
      const legacyLang = localStorage.getItem('rr.lang');
      if (legacyLang && !localStorage.getItem('voice_lang')) {
        localStorage.setItem('voice_lang', legacyLang);
      }
      localStorage.setItem('_config_version', '7.0');
    }

    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (!localStorage.getItem(key) && value !== '') {
        localStorage.setItem(key, String(value));
      }
    }
  } catch {}
}
