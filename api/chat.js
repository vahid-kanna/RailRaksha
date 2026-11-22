/**
 * Vercel Serverless Proxy for AI Chat & Vision Completions
 *
 * Keeps API keys strictly server-side and normalizes CORS.
 * Supports any OpenAI-compatible provider via environment variables:
 *   Priority:
 *     1. AI_API_KEY (+ optional AI_BASE_URL, AI_MODEL)
 *     2. GEMINI_API_KEY (Google AI Studio OpenAI-compatible endpoint)
 *     3. OPENROUTER_API_KEY
 *     4. GROQ_API_KEY
 *     5. BYNARA_API_KEY
 */

export const config = {
  maxDuration: 60,
};

function resolveProvider() {
  if (process.env.AI_API_KEY) {
    return {
      apiKey: process.env.AI_API_KEY,
      baseUrl: (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''),
      defaultModel: process.env.AI_MODEL || 'gemini-2.5-flash',
      name: 'custom',
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      apiKey: process.env.GEMINI_API_KEY,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      defaultModel: process.env.AI_MODEL || 'gemini-2.5-flash',
      name: 'gemini',
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: process.env.AI_MODEL || 'google/gemini-2.0-flash-001',
      name: 'openrouter',
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      apiKey: process.env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: process.env.AI_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
      name: 'groq',
    };
  }
  if (process.env.BYNARA_API_KEY) {
    return {
      apiKey: process.env.BYNARA_API_KEY,
      baseUrl: 'https://router.bynara.id/v1',
      defaultModel: process.env.AI_MODEL || 'glm-5.3-flash',
      name: 'bynara',
    };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  const provider = resolveProvider();
  if (!provider) {
    return res.status(503).json({
      error: {
        message: 'Server AI provider is not configured. Add GEMINI_API_KEY (or AI_API_KEY) in hosting environment variables, or set a custom key in Settings.',
        code: 'ai_not_configured',
      },
    });
  }

  const endpoint = provider.baseUrl.endsWith('/chat/completions')
    ? provider.baseUrl
    : `${provider.baseUrl}/chat/completions`;

  const body = { ...(req.body || {}) };
  // Use server-configured model unless the caller explicitly passed a non-default override
  if (!body.model || body.model === 'auto' || body.model === 'agnes-2.5-flash') {
    body.model = provider.defaultModel;
  }

  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      };
      if (provider.name === 'openrouter') {
        headers['HTTP-Referer'] = 'https://railraksha.tech';
        headers['X-Title'] = 'RailRaksha';
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await response.json().catch(() => ({}));
      if (response.ok) return res.status(200).json(data);

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return res.status(response.status).json(data);
      }
      lastError = data;
    } catch (err) {
      clearTimeout(timeout);
      lastError = { error: { message: err.name === 'AbortError' ? 'Upstream AI request timed out' : err.message } };
    }

    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, attempt === 0 ? 1500 : 3500));
    }
  }

  return res.status(504).json(lastError || {
    error: { message: 'AI service is temporarily unavailable. Please try again.', code: 'upstream_timeout' },
  });
}
