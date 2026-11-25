/**
 * RailRaksha — Cloudflare Edge API Handlers v8.1 (worker/handlers.js)
 *
 * Pure Web-Standard Request/Response handlers shared by Cloudflare Workers
 * (worker/index.js) and Cloudflare Pages Functions (functions/api/*).
 *
 * Endpoints:
 *   GET  /api/health         -> Service & secret availability diagnostics
 *   POST /api/chat           -> Multi-provider AI proxy with automatic Gemini 3 model failover
 *   GET  /api/corridor-live  -> Live-data-first BZA<->GDR corridor train telemetry (OGL/NLR boards, quota-safe)
 *   GET  /api/live-status    -> Single-train live status (RailRadar v1)
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-RailRadar-Key',
};

// Corridor station chainage lookup (km from GDR=162 to BZA=445, matched to js/corridor.js)
const CORRIDOR_KM = {
  GDR: 162, NLR: 200, BVRT: 232, BTTR: 232, KVZ: 250, UPD: 265,
  INGR: 282, SKM: 293, TGU: 305, OGL: 321, ANB: 338, CL: 356,
  CLX: 356, BPP: 371, TEL: 414, BZA: 445,
};

const GEMINI_FALLBACK_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
];

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
 * Resolve server-side AI provider from Cloudflare Worker secrets.
 */
