/**
 * RailRaksha — Cloudflare Edge API Handlers v8.3 (worker/handlers.js)
 *
 * Pure Web-Standard Request/Response handlers shared by Cloudflare Workers
 * (worker/index.js) and Cloudflare Pages Functions (functions/api/*).
 *
 * Endpoints:
 *   GET  /api/health         -> Service & secret availability diagnostics
 *   POST /api/chat           -> Multi-provider AI proxy (Gemini -> Groq -> OpenRouter failover)
 *   GET  /api/corridor-live  -> Live-data-first BZA<->GDR corridor telemetry
 *                               (irctc.dev v1 -> RailCore v1 -> RailRadar v1 failover, KV + edge cached)
 *   GET  /api/live-status    -> Single-train live status (irctc.dev v1 -> RailCore v1 -> RailRadar v1)
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-IRCTC-Key, X-RailRadar-Key, X-RailCore-Key',
};

const LIVE_VARY_HEADERS = 'X-IRCTC-Key, X-RailRadar-Key, X-RailCore-Key';

// Corridor station chainage lookup (km from GDR=162 to BZA=445, matched to js/corridor.js)
const CORRIDOR_KM = {
  GDR: 162, NLR: 200, BVRT: 232, BTTR: 232, KVZ: 250, UPD: 265,
  INGR: 282, SKM: 293, TGU: 305, OGL: 321, ANB: 338, CL: 356,
  CLX: 356, BPP: 371, TEL: 414, BZA: 445,
};

const CORRIDOR_NAME_TO_CODE = {
  gudur: 'GDR',
  nellore: 'NLR',
  bitragunta: 'BVRT',
  kavali: 'KVZ',
  ulavapadu: 'UPD',
  inagallu: 'INGR',
  singarayakonda: 'SKM',
  tangutur: 'TGU',
  ongole: 'OGL',
  ammanabrolu: 'ANB',
  chirala: 'CL',
  bapatla: 'BPP',
  tenali: 'TEL',
  vijayawada: 'BZA',
};

const MONTHS_SHORT = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const IST_OFFSET_MS = 5.5 * 3600000;
const DAY_MS = 86400000;

const GEMINI_FALLBACK_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

const GROQ_VISION_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
];

const GROQ_FALLBACK_MODELS = [
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-3.3-70b-versatile',
];

const OPENROUTER_FALLBACK_MODELS = [
  'google/gemini-2.0-flash-001',
  'google/gemini-2.5-flash',
  'meta-llama/llama-4-scout',
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
 * Resolve ordered server-side AI provider chain from Cloudflare Worker secrets.
 * Priority: Custom AI_API_KEY -> Gemini -> Groq -> OpenRouter -> Bynara.
 */
