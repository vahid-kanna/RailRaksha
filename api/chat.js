/**
 * Vercel Serverless Proxy for Bynara Router API
 * 
 * Handles CORS and keeps the API key secure on the server.
 * Browser calls: POST /api/chat
 * Server forwards to: https://router.bynara.id/v1/chat/completions
 */

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get API key from environment variable
    const apiKey = process.env.BYNARA_API_KEY;
    if (!apiKey) {
      console.error('BYNARA_API_KEY not set in environment');
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Forward request to Bynara
    const response = await fetch('https://router.bynara.id/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    // Stream the response back
    const data = await response.json();
    
    if (!response.ok) {
      console.error('Bynara API error:', data);
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
