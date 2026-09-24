/**
 * Vercel Serverless Proxy for Live Train Status (RailRadar API)
 * Edge-cached for 20 seconds, protects API key, and normalizes CORS.
 */

export const config = {
  maxDuration: 15,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { train } = req.query;
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
    const upstreamUrl = `https://api.railradar.in/v2/trains/${train}/status`;
    const response = await fetch(upstreamUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({ error: `Upstream error ${response.status}` });
    }

    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=10');
    return res.status(200).json(data);
  } catch {
    clearTimeout(timeout);
    return res.status(504).json({ error: 'Live status upstream timeout' });
  }
}
