/**
 * Cloudflare Pages Function — GET /api/live-status?train=12711
 * Proxies RailRadar v1 API and normalizes response for live-trains.js.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function normalizeRailRadarPayload(raw) {
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;
  const stations = d.stations || d.route || d.stationList || [];
  let lastPassed = null;
  for (const st of stations) {
    const act = st.actualDeparture || st.actualDepartureTime || st.actDep || st.departedAt;
    if (act && act !== '--' && act !== '00:00') lastPassed = st;
  }
  const cur = d.currentLocation || d.currentStation || d.lastStation || lastPassed || {};
  const code = String(cur.stationCode || cur.code || cur.stnCode || d.currentStationCode || d.lastStationCode || '').toUpperCase();
  const delayMin = Number(d.delayMinutes ?? d.delayInMinutes ?? d.delay ?? cur.delayMinutes ?? cur.delay ?? 0);
  const actualDep = cur.actualDeparture || cur.actualDepartureTime || cur.departureTime || null;
  const speed = Number(cur.speed ?? d.speed ?? NaN);
  if (!code) return null;
  return {
    last_station_code: code,
    delay_min: Number.isFinite(delayMin) ? delayMin : 0,
    actual_departure: actualDep,
    speed_kmh: Number.isFinite(speed) ? speed : null,
    updated_at: d.updatedAt || raw?.meta?.timestamp || new Date().toISOString(),
  };
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const train = url.searchParams.get('train');
  const date = url.searchParams.get('date');

  if (!train || !/^\d{4,5}$/.test(train)) {
    return new Response(JSON.stringify({ error: 'Valid 4 or 5 digit train number required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const apiKey = env.RAILRADAR_API_KEY || env.RAILRADAR_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Live status proxy not configured' }), {
      status: 501, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  try {
    const qs = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `?date=${encodeURIComponent(date)}` : '';
    const response = await fetch(`https://api.railradar.in/v1/trains/${train}/live${qs}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
    if (!response.ok) {
      return new Response(JSON.stringify({ error: `Upstream error ${response.status}` }), {
        status: response.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    const raw = await response.json();
    const normalized = normalizeRailRadarPayload(raw);
    if (!normalized) {
      return new Response(JSON.stringify({ error: 'Unrecognized upstream payload' }), {
        status: 422, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    return new Response(JSON.stringify(normalized), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=20',
        ...CORS_HEADERS,
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Live status upstream timeout' }), {
      status: 504, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}