export function resolveAIChain(env = {}) {
  const chain = [];
  if (env.AI_API_KEY) {
    chain.push({
      apiKey: env.AI_API_KEY,
      baseUrl: (env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
      defaultModel: env.AI_MODEL || GEMINI_FALLBACK_MODELS[0],
      fallbackModels: env.AI_MODEL ? [env.AI_MODEL] : GEMINI_FALLBACK_MODELS,
      visionModels: env.AI_MODEL ? [env.AI_MODEL] : GEMINI_FALLBACK_MODELS,
      name: 'custom',
    });
  }
  if (env.GEMINI_API_KEY) {
    const preferred = env.AI_MODEL && env.AI_MODEL !== 'auto'
      ? [env.AI_MODEL, ...GEMINI_FALLBACK_MODELS.filter(m => m !== env.AI_MODEL)]
      : GEMINI_FALLBACK_MODELS;
    chain.push({
      apiKey: env.GEMINI_API_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: preferred[0],
      fallbackModels: preferred,
      visionModels: preferred,
      name: 'gemini',
    });
  }
  if (env.GROQ_API_KEY) {
    const groqDefault = env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
    const textModels = [groqDefault, ...GROQ_FALLBACK_MODELS.filter(m => m !== groqDefault)];
    const visionModels = [groqDefault, ...GROQ_VISION_MODELS.filter(m => m !== groqDefault)]
      .filter(m => m !== 'llama-3.3-70b-versatile');
    chain.push({
      apiKey: env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: groqDefault,
      fallbackModels: textModels,
      visionModels: visionModels.length ? visionModels : GROQ_VISION_MODELS,
      name: 'groq',
    });
  }
  if (env.OPENROUTER_API_KEY) {
    const orDefault = env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
    const orModels = [orDefault, ...OPENROUTER_FALLBACK_MODELS.filter(m => m !== orDefault)];
    chain.push({
      apiKey: env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: orDefault,
      fallbackModels: orModels,
      visionModels: orModels,
      name: 'openrouter',
    });
  }
  if (env.BYNARA_API_KEY) {
    chain.push({
      apiKey: env.BYNARA_API_KEY,
      baseUrl: 'https://router.bynara.id/v1',
      defaultModel: env.AI_MODEL || 'agnes-2.5-flash',
      fallbackModels: [env.AI_MODEL || 'agnes-2.5-flash'],
      visionModels: [env.AI_MODEL || 'agnes-2.5-flash'],
      name: 'bynara',
    });
  }
  return chain;
}

/**
 * Resolve primary server-side AI provider from Cloudflare Worker secrets.
 */
export function resolveAIProvider(env = {}) {
  return resolveAIChain(env)[0] || null;
}

function stationCodeOf(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.trim().toUpperCase();
  if (typeof val === 'object') {
    return String(val.code || val.stationCode || val.station_code || '').trim().toUpperCase();
  }
  return '';
}

function resolveCorridorStationCode(val) {
  if (!val) return '';
  if (typeof val === 'object') {
    const direct = stationCodeOf(val);
    if (direct && CORRIDOR_KM[direct] != null) return direct;
    return resolveCorridorStationCode(val.stationName || val.station_name || val.name || direct);
  }
  const raw = String(val).trim();
  if (!raw) return '';

  const paren = raw.match(/\(([A-Za-z]{2,5})\)/);
  if (paren) {
    const pc = paren[1].toUpperCase();
    if (CORRIDOR_KM[pc] != null) return pc;
  }

  const upper = raw.toUpperCase();
  if (CORRIDOR_KM[upper] != null) return upper;

  const normalized = raw
    .toLowerCase()
    .replace(/\b(jn|junction|halt|station|terminus|trm|rs)\b/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();

  if (CORRIDOR_NAME_TO_CODE[normalized]) return CORRIDOR_NAME_TO_CODE[normalized];
  for (const [name, code] of Object.entries(CORRIDOR_NAME_TO_CODE)) {
    if (normalized.includes(name)) return code;
  }
  return '';
}

function getISTDateToday() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function formatISTIso(year, monthIdx, day, hh, mm) {
  const yyyy = String(year).padStart(4, '0');
  const mon = String(monthIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const hStr = String(hh).padStart(2, '0');
  const mStr = String(mm).padStart(2, '0');
  return `${yyyy}-${mon}-${dd}T${hStr}:${mStr}:00+05:30`;
}

/**
 * Convert an irctc.dev IST "HH:MM" or "HH:MM*" timestamp (with optional "24-Oct" date)
 * into a full ISO-8601 +05:30 timestamp anchored around `refMs`.
 */
function parseIrctcTimeToISO(rawTime, refMs = Date.now(), dateLabel = null) {
  if (!rawTime) return { iso: null, isEstimated: false };
  const s = String(rawTime).trim();
  if (!s) return { iso: null, isEstimated: false };

  const isEstimated = s.endsWith('*');
  const cleaned = s.replace(/\*+$/, '').trim();

  if (/^\d{4}-\d{2}-\d{2}T/.test(cleaned)) {
    return { iso: cleaned, isEstimated };
  }

  const hm = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!hm) return { iso: null, isEstimated };
  const hh = Number(hm[1]);
  const mm = Number(hm[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return { iso: null, isEstimated };
  }

  const baseMs = Number.isFinite(refMs) ? refMs : Date.now();
  const baseIST = new Date(baseMs + IST_OFFSET_MS);

  if (dateLabel) {
    const dm = String(dateLabel).trim().match(/^(\d{1,2})[\s-]+([A-Za-z]{3})/);
    if (dm) {
      const dNum = Number(dm[1]);
      const monIdx = MONTHS_SHORT[dm[2].toLowerCase()];
      if (dNum >= 1 && dNum <= 31 && monIdx != null) {
        const y0 = baseIST.getUTCFullYear();
        let bestIso = null;
        let bestDiff = Infinity;
        for (const yr of [y0 - 1, y0, y0 + 1]) {
          const iso = formatISTIso(yr, monIdx, dNum, hh, mm);
          const ms = Date.parse(iso);
          if (Number.isFinite(ms)) {
            const diff = Math.abs(ms - baseMs);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIso = iso;
            }
          }
        }
        if (bestIso) return { iso: bestIso, isEstimated };
      }
    }
  }

  let bestIso = null;
  let bestDiff = Infinity;
  for (const dayOffset of [-1, 0, 1]) {
    const dayDate = new Date(baseMs + IST_OFFSET_MS + dayOffset * DAY_MS);
    const iso = formatISTIso(
      dayDate.getUTCFullYear(),
      dayDate.getUTCMonth(),
      dayDate.getUTCDate(),
      hh,
      mm
    );
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      const diff = Math.abs(ms - baseMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIso = iso;
      }
    }
  }
  return { iso: bestIso, isEstimated };
}

/**
 * Infer direction (UP toward BZA, DN toward GDR) from a route/stops array.
 */
export function inferCorridorDirection(route = [], prevCode = '', nextCode = '') {
  const seen = [];
  for (const st of route) {
    const direct = stationCodeOf(st);
    const code = CORRIDOR_KM[direct] != null
      ? direct
      : resolveCorridorStationCode(st?.stationName || st?.station_name || st?.name || direct);
    if (CORRIDOR_KM[code] != null) seen.push(CORRIDOR_KM[code]);
  }
  if (seen.length >= 2 && seen[seen.length - 1] !== seen[0]) {
    return seen[seen.length - 1] > seen[0] ? 'UP' : 'DN';
  }
  const pCode = CORRIDOR_KM[String(prevCode || '').toUpperCase()] != null
    ? String(prevCode || '').toUpperCase()
    : resolveCorridorStationCode(prevCode);
  const nCode = CORRIDOR_KM[String(nextCode || '').toUpperCase()] != null
    ? String(nextCode || '').toUpperCase()
    : resolveCorridorStationCode(nextCode);
  const pKm = CORRIDOR_KM[pCode];
  const nKm = CORRIDOR_KM[nCode];
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

  const curRouteStop = route.find(s => String(s.stationCode || '').toUpperCase() === code) || lastPassed || {};
  const actualDep =
    curRouteStop.actualDeparture ||
    curRouteStop.actualArrival ||
    cur.actualDeparture ||
    cur.actualDepartureTime ||
    d.lastUpdatedAt ||
    null;

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
 * Normalize RailCore v1 `/v1/trains/{no}/live` response into RailRaksha telemetry shape.
 */
export function normalizeRailCorePayload(raw) {
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;

  const route = Array.isArray(d.stations) ? d.stations
    : Array.isArray(d.route) ? d.route
    : [];

  let lastPassed = null;
  for (const st of route) {
    const stStatus = String(st.status || '').toLowerCase();
    if (stStatus === 'departed' || stStatus === 'at-station' || st.actual_departure || st.actual_arrival) {
      lastPassed = st;
    }
  }

  const code = String(
    d.current_station_code || d.currentStationCode || lastPassed?.station_code || lastPassed?.stationCode || ''
  ).trim().toUpperCase();
  if (!code) return null;

  const curStop = route.find(s => stationCodeOf(s) === code) || lastPassed || {};
  const delayMin = Number(
    d.delay_minutes ?? d.delayMinutes ?? curStop.delay_departure_minutes ?? curStop.delay_arrival_minutes ?? 0
  );
  const statusStr = String(d.status || curStop.status || '').toLowerCase();
  const event = (statusStr.includes('at_station') || statusStr === 'at-station' || statusStr === 'halted' || statusStr === 'arrived')
    ? 'ARRIVED'
    : 'DEPARTED';

  const actualDep = curStop.actual_departure || curStop.actual_arrival || curStop.eta || null;
  const dir = inferCorridorDirection(route, code, d.next_station_code);

  const corridorStops = route
    .filter(s => CORRIDOR_KM[stationCodeOf(s)] != null)
    .map(s => {
      const c = stationCodeOf(s);
      return {
        code: c,
        km: CORRIDOR_KM[c],
        status: String(s.status || 'upcoming').toLowerCase(),
        schDep: s.scheduled_departure || s.scheduled_arrival || null,
        actDep: s.actual_departure || s.actual_arrival || s.eta || null,
        delay: Number(s.delay_departure_minutes ?? s.delay_arrival_minutes ?? delayMin) || 0,
        speedKmh: null,
      };
    });

  return {
    train_no: String(d.train_number || d.trainNumber || '').trim(),
    train_name: String(d.train_name || d.trainName || '').trim(),
    train_type: String(d.train_type || 'Express'),
    dir,
    status: statusStr || 'running',
    is_live: statusStr !== 'cancelled' && statusStr !== 'scheduled',
    last_station_code: code,
    last_station_name: String(curStop.station_name || curStop.stationName || code),
    next_halt_code: d.next_station_code ? String(d.next_station_code).toUpperCase() : null,
    next_halt_name: d.next_station_name || null,
    distance_from_last_km: 0,
    event,
    delay_min: Number.isFinite(delayMin) ? Math.round(delayMin) : 0,
    actual_departure: actualDep,
    speed_kmh: null,
    vmax_kmh: 110,
    updated_at: raw?.meta?.timestamp || new Date().toISOString(),
    corridor_stops: corridorStops,
  };
}

/**
 * Normalize irctc.dev `/api/v1/live/:trainNo` response into RailRaksha telemetry shape.
 */
export function normalizeIrctcDevPayload(raw) {
  if (raw?.success === false) return null;
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;

  const locStatus = String(d.locationStatus || d.status || '').toLowerCase();
  if (d.isCancelled === true || locStatus.includes('cancel')) return null;

  const rawStops = Array.isArray(d.stops) ? d.stops
    : Array.isArray(d.route) ? d.route
    : [];

  const updatedAt = d.updatedAt || d.lastUpdatedAt || raw?.queryTime || raw?.updatedAt || new Date().toISOString();
  const refMs = Date.parse(updatedAt) || Date.now();

  const resolvedStops = rawStops.map((s) => {
    const direct = stationCodeOf(s);
    const resolved = (direct && CORRIDOR_KM[direct] != null)
      ? direct
      : (resolveCorridorStationCode(s.stationName || s.station_name || s.name || direct) || direct);
    return { ...s, _code: resolved };
  });

  let currentStop = null;
  let lastPassed = null;
  for (let i = 0; i < resolvedStops.length; i++) {
    const st = resolvedStops[i];
    const stStatus = String(st.status || '').toLowerCase();
    if (stStatus === 'current' || stStatus === 'at-station') currentStop = { ...st, _idx: i };
    if (stStatus === 'passed' || stStatus === 'departed' || stStatus === 'current' || stStatus === 'at-station') {
      lastPassed = { ...st, _idx: i };
    }
  }

  const code =
    stationCodeOf(d.currentStationCode || d.currentLocationCode) ||
    resolveCorridorStationCode(d.currentLocation) ||
    currentStop?._code ||
    lastPassed?._code ||
    String(d.currentLocation || '').trim().toUpperCase();

  if (!code) return null;

  const curStop = resolvedStops.find(s => s._code === code) || currentStop || lastPassed || {};
  const curIdx = resolvedStops.indexOf(curStop);

  let nextStop = null;
  for (let i = Math.max(0, curIdx + 1); i < resolvedStops.length; i++) {
    if (String(resolvedStops[i].status || '').toLowerCase() === 'upcoming') {
      nextStop = resolvedStops[i];
      break;
    }
  }
  if (!nextStop) {
    nextStop = resolvedStops.find(s => String(s.status || '').toLowerCase() === 'upcoming') || null;
  }

  const isArrived = (
    locStatus.includes('arrived') ||
    locStatus.includes('halted') ||
    locStatus.includes('at station') ||
    locStatus === 'at' ||
    (locStatus.startsWith('at ') && !locStatus.includes('departed')) ||
    (String(curStop.status || '').toLowerCase() === 'current' && !curStop.departs && !locStatus.includes('departed'))
  );
  const event = isArrived ? 'ARRIVED' : 'DEPARTED';

  const delayMin = Number(d.currentDelayMin ?? d.delayMin ?? d.delayMinutes ?? curStop.delayMin ?? 0);
  const depSource = curStop.actualDeparture || curStop.actual_departure || d.actualDeparture || curStop.departs || curStop.arrives || null;
  const parsedDep = parseIrctcTimeToISO(depSource, refMs, curStop.date);
  const actualDep = parsedDep.iso || null;

  let dir = inferCorridorDirection(
    resolvedStops.map(s => ({ ...s, stationCode: s._code })),
    lastPassed?._code || code,
    nextStop?._code || ''
  );
  if (!dir && resolvedStops.length >= 2) {
    dir = inferDirectionFromEndpoints(
      resolvedStops[0]._code || resolvedStops[0].stationName,
      resolvedStops[resolvedStops.length - 1]._code || resolvedStops[resolvedStops.length - 1].stationName
    );
  }
  if (!dir && (d.source || d.destination)) {
    dir = inferDirectionFromEndpoints(d.source, d.destination);
  }

  const corridorStops = resolvedStops
    .filter(s => CORRIDOR_KM[s._code] != null)
    .map(s => {
      const sStatus = String(s.status || 'upcoming').toLowerCase();
      const normStatus = sStatus === 'passed' ? 'departed'
        : sStatus === 'current' ? 'at-station'
        : sStatus;
      const timeIso = parseIrctcTimeToISO(s.departs || s.arrives, refMs, s.date).iso;
      return {
        code: s._code,
        km: CORRIDOR_KM[s._code],
        status: normStatus,
        schDep: timeIso,
        actDep: (sStatus === 'passed' || sStatus === 'departed' || sStatus === 'current') ? timeIso : null,
        delay: Number(s.delayMin ?? delayMin) || 0,
        speedKmh: null,
      };
    });

  const speed = Number(d.speedKmh ?? d.speed ?? NaN);
  const isLive = locStatus !== 'scheduled' && locStatus !== 'not started' && (
    resolvedStops.some(s => ['passed', 'departed', 'current', 'at-station'].includes(String(s.status || '').toLowerCase())) ||
    Boolean(d.currentLocation)
  );

  return {
    train_no: String(d.trainNumber || d.trainNo || '').trim(),
    train_name: String(d.trainName || '').trim(),
    train_type: String(d.trainType || 'Express'),
    dir,
    status: d.locationStatus ? String(d.locationStatus).trim() : 'running',
    is_live: isLive,
    last_station_code: code,
    last_station_name: String(curStop.stationName || d.currentLocation || code),
    next_halt_code: nextStop?._code || null,
    next_halt_name: nextStop?.stationName || null,
    distance_from_last_km: 0,
    event,
    delay_min: Number.isFinite(delayMin) ? Math.round(delayMin) : 0,
    actual_departure: actualDep,
    speed_kmh: Number.isFinite(speed) && speed > 0 && speed <= 160 ? Math.round(speed) : null,
    vmax_kmh: 110,
    updated_at: updatedAt,
    corridor_stops: corridorStops,
  };
}

function resolveIrctcDevKey(request, env = {}) {
  const headerKey = request?.headers?.get?.('X-IRCTC-Key')?.trim();
  if (headerKey) return headerKey;
  return env.IRCTC_DEV_API_KEY || env.IRCTC_API_KEY || env.IRCTC_KEY || '';
}

function resolveRailRadarKey(request, env = {}) {
  const headerKey = request?.headers?.get?.('X-RailRadar-Key')?.trim();
  if (headerKey) return headerKey;
  return env.RAILRADAR_API_KEY || env.RAILRADAR_KEY || '';
}

function resolveRailCoreKey(request, env = {}) {
  const headerKey = request?.headers?.get?.('X-RailCore-Key')?.trim();
  if (headerKey) return headerKey;
  return env.RAILCORE_API_KEY || env.RAILCORE_KEY || '';
}

/**
 * Build live provider attempt chain.
 * Explicit personal request headers always run first (X-IRCTC-Key -> X-RailCore-Key -> X-RailRadar-Key),
 * followed by remaining server-configured keys in free-tier resilience order:
 * irctcdev (10k free) -> railcore (500/mo free) -> railradar (100/mo free).
 */
function buildLiveProviderOrder(request, env = {}) {
  const headerIRCTC = request?.headers?.get?.('X-IRCTC-Key')?.trim() || '';
  const headerRC = request?.headers?.get?.('X-RailCore-Key')?.trim() || '';
  const headerRR = request?.headers?.get?.('X-RailRadar-Key')?.trim() || '';

  const irctcKey = resolveIrctcDevKey(request, env);
  const rcKey = resolveRailCoreKey(request, env);
  const rrKey = resolveRailRadarKey(request, env);

  const attempts = [];
  const seen = new Set();
  const push = (provider, key) => {
    if (!key || seen.has(provider)) return;
    seen.add(provider);
    attempts.push([provider, key]);
  };

  if (headerIRCTC) push('irctcdev', headerIRCTC);
  if (headerRC) push('railcore', headerRC);
  if (headerRR) push('railradar', headerRR);

  push('irctcdev', irctcKey);
  push('railcore', rcKey);
  push('railradar', rrKey);

  return { attempts, hasHeaderOverride: Boolean(headerIRCTC || headerRC || headerRR), headerIRCTC, headerRC, headerRR };
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
  const hasIrctcDev = Boolean(env.IRCTC_DEV_API_KEY || env.IRCTC_API_KEY || env.IRCTC_KEY);
  const hasRailCore = Boolean(env.RAILCORE_API_KEY || env.RAILCORE_KEY);
  const hasRailRadar = Boolean(env.RAILRADAR_API_KEY || env.RAILRADAR_KEY);

  let liveProvider;
  if (hasIrctcDev) {
    if (hasRailCore && hasRailRadar) liveProvider = 'irctc.dev+railcore+railradar';
    else if (hasRailCore) liveProvider = 'irctc.dev+railcore';
    else if (hasRailRadar) liveProvider = 'irctc.dev+railradar';
    else liveProvider = 'irctc.dev-v1-corridor-live';
  } else if (hasRailRadar && hasRailCore) {
    liveProvider = 'railradar+railcore';
  } else if (hasRailRadar) {
    liveProvider = 'railradar-v1-corridor-live';
  } else if (hasRailCore) {
    liveProvider = 'railcore-v1-corridor-live';
  } else {
    liveProvider = 'schedule-offline';
  }

  return jsonResponse({
    status: 'ok',
    version: '8.3',
    host: 'cloudflare',
    timestamp: new Date().toISOString(),
    services: {
      ai: {
        configured: Boolean(ai),
        provider: ai ? ai.name : null,
        model: ai ? ai.defaultModel : null,
      },
      liveTrains: {
        configured: hasIrctcDev || hasRailCore || hasRailRadar,
        provider: liveProvider,
        irctcDevConfigured: hasIrctcDev,
        railcoreConfigured: hasRailCore,
        railradarConfigured: hasRailRadar,
      },
      weather: {
        configured: true,
        provider: 'open-meteo',
      },
    },
  }, 200, { 'Cache-Control': 'no-store' });
}

function requestHasImageContent(messages = []) {
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    if (m.content.some(part => part?.type === 'image_url' || part?.image_url)) return true;
  }
  return false;
}

function modelCompatibleWithProvider(providerName, requestedModel) {
  if (!requestedModel) return false;
  if (providerName === 'custom') return true;
  if (providerName === 'gemini') return requestedModel.startsWith('gemini');
  if (providerName === 'openrouter') return requestedModel.includes('/');
  if (providerName === 'groq') return !requestedModel.startsWith('gemini') && !requestedModel.includes('/');
  return false;
}

/**
 * POST /api/chat — Multi-provider AI proxy (Gemini -> Groq -> OpenRouter model & provider failover)
 */
export async function handleChat(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed', code: 'method_not_allowed' } }, 405);
  }

  const providers = resolveAIChain(env);
  if (providers.length === 0) {
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

  const hasImage = requestHasImageContent(body.messages);
  const requestedModel = body.model && body.model !== 'auto' && body.model !== 'agnes-2.5-flash' && body.model !== 'gemini-2.5-flash'
    ? String(body.model).trim()
    : null;

  let lastStatus = 504;
  let lastText = JSON.stringify({ error: { message: 'Upstream AI request failed', code: 'upstream_error' } });

  for (let pIdx = 0; pIdx < providers.length; pIdx++) {
    const provider = providers[pIdx];
    const isLastProvider = pIdx === providers.length - 1;
    const baseModels = hasImage && provider.visionModels?.length
      ? provider.visionModels
      : provider.fallbackModels;
    const modelsToTry = modelCompatibleWithProvider(provider.name, requestedModel)
      ? [requestedModel, ...baseModels.filter(m => m !== requestedModel)]
      : baseModels;

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
              'X-RailRaksha-Provider': provider.name,
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
        // Auth/client error on current provider: break to try next configured provider if available
        if (!isLastProvider && (upstream.status === 401 || upstream.status === 403 || upstream.status === 402)) {
          break;
        }
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
  }

  return new Response(lastText, {
    status: lastStatus,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function fetchSingleTrainLive(train, date, provider, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    let url;
    let headers;
    if (provider === 'irctcdev') {
      const effectiveDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getISTDateToday();
      url = `https://api.irctc.dev/api/v1/live/${train}?date=${encodeURIComponent(effectiveDate)}`;
      headers = { 'x-api-key': key, 'Accept': 'application/json' };
    } else if (provider === 'railcore') {
      const effectiveDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : getISTDateToday();
      url = `https://ir.railcore.tech/v1/trains/${train}/live?date=${encodeURIComponent(effectiveDate)}`;
      headers = { 'X-RailCore-Key': key, 'Accept': 'application/json' };
    } else {
      const qs = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `?date=${encodeURIComponent(date)}` : '';
      url = `https://api.railradar.in/v1/trains/${train}/live${qs}`;
      headers = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };
    }

    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);

    if (!response.ok) {
      const mappedStatus = response.status === 402 ? 429 : response.status;
      return { ok: false, status: mappedStatus, error: `Upstream ${provider} error ${response.status}` };
    }
    const raw = await response.json();
    if (raw?.success === false) {
      const code = String(raw?.code || raw?.error?.code || '').toUpperCase();
      const isQuota = code.includes('CREDIT') || code.includes('RATE_LIMIT') || code.includes('QUOTA');
      return { ok: false, status: isQuota ? 429 : 422, error: raw?.error?.message || raw?.error || `${provider} returned failure` };
    }
    const normalized = provider === 'irctcdev'
      ? normalizeIrctcDevPayload(raw)
      : provider === 'railcore'
      ? normalizeRailCorePayload(raw)
      : normalizeRailRadarPayload(raw);
    if (!normalized) {
      return { ok: false, status: 422, error: 'Train not currently reporting live location' };
    }
    normalized.provider = `${provider}-v1`;
    return { ok: true, data: normalized };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 504,
      error: err?.name === 'AbortError' ? 'Live status upstream timeout' : 'Live status upstream error',
    };
  }
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

  const { attempts } = buildLiveProviderOrder(request, env);
  if (attempts.length === 0) {
    return jsonResponse({ error: 'Live train feed key not configured on server' }, 501);
  }

  let lastErr = { status: 502, error: 'Unable to fetch live train status' };
  for (const [provider, key] of attempts) {
    const res = await fetchSingleTrainLive(train, date, provider, key);
    if (res.ok) {
      return jsonResponse(res.data, 200, {
        'Cache-Control': 'no-cache, s-maxage=25, must-revalidate',
        'CDN-Cache-Control': 'public, max-age=25',
        'Vary': LIVE_VARY_HEADERS,
      });
    }
    lastErr = res;
    if (res.status === 422 && attempts.length === 1) break;
  }

  return jsonResponse({ error: lastErr.error }, lastErr.status || 502, {
    'Cache-Control': 'no-store',
  });
}

