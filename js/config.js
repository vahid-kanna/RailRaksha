/**
 * RailRaksha — Central Configuration v8.1 (config.js)
 *
 * Security invariant: Zero secret API keys in client-side code.
 * Live trains (/api/corridor-live, /api/live-status) and AI (/api/chat)
 * route through Cloudflare Worker secrets. Optional personal overrides
 * remain strictly in the local browser's localStorage.
 */

export const DEFAULT_CONFIG = {
  // Display & Audio
  theme:        'light',    // 'light' (Cool Titanium) | 'night' (Machined Gunmetal)
  voice_lang:   'te+en',    // 'te+en' | 'en' | 'te'
  voice_enabled: '1',       // '1' | '0'
  prefer_live:   '1',       // '1' (Live RailRadar first) | '0' (Offline schedule only)

  // AI Provider (optional personal override; blank = Cloudflare /api/chat proxy)
  ai_provider:  'openai_compatible',
  ai_model:     'auto',
  ai_base_url:  'https://generativelanguage.googleapis.com/v1beta/openai',
  ai_api_key:   '',

  // Live Train Tracking (optional personal override; blank = Cloudflare /api/corridor-live proxy)
  railradar_key: '',

  // Weather (Open-Meteo works free with zero key; optional OWM override)
  owm_api_key:  '',

  // Gang Identity & Emergency Contact
  mate_name:     '',
  gang_no:       '',
  gang_strength: '25',
  section:       'SKM–UPD, Vijayawada Div.',
  pwi_phone:     '',

  // Alert Distance Thresholds (km)
  alert_dist_critical: '3',
  alert_dist_warn:     '8',
  alert_dist_prepare:  '15',

  // Alert Time Thresholds (minutes)
  alert_min_critical:  '3',
  alert_min_warn:      '5',
  alert_min_prepare:   '10',

  // Work Section
  work_station_a: 'SKM',
  work_station_b: 'UPD',
};

export function getConfig(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && stored !== '') return stored;
  } catch {}
  return DEFAULT_CONFIG[key] ?? '';
}

export function getConfigNum(key) {
  const val = parseFloat(getConfig(key));
  return Number.isFinite(val) ? val : (parseFloat(DEFAULT_CONFIG[key]) || 0);
}

export function applyDefaultsOnce() {
  try {
    const version = localStorage.getItem('_config_version');
    if (version !== '8.1') {
      // Upgrade legacy dark/daylight themes to Cool Titanium light default on v8.0+ transition
      const prevTheme = localStorage.getItem('theme');
      if (!prevTheme || prevTheme === 'dark' || prevTheme === 'daylight') {
        localStorage.setItem('theme', 'light');
      }
      const oldModel = localStorage.getItem('ai_model');
      const legacyModels = new Set([
        'agnes-2.5-flash',
        'gemini-2.5-flash',
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
      const legacyLang = localStorage.getItem('rr.lang');
      if (legacyLang && !localStorage.getItem('voice_lang')) {
        localStorage.setItem('voice_lang', legacyLang);
      }
      localStorage.setItem('_config_version', '8.1');
    }

    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      if (!localStorage.getItem(key) && value !== '') {
        localStorage.setItem(key, String(value));
      }
    }
  } catch {}
}