export function resolveAIProvider(env = {}) {
  if (env.AI_API_KEY) {
    return {
      apiKey: env.AI_API_KEY,
      baseUrl: (env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
      defaultModel: env.AI_MODEL || GEMINI_FALLBACK_MODELS[0],
      fallbackModels: env.AI_MODEL ? [env.AI_MODEL] : GEMINI_FALLBACK_MODELS,
      name: 'custom',
    };
  }
  if (env.GEMINI_API_KEY) {
    const preferred = env.AI_MODEL && env.AI_MODEL !== 'auto'
      ? [env.AI_MODEL, ...GEMINI_FALLBACK_MODELS.filter(m => m !== env.AI_MODEL)]
      : GEMINI_FALLBACK_MODELS;
    return {
      apiKey: env.GEMINI_API_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: preferred[0],
      fallbackModels: preferred,
      name: 'gemini',
    };
  }
  if (env.OPENROUTER_API_KEY) {
    return {
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: env.AI_MODEL || 'google/gemini-2.0-flash-001',
      fallbackModels: [env.AI_MODEL || 'google/gemini-2.0-flash-001'],
      name: 'openrouter',
    };
  }
  if (env.GROQ_API_KEY) {
    return {
      apiKey: env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: env.AI_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      fallbackModels: [env.AI_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'],
      name: 'groq',
    };
  }
  if (env.BYNARA_API_KEY) {
    return {
      apiKey: env.BYNARA_API_KEY,
      baseUrl: 'https://router.bynara.id/v1',
      defaultModel: env.AI_MODEL || 'agnes-2.5-flash',
      fallbackModels: [env.AI_MODEL || 'agnes-2.5-flash'],
      name: 'bynara',
    };
  }
  return null;
}

/**
 * Infer direction (UP toward BZA, DN toward GDR) from a RailRadar v1 route array.
 */
export function inferCorridorDirection(route = [], prevCode = '', nextCode = '') {
  const seen = [];
  for (const st of route) {
    const code = String(st.stationCode || st.code || '').toUpperCase();
    if (CORRIDOR_KM[code] != null) seen.push(CORRIDOR_KM[code]);
  }
  if (seen.length >= 2) {
    return seen[seen.length - 1] > seen[0] ? 'UP' : 'DN';
  }
  const pKm = CORRIDOR_KM[String(prevCode || '').toUpperCase()];
  const nKm = CORRIDOR_KM[String(nextCode || '').toUpperCase()];
  if (pKm != null && nKm != null && pKm !== nKm) {
    return nKm > pKm ? 'UP' : 'DN';
  }
  return null;
}

/**
 * Normalize RailRadar v1 `/v1/trains/{no}/live` response into RailRaksha telemetry shape.
 */
export function normalizeRailRadarPayload(raw) {
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;

  const route = Array.isArray(d.route) ? d.route
    : Array.isArray(d.stations) ? d.stations
    : Array.isArray(d.stops) ? d.stops
    : [];

  let lastPassed = null;
  for (const st of route) {
    if (st.status === 'departed' || st.status === 'at-station' || st.actualDeparture || st.actualArrival) {
      lastPassed = st;
    }
  }

  const cur = d.currentLocation || d.currentStation || d.lastStation || lastPassed || {};
  const code = String(
    cur.stationCode || cur.code || cur.stnCode || d.currentStationCode || d.lastStationCode || ''
  ).trim().toUpperCase();

  if (!code) return null;

  const delayMin = Number(
    cur.delayMinutes ?? d.delayMinutes ?? d.delayInMinutes ?? d.delay ?? 0
  );
  const statusStr = String(cur.status || d.status || '').toLowerCase();
  const event = (statusStr === 'at-station' || statusStr === 'halted' || statusStr === 'arrived' || cur.hasDeparted === false)
    ? 'ARRIVED'
    : 'DEPARTED';

  // Find actual departure timestamp for the current/last corridor station if available
  const curRouteStop = route.find(s => String(s.stationCode || '').toUpperCase() === code) || lastPassed || {};
  const actualDep =
    curRouteStop.actualDeparture ||
    curRouteStop.actualArrival ||
    cur.actualDeparture ||
    cur.actualDepartureTime ||
    d.lastUpdatedAt ||
    null;

  // Prefer live speedKmh when > 0, else route segment speedToNextStationKmph, else train avg/max speed
  let speed = Number(cur.speedKmh ?? cur.speed ?? d.speed ?? NaN);
  if (!Number.isFinite(speed) || speed <= 0) {
    const segSpd = Number(curRouteStop.speedToNextStationKmph ?? d.train?.avgSpeed ?? NaN);
    speed = Number.isFinite(segSpd) && segSpd > 0 ? segSpd : NaN;
  }

  const distFromLast = Number(cur.distanceFromLastStationKm ?? NaN);
  const dir = inferCorridorDirection(
    route,
    d.previousHalt?.stationCode || curRouteStop.stationCode,
    d.nextHalt?.stationCode
  );

  // Extract corridor stops for accurate interpolation when live train isn't in static timetable
  const corridorStops = route
    .filter(s => CORRIDOR_KM[String(s.stationCode || '').toUpperCase()] != null)
    .map(s => ({
      code: String(s.stationCode).toUpperCase(),
      km: CORRIDOR_KM[String(s.stationCode).toUpperCase()],
      status: s.status || 'upcoming',
      schDep: s.scheduledDeparture || s.scheduledArrival || null,
      actDep: s.actualDeparture || s.actualArrival || null,
      delay: Number(s.delayDeparture ?? s.delayArrival ?? delayMin) || 0,
      speedKmh: Number(s.speedToNextStationKmph) || null,
    }));

  return {
    train_no: String(d.trainNumber || d.train?.number || '').trim(),
    train_name: String(d.trainName || d.train?.name || '').trim(),
    train_type: String(d.train?.type || d.train?.category || 'Express'),
    dir,
    status: String(d.status || 'running'),
    is_live: Boolean(d.isLive ?? (d.status === 'running')),
    last_station_code: code,
    last_station_name: String(cur.stationName || curRouteStop.stationName || code),
    next_halt_code: d.nextHalt?.stationCode ? String(d.nextHalt.stationCode).toUpperCase() : null,
    next_halt_name: d.nextHalt?.stationName || null,
    distance_from_last_km: Number.isFinite(distFromLast) && distFromLast >= 0 ? distFromLast : 0,
    event,
    delay_min: Number.isFinite(delayMin) ? Math.round(delayMin) : 0,
    actual_departure: actualDep,
    speed_kmh: Number.isFinite(speed) && speed > 0 && speed <= 160 ? Math.round(speed) : null,
    vmax_kmh: Number(d.train?.maxSpeed) > 0 ? Math.round(Number(d.train.maxSpeed)) : 110,
    updated_at: d.lastUpdatedAt || d.updatedAt || raw?.meta?.timestamp || new Date().toISOString(),
    corridor_stops: corridorStops,
  };
}

/**
 * Resolve RailRadar API key: optional client `X-RailRadar-Key` header overrides
 * the Cloudflare Worker secret (`RAILRADAR_API_KEY` / `RAILRADAR_KEY`).
 */
function resolveRailRadarKey(request, env = {}) {
  const headerKey = request?.headers?.get?.('X-RailRadar-Key')?.trim();
  if (headerKey) return headerKey;
  return env.RAILRADAR_API_KEY || env.RAILRADAR_KEY || '';
}

async function shortKeyTag(str) {
  try {
    if (globalThis.crypto?.subtle) {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf).slice(0, 6), b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  return '';
}

/**
 * GET /api/health
 */
export async function handleHealth(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const ai = resolveAIProvider(env);
  const hasRailRadar = Boolean(env.RAILRADAR_API_KEY || env.RAILRADAR_KEY);
  const hasRailCore = Boolean(env.RAILCORE_API_KEY);

  return jsonResponse({
    status: 'ok',
    version: '8.1',
    host: 'cloudflare',
    timestamp: new Date().toISOString(),
    services: {
      ai: {
        configured: Boolean(ai),
        provider: ai ? ai.name : null,
        model: ai ? ai.defaultModel : null,
      },
      liveTrains: {
        configured: hasRailRadar || hasRailCore,
        provider: hasRailRadar
          ? 'railradar-v1-corridor-live'
          : (hasRailCore ? 'railcore-hook' : 'schedule-offline'),
        ...(hasRailCore ? { railcoreConfigured: true } : {}),
      },
      weather: {
        configured: true,
        provider: 'open-meteo',
      },
    },
  }, 200, { 'Cache-Control': 'no-store' });
}

/**
 * POST /api/chat — AI proxy with automatic model failover (e.g. Gemini 3 Flash chain)
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

  const requestedModel = body.model && body.model !== 'auto' && body.model !== 'agnes-2.5-flash' && body.model !== 'gemini-2.5-flash'
    ? body.model
    : null;
  const modelsToTry = requestedModel
    ? [requestedModel, ...provider.fallbackModels.filter(m => m !== requestedModel)]
    : provider.fallbackModels;

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

  let lastStatus = 504;
  let lastText = JSON.stringify({ error: { message: 'Upstream AI request failed', code: 'upstream_error' } });

  for (const mdl of modelsToTry) {
    const payload = {
      ...body,
      model: mdl,
      max_tokens: Math.max(Number(body.max_tokens) || 3072, 3072),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
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
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-RailRaksha-Model': mdl,
            ...CORS_HEADERS,
          },
        });
      }

      lastStatus = upstream.status;
      lastText = text || JSON.stringify({ error: { message: `Upstream AI error ${upstream.status}` } });

      // Fail over to next model on 404 (deprecated), 429 (rate limit), or 5xx (demand spike)
      if (upstream.status === 404 || upstream.status === 429 || upstream.status >= 500) {
        continue;
      }
      // Hard 400/401/403 client/auth errors stop immediately
      return new Response(lastText, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
      });
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

  const apiKey = resolveRailRadarKey(request, env);
  if (!apiKey) {
    return jsonResponse({ error: 'Live train feed key not configured on server' }, 501);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

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
      return jsonResponse({ error: 'Train not currently reporting live location' }, 422);
    }

    return jsonResponse(normalized, 200, {
      'Cache-Control': 'public, max-age=25, s-maxage=25',
    });
  } catch (err) {
    clearTimeout(timer);
    return jsonResponse({
      error: err?.name === 'AbortError' ? 'Live status upstream timeout' : 'Live status upstream error',
    }, 504);
  }
}

/**
 * Infer UP (toward BZA / North) vs DN (toward GDR / South) from origin/destination codes
 * when a train only appears on one corridor station board.
 */
const SOUTH_HUBS = new Set([
  'GDR','MAS','MS','TBM','CGL','TPTY','RU','SBC','SMVB','YPR','KSR','CBE','ED','SA',
  'MDU','TPJ','CAPE','NCJ','TVC','ERS','ALLP','CLT','MAQ','PDY','VM','TCNR','TEN',
  'KPD','JTJ','BNC','MYS','PGT','QLN','RMM','DMM','ATP','GTL','KJM','AJJ','PER',
]);
const NORTH_HUBS = new Set([
  'BZA','SC','HYB','LPI','CHZ','KCG','KZJ','WL','VSKP','VZM','CCT','RJY','EE','GNT',
  'NS','MTM','COA','HWH','SHM','SRC','BBS','PURI','SBP','HTE','DHN','TATA','JSME',
  'PNBE','DNR','BJU','GHY','SCL','DBRG','NDLS','NZM','DLI','ANVT','CNB','LKO','BSB',
  'PRYJ','JBP','NGP','BPL','INDB','ADI','ST','LTT','CSMT','PUNE','BSP','R','DURG',
  'KRBA','RNC','ASN','MFP','DBG','JYG','AADR','CDG','ASR','JAT','SVDK','YNRK',
]);

export function inferDirectionFromEndpoints(source, destination) {
  const s = String(source || '').toUpperCase();
  const d = String(destination || '').toUpperCase();
  if (CORRIDOR_KM[s] != null && CORRIDOR_KM[d] != null && CORRIDOR_KM[s] !== CORRIDOR_KM[d]) {
    return CORRIDOR_KM[d] > CORRIDOR_KM[s] ? 'UP' : 'DN';
  }
  if (SOUTH_HUBS.has(s) && NORTH_HUBS.has(d)) return 'UP';
  if (NORTH_HUBS.has(s) && SOUTH_HUBS.has(d)) return 'DN';
  if (SOUTH_HUBS.has(s) && !SOUTH_HUBS.has(d)) return 'UP';
  if (NORTH_HUBS.has(s) && !NORTH_HUBS.has(d)) return 'DN';
  if (NORTH_HUBS.has(d) && !NORTH_HUBS.has(s)) return 'UP';
  if (SOUTH_HUBS.has(d) && !SOUTH_HUBS.has(s)) return 'DN';
  return null;
}

/**
 * GET /api/corridor-live
 *
 * Live-Data-First Corridor Aggregator (quota-safe):
 *   - Default: queries ONLY OGL (km 321) and NLR (km 200) live station boards (2 upstream calls)
 *   - Optional `?scope=skm`: queries ONLY SKM (km 293) board (1 upstream call)
 *   - Optional `?enrich=1`: enriches at most 1 closest active train via `/v1/trains/{no}/live`
 *   - Supports optional `X-RailRadar-Key` request header override
 *   - Cached 300s at Cloudflare Edge (`caches.default`) + 1-hour stale fallback copy (`staleCacheKey`)
 *   - Returns HTTP 200 `{ ok: false, quotaExceeded, stale, source: 'schedule-fallback', trains }` on 429/unreachable
 */
export async function handleCorridorLive(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const headerKey = request.headers.get('X-RailRadar-Key')?.trim() || '';
  const apiKey = resolveRailRadarKey(request, env);

  // Optional RailCore provider hook/placeholder when RailRadar key is absent
  if (!apiKey && env.RAILCORE_API_KEY) {
    return jsonResponse({
      ok: false,
      quotaExceeded: false,
      stale: false,
      source: 'schedule-fallback',
      updatedAt: new Date().toISOString(),
      anchors: [],
      totalDiscovered: 0,
      liveEnriched: 0,
      trains: [],
      provider: 'railcore-hook',
      error: 'RailCore provider hook reserved; schedule fallback active.',
    }, 200, { 'Cache-Control': 'public, max-age=60, s-maxage=60' });
  }

  if (!apiKey) {
    return jsonResponse({ error: 'RAILRADAR_API_KEY not configured' }, 501);
  }

  const url = new URL(request.url);
  const bypassCache = url.searchParams.get('fresh') === '1';
  const scope = (url.searchParams.get('scope') || '').toLowerCase();
  const wantEnrich = url.searchParams.get('enrich') === '1';

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const keyTag = headerKey ? await shortKeyTag(headerKey) : '';
  const useCache = Boolean(cache && (!headerKey || keyTag));

  const qsParts = [];
  if (scope === 'skm') qsParts.push('scope=skm');
  if (keyTag) qsParts.push(`k=${keyTag}`);
  const cacheQs = qsParts.length ? `?${qsParts.join('&')}` : '';

  const cacheKey = new Request(`${url.origin}/api/corridor-live${cacheQs}`, { method: 'GET' });
  const staleCacheKey = new Request(`${url.origin}/api/corridor-live/__stale${cacheQs}`, { method: 'GET' });

  if (useCache && !bypassCache && !wantEnrich) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const authHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  // Query ONLY OGL + NLR by default (2 upstream calls), or SKM if ?scope=skm (1 upstream call)
  const anchors = scope === 'skm' ? ['SKM'] : ['OGL', 'NLR'];
  const boardResults = await Promise.allSettled(
    anchors.map(async (stn) => {
      const resp = await fetch(`https://api.railradar.in/v1/stations/${stn}/live?hours=2`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) {
        let errMsg = `${stn} HTTP ${resp.status}`;
        let errCode = '';
        try {
          const errJson = await resp.json();
          errCode = String(errJson?.error?.code || errJson?.code || '').toLowerCase();
          const msg = errJson?.error?.message || errJson?.message || errJson?.error;
          if (typeof msg === 'string' && msg) errMsg = `${stn} HTTP ${resp.status}: ${msg}`;
        } catch {}
        const err = new Error(errMsg);
        err.status = resp.status;
        err.isQuota = resp.status === 429 || errCode.includes('quota') || errCode.includes('rate_limit');
        throw err;
      }
      const json = await resp.json();
      if (json?.success === false) {
        const errCode = String(json?.error?.code || json?.code || '').toLowerCase();
        const msg = json?.error?.message || json?.message || 'RailRadar live board error';
        const err = new Error(`${stn}: ${msg}`);
        err.status = 429;
        err.isQuota = errCode.includes('quota') || errCode.includes('rate') || errCode.includes('limit');
        throw err;
      }
      return { stn, trains: json?.data?.trains || [], meta: json?.meta || null };
    })
  );

  const byTrain = new Map();
  const boardsOk = [];
  let any429 = false;
  let firstErrMsg = '';
  let serverNowISO = new Date().toISOString();

  for (const res of boardResults) {
    if (res.status !== 'fulfilled') {
      const reason = res.reason;
      if (reason?.isQuota || reason?.status === 429 || /\b429\b/.test(String(reason?.message || ''))) {
        any429 = true;
      }
      if (!firstErrMsg && reason?.message) firstErrMsg = reason.message;
      continue;
    }
    boardsOk.push(res.value.stn);
    if (res.value.meta?.timestamp) serverNowISO = res.value.meta.timestamp;

    for (const item of res.value.trains) {
      const no = String(item?.train?.number || '').trim();
      if (!/^\d{4,5}$/.test(no)) continue;
      const liveType = item?.live?.type || 'scheduled';
      const existing = byTrain.get(no) || {
        no,
        name: item?.train?.name || `Train ${no}`,
        type: item?.train?.type || 'Express',
        source: item?.train?.source || '',
        destination: item?.train?.destination || '',
        boards: {},
        liveType: 'scheduled',
        delayMin: null,
        priority: 0,
      };
      existing.boards[res.value.stn] = {
        type: liveType,
        expectedArrival: item?.live?.expectedArrivalTime || null,
        expectedDeparture: item?.live?.expectedDepartureTime || null,
        delayMinutes: item?.live?.delayMinutes ?? null,
        platform: item?.stop?.platform || null,
      };
      const prio = liveType === 'at-station' ? 4
        : (liveType === 'upcoming' || liveType === 'departed') ? 3
        : (item?.live?.delayMinutes != null ? 2 : 1);
      if (prio > existing.priority) {
        existing.priority = prio;
        existing.liveType = liveType;
      }
      if (item?.live?.delayMinutes != null) {
        existing.delayMin = Number(item.live.delayMinutes);
      }
      byTrain.set(no, existing);
    }
  }

  if (boardsOk.length === 0) {
    let staleData = null;
    if (useCache) {
      const staleCandidates = [staleCacheKey];
      if (scope === 'skm') {
        const defaultQs = keyTag ? `?k=${keyTag}` : '';
        staleCandidates.push(new Request(`${url.origin}/api/corridor-live/__stale${defaultQs}`, { method: 'GET' }));
      }
      for (const sKey of staleCandidates) {
        try {
          const staleResp = await cache.match(sKey);
          if (staleResp && staleResp.ok) {
            const parsed = await staleResp.json();
            if (parsed && Array.isArray(parsed.trains) && parsed.trains.length > 0) {
              staleData = parsed;
              break;
            }
          }
        } catch {}
      }
    }

    const fallbackBody = {
      ok: false,
      quotaExceeded: any429,
      stale: Boolean(staleData),
      source: 'schedule-fallback',
      updatedAt: staleData?.updatedAt || new Date().toISOString(),
      anchors: staleData?.anchors || [],
      totalDiscovered: staleData?.trains?.length || 0,
      liveEnriched: 0,
      trains: staleData?.trains || [],
      error: any429
        ? 'RailRadar quota exceeded (429) — schedule fallback active'
        : (firstErrMsg || 'Unable to reach RailRadar live station boards'),
    };

    const fallbackResp = jsonResponse(fallbackBody, 200, {
      'Cache-Control': any429 ? 'public, max-age=180, s-maxage=180' : 'no-store',
    });
    if (useCache && any429) {
      try { await cache.put(cacheKey, fallbackResp.clone()); } catch {}
    }
    return fallbackResp;
  }

  // Routine polls perform 0 extra detail calls; enrich at most 1 train only when ?enrich=1
  const liveMap = new Map();
  if (wantEnrich) {
    const candidates = [...byTrain.values()]
      .filter(c => c.priority >= 3)
      .sort((a, b) => {
        const aSkm = a.boards.SKM ? 3 : a.boards.OGL ? 2 : 1;
        const bSkm = b.boards.SKM ? 3 : b.boards.OGL ? 2 : 1;
        return (b.priority * 4 + bSkm) - (a.priority * 4 + aSkm);
      })
      .slice(0, 1);

    const enriched = await Promise.allSettled(
      candidates.map(async (c) => {
        const resp = await fetch(`https://api.railradar.in/v1/trains/${c.no}/live`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(6500),
        });
        if (!resp.ok) return null;
        return normalizeRailRadarPayload(await resp.json());
      })
    );

    for (const res of enriched) {
      if (res.status === 'fulfilled' && res.value && res.value.train_no) {
        liveMap.set(res.value.train_no, res.value);
      }
    }
  }

  const trains = [...byTrain.values()].map(c => {
    const detail = liveMap.get(c.no) || null;
    let dir = detail?.dir || null;
    // 1. Multi-board arrival ordering gives exact direction (higher km = north/UP)
    if (!dir) {
      const pts = [];
      for (const code of ['NLR', 'SKM', 'OGL']) {
        const t = Date.parse(c.boards[code]?.expectedArrival || c.boards[code]?.expectedDeparture || '');
        if (Number.isFinite(t)) pts.push({ km: CORRIDOR_KM[code], t });
      }
      if (pts.length >= 2) {
        pts.sort((a, b) => a.t - b.t);
        if (pts[pts.length - 1].km !== pts[0].km) {
          dir = pts[pts.length - 1].km > pts[0].km ? 'UP' : 'DN';
        }
      }
    }
    // 2. Origin/destination hub lookup
    if (!dir) {
      dir = inferDirectionFromEndpoints(c.source, c.destination);
    }

    return {
      no: c.no,
      name: detail?.train_name || c.name,
      type: detail?.train_type || c.type,
      from: c.source,
      to: c.destination,
      dir,
      liveType: c.liveType,
      isLive: Boolean(detail?.is_live || c.liveType === 'at-station' || c.liveType === 'upcoming' || c.liveType === 'departed'),
      delayMin: detail ? detail.delay_min : (c.delayMin ?? 0),
      boards: c.boards,
      detail,
    };
  });

  const body = {
    ok: true,
    source: 'railradar-v1',
    updatedAt: serverNowISO,
    anchors: boardsOk,
    totalDiscovered: trains.length,
    liveEnriched: liveMap.size,
    trains,
  };

  const resp = jsonResponse(body, 200, {
    'Cache-Control': 'public, max-age=300, s-maxage=300',
  });

  if (useCache) {
    try {
      await cache.put(cacheKey, resp.clone());
      const staleResp = jsonResponse(body, 200, {
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      });
      await cache.put(staleCacheKey, staleResp);
    } catch {}
  }
  return resp;
}