/**
 * Infer UP (toward BZA / North) vs DN (toward GDR / South) from origin/destination codes
 * when a train only appears on one corridor station board.
 */
const SOUTH_HUBS = new Set([
  'GDR','MAS','MS','MSB','TBM','CGL','TPTY','RU','SBC','SMVB','YPR','KSR','CBE','ED','SA',
  'MDU','TPJ','CAPE','NCJ','TVC','ERS','ALLP','CLT','MAQ','MAJN','PDY','VM','TCNR','TEN',
  'KPD','JTJ','BNC','MYS','PGT','QLN','RMM','DMM','ATP','GTL','KJM','AJJ','PER','SPE','NYP',
  'TADA','GPD','PON','ENR','VLR','MV','TJ','KRR','DG','TCR','SRR','KTYM','KYJ','CAN','BWT',
]);
const NORTH_HUBS = new Set([
  'BZA','SC','HYB','LPI','CHZ','KCG','KZJ','WL','VSKP','VZM','CCT','RJY','EE','GNT',
  'NS','MTM','COA','SLO','TUNI','AKP','DVD','CHE','PSA','BAM','KUR','HWH','SHM','SRC',
  'BBS','PURI','CTC','BHC','BLS','KGP','SBP','HTE','DHN','TATA','JSME','PNBE','DNR','BJU',
  'GHY','SCL','DBRG','NDLS','NZM','DLI','ANVT','CNB','LKO','BSB','PRYJ','JBP','NGP','BPL',
  'INDB','ADI','ST','LTT','CSMT','PUNE','BSP','R','DURG','KRBA','RNC','ASN','MFP','DBG',
  'JYG','AADR','CDG','ASR','JAT','SVDK','YNRK','GKP','BVRM','GDV','NRT',
]);

