/**
 * Vercel Serverless Proxy for Live Train Status (RailRadar API v1)
 * Edge-cached for 20 seconds, protects API key, and normalizes response shape
 * for RailRaksha's live-trains.js engine.
 */

export const config = {
  maxDuration: 15,
};

function normalizeRailRadarPayload(raw) {
  const d = raw?.data || raw;
  if (!d || typeof d !== 'object') return null;

  // RailRadar v1 shape: currentLocation / lastStation / stations list
  const stations = d.stations || d.route || d.stationList || [];
  let lastPassed = null;
  for (const st of stations) {
    const act = st.actualDeparture || st.actualDepartureTime || st.actDep || st.departedAt;
    if (act && act !== '--' && act !== '00:00') lastPassed = st;
  }

  const cur = d.currentLocation || d.currentStation || d.lastStation || lastPassed || {};
  const code = String(
    cur.stationCode || cur.code || cur.stnCode || d.currentStationCode || d.lastStationCode || ''
  ).toUpperCase();

  const delayMin = Number(
    d.delayMinutes ?? d.delayInMinutes ?? d.delay ?? cur.delayMinutes ?? cur.delay ?? 0
  );

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { train, date } = req.query;
  if (!train || !/^\d{4,5}$/.test(String(train))) {
    return res.status(400).json({ error: 'Valid 4 or 5 digit train number required' });
  }

  const apiKey = process.env.RAILRADAR_API_KEY || process.env.RAILRADAR_KEY;
  if (!apiKey) {
    return res.status(501).json({ error: 'Serverless live proxy not configured' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const qs = date && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? `?date=${encodeURIComponent(date)}` : '';
    const upstreamUrl = `https://api.railradar.in/v1/trains/${train}/live${qs}`;
    const response = await fetch(upstreamUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error ${response.status}` });
    }

    const raw = await response.json();
    const normalized = normalizeRailRadarPayload(raw);
    if (!normalized) {
      return res.status(422).json({ error: 'Unrecognized upstream train status payload' });
    }

    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10');
    return res.status(200).json(normalized);
  } catch {
    clearTimeout(timeout);
    return res.status(504).json({ error: 'Live status upstream timeout' });
  }
}
