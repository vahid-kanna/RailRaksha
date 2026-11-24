/**
 * RailRaksha — Shared Cloudflare Edge API Handlers (worker/handlers.js)
 *
 * Pure Fetch-API handlers shared by:
 *   - Cloudflare Workers (worker/index.js)
 *   - Cloudflare Pages Functions (functions/api/*)
 *
 * Zero external dependencies. All API secrets stay strictly in Cloudflare env vars.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

/**
 * Resolve server-side AI provider from Cloudflare environment secrets.
 * Priority: AI_API_KEY -> GEMINI_API_KEY -> OPENROUTER_API_KEY -> GROQ_API_KEY -> BYNARA_API_KEY
 */
export function resolveAIProvider(env = {}) {
  if (env.AI_API_KEY) {
    return {
      apiKey: env.AI_API_KEY,
      baseUrl: (env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
      defaultModel: env.AI_MODEL || 'gemini-2.5-flash',
      name: 'custom',
    };
  }
  if (env.GEMINI_API_KEY) {
    return {
      apiKey: env.GEMINI_API_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: env.AI_MODEL || 'gemini-2.5-flash',
      name: 'gemini',
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: env.AI_MODEL || 'google/gemini-2.0-flash-001',
      name: 'openrouter',
    };
  }
  if (env.GROQ_API_KEY) {
    return {
      apiKey: env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: env.AI_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      name: 'groq',
    };
  }
  if (env.BYNARA_API_KEY) {
    return {
      apiKey: env.BYNARA_API_KEY,
      baseUrl: 'https://router.bynara.id/v1',
      defaultModel: env.AI_MODEL || 'agnes-2.5-flash',
      name: 'bynara',
    };
  }
  return null;
}

/**
 * Normalize RailRadar v1 (and compatible) payloads into live-trains.js shape.
 */
export function normalizeRailRadarPayload(raw) {
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;

  const stations = d.stations || d.route || d.stationList || d.stops || [];
  let lastPassed = null;
  for (const st of stations) {
    const act = st.actualDeparture || st.actualDepartureTime || st.actDep || st.departedAt || st.actualArrival;
    if (act && act !== '--' && act !== '00:00') lastPassed = st;
  }

  const cur = d.currentLocation || d.currentStation || d.lastStation || lastPassed || {};
  const code = String(
    cur.stationCode ||
    cur.code ||
    cur.stnCode ||
    d.currentStationCode ||
    d.lastStationCode ||
    (typeof d.currentStation === 'string' ? d.currentStation : '') ||
    ''
  ).trim().toUpperCase();

  if (!code) return null;

  const delayMin = Number(
    d.delayMinutes ?? d.delayInMinutes ?? d.delay ?? cur.delayMinutes ?? cur.delay ?? 0
  );
  const actualDep =
    cur.actualDeparture ||
    cur.actualDepartureTime ||
    cur.departureTime ||
    d.lastUpdatedAt ||
    null;
  const speed = Number(cur.speed ?? d.speed ?? NaN);
  const hasDeparted = cur.hasDeparted ?? (d.status === 'halted' || d.status === 'at-station' ? false : true);

  return {
    last_station_code: code,
    event: hasDeparted === false ? 'ARRIVED' : 'DEPARTED',
    delay_min: Number.isFinite(delayMin) ? delayMin : 0,
    actual_departure: actualDep,
    speed_kmh: Number.isFinite(speed) && speed >= 0 && speed <= 160 ? speed : null,
    updated_at: d.lastUpdatedAt || d.updatedAt || raw?.meta?.timestamp || new Date().toISOString(),
  };
}

/**
 * GET /api/health
 */
export async function handleHealth(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const ai = resolveAIProvider(env);
  const hasRailRadar = Boolean(env.RAILRADAR_API_KEY || env.RAILRADAR_KEY);

  return jsonResponse({
    status: 'ok',
    version: '7.0',
    host: 'cloudflare',
    timestamp: new Date().toISOString(),
    services: {
      ai: {
        configured: Boolean(ai),
        provider: ai ? ai.name : null,
        model: ai ? ai.defaultModel : null,
      },
      liveTrains: {
        configured: hasRailRadar,
        provider: hasRailRadar ? 'railradar-v1' : 'schedule-offline',
      },
      weather: {
        configured: true,
        provider: 'open-meteo',
      },
    },
  }, 200, { 'Cache-Control': 'no-store' });
}

/**
 * POST /api/chat
 */
export async function handleChat(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed', code: 'method_not_allowed' } }, 405);
  }

  const provider = resolveAIProvider(env);
  if (!provider) {
    return jsonResponse({
      error: {
        message: 'Cloud AI proxy is not configured on this server yet. Offline mode remains active, or add a personal API key in Settings.',
        code: 'ai_not_configured',
      },
    }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: 'Invalid JSON request body', code: 'bad_request' } }, 400);
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({ error: { message: 'Field "messages" must be a non-empty array', code: 'bad_request' } }, 400);
  }

  const payload = { ...body };
  if (!payload.model || payload.model === 'auto' || payload.model === 'agnes-2.5-flash') {
    payload.model = provider.defaultModel;
  }
  // Ensure reasoning/thinking models have adequate output headroom
  if (!payload.max_tokens || payload.max_tokens < 1024) {
    payload.max_tokens = Math.max(payload.max_tokens || 2048, 2048);
  }

  const endpoint = provider.baseUrl.endsWith('/chat/completions')
    ? provider.baseUrl
    : `${provider.baseUrl}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.apiKey}`,
  };
  if (provider.name === 'openrouter') {
    headers['HTTP-Referer'] = 'https://railraksha.tech';
    headers['X-Title'] = 'RailRaksha';
  }

  const maxAttempts = 2;
  let lastStatus = 504;
  let lastText = JSON.stringify({ error: { message: 'Upstream AI request failed', code: 'upstream_error' } });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await upstream.text();
      if (upstream.ok) {
        return new Response(text, {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      }

      lastStatus = upstream.status;
      lastText = text || JSON.stringify({ error: { message: `Upstream AI error ${upstream.status}` } });

      // Do not retry non-429 client errors
      if (upstream.status >= 400 && upstream.status < 500 && upstream.status !== 429) {
        return new Response(lastText, {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
        });
      }
    } catch (err) {
      clearTimeout(timer);
      lastStatus = 504;
      lastText = JSON.stringify({
        error: {
          message: err?.name === 'AbortError' ? 'Upstream AI request timed out' : (err?.message || 'Upstream AI error'),
          code: 'upstream_timeout',
        },
      });
    }

    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return new Response(lastText, {
    status: lastStatus,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

/**
 * GET /api/live-status?train=12711&date=YYYY-MM-DD
 */
export async function handleLiveStatus(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const url = new URL(request.url);
  const train = url.searchParams.get('train');
  const date = url.searchParams.get('date');

  if (!train || !/^\d{4,5}$/.test(train)) {
    return jsonResponse({ error: 'Valid 4 or 5 digit train number required' }, 400);
  }

  const apiKey = env.RAILRADAR_API_KEY || env.RAILRADAR_KEY;
  if (!apiKey) {
    return jsonResponse({ error: 'Live train feed key not configured on server; using offline schedule mode' }, 501);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const qs = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `?date=${encodeURIComponent(date)}` : '';
    const response = await fetch(`https://api.railradar.in/v1/trains/${train}/live${qs}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      return jsonResponse({ error: `Upstream RailRadar error ${response.status}` }, response.status);
    }

    const raw = await response.json();
    const normalized = normalizeRailRadarPayload(raw);
    if (!normalized) {
      return jsonResponse({ error: 'Unrecognized upstream train status payload' }, 422);
    }

    return jsonResponse(normalized, 200, {
      'Cache-Control': 'public, max-age=20, s-maxage=20',
    });
  } catch (err) {
    clearTimeout(timer);
    return jsonResponse({
      error: err?.name === 'AbortError' ? 'Live status upstream timeout' : 'Live status upstream error',
    }, 504);
  }
}