export function inferDirectionFromEndpoints(source, destination) {
  const s = CORRIDOR_KM[String(source || '').toUpperCase()] != null
    ? String(source || '').toUpperCase()
    : (resolveCorridorStationCode(source) || String(source || '').toUpperCase());
  const d = CORRIDOR_KM[String(destination || '').toUpperCase()] != null
    ? String(destination || '').toUpperCase()
    : (resolveCorridorStationCode(destination) || String(destination || '').toUpperCase());

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
 * Normalize a single station board entry across irctc.dev, RailCore v1, and RailRadar v1.
 */
export function normalizeBoardItem(provider, item, refNowMs = Date.now()) {
  if (!item || typeof item !== 'object') return null;

  if (provider === 'irctcdev') {
    const no = String(item.trainNo || item.trainNumber || item.train_number || '').trim();
    if (!/^\d{4,5}$/.test(no)) return null;

    const itemStatus = String(item.status || '').trim().toUpperCase();
    const arrStatus = String(item.arrival?.status || '').trim().toUpperCase();
    const depStatus = String(item.departure?.status || '').trim().toUpperCase();
    if (
      item.isCancelled === true ||
      itemStatus.includes('CANCEL') ||
      arrStatus.includes('CANCEL') ||
      depStatus.includes('CANCEL')
    ) {
      return null;
    }

    let source = stationCodeOf(item.source || item.sourceStationCode || item.source_station_code);
    let destination = stationCodeOf(item.destination || item.destinationStationCode || item.destination_station_code);
    if ((!source || !destination) && typeof item.route === 'string' && item.route.includes('-')) {
      const parts = item.route.split('-').map(p => p.trim().toUpperCase()).filter(Boolean);
      if (parts.length >= 2) {
        if (!source) source = parts[0];
        if (!destination) destination = parts[parts.length - 1];
      }
    }

    const delayRaw = item.departure?.delayMinutes ?? item.arrival?.delayMinutes ?? item.delayMinutes ?? item.currentDelayMin ?? null;
    const delayMinutes = delayRaw != null && Number.isFinite(Number(delayRaw)) ? Number(delayRaw) : null;

    const nowMs = Number.isFinite(refNowMs) ? refNowMs : Date.now();
    const arrRaw = item.arrival?.actualOrEstimated || item.arrival?.actual || item.arrival?.estimated || item.arrival?.scheduled || null;
    const depRaw = item.departure?.actualOrEstimated || item.departure?.actual || item.departure?.estimated || item.departure?.scheduled || null;

    const arrParsed = parseIrctcTimeToISO(arrRaw, nowMs);
    const depParsed = parseIrctcTimeToISO(depRaw, nowMs);
    const arrMs = arrParsed.iso ? Date.parse(arrParsed.iso) : NaN;
    const depMs = depParsed.iso ? Date.parse(depParsed.iso) : NaN;

    const explicitDeparted = itemStatus === 'DEPARTED' || depStatus === 'DEPARTED' || Boolean(item.departedAt || item.actualDeparture);
    const explicitAtStation = itemStatus === 'AT_STATION' || itemStatus === 'AT-STATION' || itemStatus === 'ARRIVED' || arrStatus === 'ARRIVED' || arrStatus === 'AT STATION';
    const inferredDeparted = !depParsed.isEstimated && Number.isFinite(depMs) && depMs <= nowMs + 60000 && !item.departure?.isDestination;
    const inferredAtStation = !arrParsed.isEstimated && Number.isFinite(arrMs) && arrMs <= nowMs + 60000 && (depParsed.isEstimated || !Number.isFinite(depMs) || depMs > nowMs);

    let liveType = 'scheduled';
    let departedAt = null;
    if (explicitDeparted || inferredDeparted) {
      liveType = 'departed';
      departedAt = item.departedAt
        ? parseIrctcTimeToISO(item.departedAt, nowMs).iso
        : (item.actualDeparture
          ? parseIrctcTimeToISO(item.actualDeparture, nowMs).iso
          : (depParsed.iso || arrParsed.iso || null));
    } else if (explicitAtStation || inferredAtStation) {
      liveType = 'at-station';
    } else if (itemStatus.includes('NOT_STARTED') || itemStatus.includes('NOT STARTED') || arrStatus.includes('NOT STARTED')) {
      liveType = 'not-started';
    } else if (arrParsed.iso || depParsed.iso || delayMinutes != null || arrStatus || depStatus) {
      liveType = 'upcoming';
    }

    const platform = typeof item.platform === 'object'
      ? (item.platform?.number ?? null)
      : (item.platform || null);

    return {
      no,
      name: String(item.trainName || item.train_name || `Train ${no}`).trim(),
      type: String(item.trainType || item.train_type || 'Express').trim(),
      source,
      destination,
      liveType,
      delayMinutes,
      board: {
        type: liveType,
        expectedArrival: arrParsed.iso,
        expectedDeparture: depParsed.iso,
        departedAt,
        delayMinutes,
        platform,
      },
    };
  }

  if (provider === 'railcore') {
    const no = String(item.train_number || item.trainNumber || '').trim();
    if (!/^\d{4,5}$/.test(no)) return null;
    const rawStatus = String(item.status || '').toUpperCase();
    if (rawStatus === 'CANCELLED') return null;

    const basis = String(item.timing_basis || '').toLowerCase();
    let liveType = 'scheduled';
    if (rawStatus.includes('AT_STATION') || rawStatus === 'ARRIVED') liveType = 'at-station';
    else if (rawStatus === 'DEPARTED') liveType = 'departed';
    else if (rawStatus === 'NOT_STARTED') liveType = 'not-started';
    else if (basis === 'live' || rawStatus === 'RUNNING' || rawStatus === 'UPCOMING') liveType = 'upcoming';

    const delayRaw = item.departure_delay_minutes ?? item.arrival_delay_minutes ?? item.delay_minutes ?? null;
    const delayMinutes = delayRaw != null && Number.isFinite(Number(delayRaw)) ? Number(delayRaw) : null;

    return {
      no,
      name: item.train_name || item.extended_train_name || `Train ${no}`,
      type: item.train_type || 'Express',
      source: stationCodeOf(item.source_station_code || item.source),
      destination: stationCodeOf(item.destination_station_code || item.destination),
      liveType,
      delayMinutes,
      board: {
        type: liveType,
        expectedArrival: item.estimated_arrival || item.scheduled_arrival || item.eta || null,
        expectedDeparture: item.estimated_departure || item.scheduled_departure || null,
        departedAt: item.actual_departure || null,
        delayMinutes,
        platform: item.platform_number || null,
      },
    };
  }

  const no = String(item.train?.number || '').trim();
  if (!/^\d{4,5}$/.test(no)) return null;
  const liveType = String(item.live?.type || 'scheduled').toLowerCase();
  if (liveType === 'cancelled') return null;
  const delayRaw = item.live?.delayMinutes;
  const delayMinutes = delayRaw != null && Number.isFinite(Number(delayRaw)) ? Number(delayRaw) : null;

  return {
    no,
    name: item.train?.name || `Train ${no}`,
    type: item.train?.type || 'Express',
    source: stationCodeOf(item.train?.source),
    destination: stationCodeOf(item.train?.destination),
    liveType,
    delayMinutes,
    board: {
      type: liveType,
      expectedArrival: item.live?.expectedArrivalTime || null,
      expectedDeparture: item.live?.expectedDepartureTime || null,
      departedAt: item.live?.departedAt || null,
      delayMinutes,
      platform: item.stop?.platform || null,
    },
  };
}

async function fetchCorridorBoards(provider, key, anchors) {
  const headers = provider === 'irctcdev'
    ? { 'x-api-key': key, 'Accept': 'application/json' }
    : provider === 'railcore'
    ? { 'X-RailCore-Key': key, 'Accept': 'application/json' }
    : { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' };

  const boardResults = await Promise.allSettled(
    anchors.map(async (stn) => {
      const url = provider === 'irctcdev'
        ? `https://api.irctc.dev/api/v1/live/station/${stn}?hours=8`
        : provider === 'railcore'
        ? `https://ir.railcore.tech/v1/stations/${stn}/live?window_hours=6`
        : `https://api.railradar.in/v1/stations/${stn}/live?hours=6&includeIntermediate=true`;
      const resp = await fetch(url, {
        headers,
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
        err.isQuota = (
          resp.status === 429 ||
          resp.status === 402 ||
          errCode.includes('quota') ||
          errCode.includes('rate_limit') ||
          errCode.includes('credit')
        );
        throw err;
      }
      const json = await resp.json();
      if (json?.success === false) {
        const errCode = String(json?.error?.code || json?.code || '').toLowerCase();
        const msg = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : `${provider} live board error`);
        const err = new Error(`${stn}: ${msg}`);
        err.status = 429;
        err.isQuota = errCode.includes('quota') || errCode.includes('rate') || errCode.includes('limit') || errCode.includes('credit');
        throw err;
      }
      const trains = Array.isArray(json?.data?.trains) ? json.data.trains
        : Array.isArray(json?.trains) ? json.trains
        : [];
      const timestamp = json?.meta?.timestamp || json?.queryTime || null;
      return { stn, trains, timestamp };
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
      if (reason?.isQuota || reason?.status === 429 || reason?.status === 402 || /\b(429|402)\b/.test(String(reason?.message || ''))) {
        any429 = true;
      }
      if (!firstErrMsg && reason?.message) firstErrMsg = reason.message;
      continue;
    }
    boardsOk.push(res.value.stn);
    if (res.value.timestamp) serverNowISO = res.value.timestamp;
    const boardRefMs = Date.parse(res.value.timestamp || serverNowISO) || Date.now();

    for (const rawItem of res.value.trains) {
      const norm = normalizeBoardItem(provider, rawItem, boardRefMs);
      if (!norm) continue;
      const existing = byTrain.get(norm.no) || {
        no: norm.no,
        name: norm.name,
        type: norm.type,
        source: norm.source,
        destination: norm.destination,
        boards: {},
        liveType: 'scheduled',
        delayMin: null,
        priority: 0,
      };
      existing.boards[res.value.stn] = norm.board;
      if (!existing.source && norm.source) existing.source = norm.source;
      if (!existing.destination && norm.destination) existing.destination = norm.destination;

      const prio = norm.liveType === 'at-station' ? 4
        : (norm.liveType === 'upcoming' || norm.liveType === 'departed') ? 3
        : (norm.delayMinutes != null ? 2 : 1);
      if (prio > existing.priority) {
        existing.priority = prio;
        existing.liveType = norm.liveType;
      }
      if (norm.delayMinutes != null) {
        existing.delayMin = norm.delayMinutes;
      }
      byTrain.set(norm.no, existing);
    }
  }

  return { provider, key, byTrain, boardsOk, any429, firstErrMsg, serverNowISO };
}

async function kvReadJson(kv, key) {
  if (!kv || typeof kv.get !== 'function') return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function kvWriteJson(kv, key, data, ttlSeconds) {
  if (!kv || typeof kv.put !== 'function') return;
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: Math.max(60, ttlSeconds) });
  } catch {}
}

/**
 * GET /api/corridor-live
 *
 * Live-Data-First Corridor Aggregator (quota-safe + global KV cache):
 *   - Default: queries OGL (km 321) and NLR (km 200) live station boards (2 upstream calls)
 *   - Optional `?scope=skm`: queries ONLY SKM (km 293) board (1 upstream call)
 *   - Optional `?quota_saver=1`: queries 1 anchor (`SKM` if scope=skm else `OGL`) & caches 600s
 *   - Optional `?enrich=1`: enriches at most 1 closest active train via provider live train endpoint
 *   - Supports personal override headers (`X-IRCTC-Key`, `X-RailCore-Key`, `X-RailRadar-Key`)
 *   - Shared Cloudflare KV cache (`env.CORRIDOR_KV` when bound) + `caches.default` + 1-hour stale fallback
 *   - Returns HTTP 200 `{ ok: false, quotaExceeded, stale, source: 'schedule-fallback', trains }` on 429/unreachable
 */
export async function handleCorridorLive(request, env = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { attempts: providerOrder, headerIRCTC, headerRC, headerRR } = buildLiveProviderOrder(request, env);
  if (providerOrder.length === 0) {
    return jsonResponse({ error: 'Live train API key not configured' }, 501);
  }

  const url = new URL(request.url);
  const bypassCache = url.searchParams.get('fresh') === '1';
  const scope = (url.searchParams.get('scope') || '').toLowerCase();
  const quotaSaver = url.searchParams.get('quota_saver') === '1';
  const wantEnrich = url.searchParams.get('enrich') === '1';

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const kv = env.CORRIDOR_KV && typeof env.CORRIDOR_KV.get === 'function' ? env.CORRIDOR_KV : null;

  const headerComposite = (headerIRCTC || headerRC || headerRR)
    ? `${headerIRCTC}|${headerRC}|${headerRR}`
    : '';
  const keyTag = headerComposite ? await shortKeyTag(headerComposite) : '';
  const useEdgeCache = Boolean(cache && (!headerComposite || keyTag));
  const useKV = Boolean(kv && (!headerComposite || keyTag));

  const qsParts = [];
  if (scope === 'skm') qsParts.push('scope=skm');
  if (quotaSaver && scope !== 'skm') qsParts.push('quota_saver=1');
  if (keyTag) qsParts.push(`k=${keyTag}`);
  const cacheQs = qsParts.length ? `?${qsParts.join('&')}` : '';

  const cacheKey = new Request(`${url.origin}/api/corridor-live${cacheQs}`, { method: 'GET' });
  const staleCacheKey = new Request(`${url.origin}/api/corridor-live/__stale${cacheQs}`, { method: 'GET' });

  const kvSuffix = `${scope === 'skm' ? 'skm' : 'default'}:${quotaSaver ? 'qs1' : 'qs0'}:${keyTag || 'env'}`;
  const kvCacheKey = `corridor-live:${kvSuffix}`;
  const kvStaleKey = `corridor-live-stale:${kvSuffix}`;
  const freshTtl = quotaSaver ? 600 : 300;

  if (!bypassCache && !wantEnrich) {
    if (useEdgeCache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('Cache-Control', `no-cache, s-maxage=${freshTtl}, must-revalidate`);
        headers.set('CDN-Cache-Control', `public, max-age=${freshTtl}`);
        headers.set('Vary', LIVE_VARY_HEADERS);
        return new Response(cached.body, { status: cached.status, headers });
      }
    }
    if (useKV) {
      const kvHit = await kvReadJson(kv, kvCacheKey);
      if (kvHit && Array.isArray(kvHit.trains)) {
        const kvTtl = kvHit.ok === false ? 180 : freshTtl;
        if (useEdgeCache) {
          try {
            await cache.put(cacheKey, jsonResponse(kvHit, 200, { 'Cache-Control': `public, max-age=${kvTtl}, s-maxage=${kvTtl}` }));
          } catch {}
        }
        return jsonResponse(kvHit, 200, {
          'Cache-Control': `no-cache, s-maxage=${kvTtl}, must-revalidate`,
          'CDN-Cache-Control': `public, max-age=${kvTtl}`,
          'Vary': LIVE_VARY_HEADERS,
          'X-Cache': 'KV-HIT',
        });
      }
    }
  }

  const anchors = scope === 'skm'
    ? ['SKM']
    : quotaSaver
    ? ['OGL']
    : ['OGL', 'NLR'];

  let winning = null;
  let any429 = false;
  let firstErrMsg = '';

  for (const [provider, key] of providerOrder) {
    const attempt = await fetchCorridorBoards(provider, key, anchors);
    if (attempt.any429) any429 = true;
    if (!firstErrMsg && attempt.firstErrMsg) firstErrMsg = attempt.firstErrMsg;
    if (attempt.boardsOk.length > 0) {
      winning = attempt;
      break;
    }
  }

  if (!winning) {
    let staleData = null;
    if (useEdgeCache) {
      const staleCandidates = [staleCacheKey];
      if (scope === 'skm' || quotaSaver) {
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
    if (!staleData && useKV) {
      const kvCandidates = [kvStaleKey];
      if (scope === 'skm' || quotaSaver) {
        kvCandidates.push(`corridor-live-stale:default:qs0:${keyTag || 'env'}`);
      }
      for (const kKey of kvCandidates) {
        const parsed = await kvReadJson(kv, kKey);
        if (parsed && Array.isArray(parsed.trains) && parsed.trains.length > 0) {
          staleData = parsed;
          break;
        }
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
        ? 'Live train API quota exceeded (429) — schedule fallback active'
        : (firstErrMsg || 'Unable to reach live station boards'),
    };

    const fallbackResp = jsonResponse(fallbackBody, 200, {
      'Cache-Control': any429 ? 'no-cache, s-maxage=180, must-revalidate' : 'no-store',
      'CDN-Cache-Control': any429 ? 'public, max-age=180' : 'no-store',
      'Vary': LIVE_VARY_HEADERS,
    });
    if (any429) {
      if (useEdgeCache) {
        try {
          const edgeCopy = jsonResponse(fallbackBody, 200, { 'Cache-Control': 'public, max-age=180, s-maxage=180' });
          await cache.put(cacheKey, edgeCopy);
        } catch {}
      }
      if (useKV) {
        await kvWriteJson(kv, kvCacheKey, fallbackBody, 180);
      }
    }
    return fallbackResp;
  }

  const { provider: providerUsed, key: activeKey, byTrain, boardsOk, serverNowISO } = winning;

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
        const res = await fetchSingleTrainLive(c.no, null, providerUsed, activeKey);
        return res.ok ? res.data : null;
      })
    );

    for (const res of enriched) {
      if (res.status === 'fulfilled' && res.value && res.value.train_no && res.value.status !== 'cancelled') {
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
      for (const [code, b] of Object.entries(c.boards)) {
        if (CORRIDOR_KM[code] == null || !b) continue;
        const rawTime = b.type === 'departed' && b.departedAt
          ? b.departedAt
          : (b.expectedArrival || b.expectedDeparture || '');
        const t = Date.parse(rawTime);
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
    source: `${providerUsed}-v1`,
    updatedAt: serverNowISO,
    anchors: boardsOk,
    quotaSaver,
    totalDiscovered: trains.length,
    liveEnriched: liveMap.size,
    trains,
  };

  const resp = jsonResponse(body, 200, {
    'Cache-Control': `no-cache, s-maxage=${freshTtl}, must-revalidate`,
    'CDN-Cache-Control': `public, max-age=${freshTtl}`,
    'Vary': LIVE_VARY_HEADERS,
  });

  if (useEdgeCache) {
    try {
      const edgeCopy = jsonResponse(body, 200, { 'Cache-Control': `public, max-age=${freshTtl}, s-maxage=${freshTtl}` });
      await cache.put(cacheKey, edgeCopy);
      const staleResp = jsonResponse(body, 200, { 'Cache-Control': 'public, max-age=3600, s-maxage=3600' });
      await cache.put(staleCacheKey, staleResp);
    } catch {}
  }
  if (useKV) {
    await kvWriteJson(kv, kvCacheKey, body, freshTtl);
    await kvWriteJson(kv, kvStaleKey, body, 3600);
  }
  return resp;
}
