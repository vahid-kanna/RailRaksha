/**
 * Vercel Serverless Proxy for Bynara Router API
 * 
 * Handles CORS and keeps the API key secure on the server.
 * Browser calls: POST /api/chat
 * Server forwards to: https://router.bynara.id/v1/chat/completions
 */

// Vercel function timeout (hobby plan max: 60s)
export const config = {
  maxDuration: 60,
};

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

    // Try up to 3 times with exponential backoff
    const maxRetries = 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Timeout per attempt: 45s (leaves 15s buffer before Vercel kills us)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);

        const response = await fetch('https://router.bynara.id/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(req.body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const data = await response.json();

        if (!response.ok) {
          // Don't retry on auth/4xx errors — only retry on 5xx or timeouts
          if (response.status >= 400 && response.status < 500) {
            console.error(`Bynara API error ${response.status}:`, JSON.stringify(data).substring(0, 200));
            return res.status(response.status).json(data);
          }
          // 5xx — retryable
          console.warn(`Bynara returned ${response.status} (attempt ${attempt + 1}/${maxRetries})`);
          lastError = data;
        } else {
          return res.status(200).json(data);
        }
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') {
          console.warn(`Bynara request timed out (attempt ${attempt + 1}/${maxRetries})`);
          lastError = { error: { message: 'Upstream API timed out' } };
        } else {
          console.error(`Fetch error (attempt ${attempt + 1}):`, fetchErr.message);
          lastError = { error: { message: fetchErr.message } };
        }
      }

      // Wait before retry (2s, 5s, no wait on last attempt)
      if (attempt < maxRetries - 1) {
        const waitMs = attempt === 0 ? 2000 : 5000;
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    // All retries exhausted
    console.error('All retries exhausted for Bynara API');
    return res.status(504).json({
      error: {
        message: 'AI service is slow or unavailable. Please try again in a moment.',
        code: 'upstream_timeout'
      }
    });

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}
