/**
 * Cloudflare Pages Function — POST /api/chat
 * Mirrors Vercel's api/chat.js so https://railraksha.tech/api/chat works natively.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function resolveProvider(env) {
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
      defaultModel: env.AI_MODEL || 'glm-5.3-flash',
      name: 'bynara',
    };
  }
  return null;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost({ request, env }) {
  const provider = resolveProvider(env);
  if (!provider) {
    return new Response(JSON.stringify({
      error: {
        message: 'Server AI provider is not configured. Add GEMINI_API_KEY (or AI_API_KEY) in Cloudflare Pages environment variables, or configure your key in Settings.',
        code: 'ai_not_configured',
      },
    }), { status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  if (!body.model || body.model === 'auto' || body.model === 'agnes-2.5-flash') {
    body.model = provider.defaultModel;
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

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: err.message || 'Upstream AI error' } }), {
      status: 504, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }
}
