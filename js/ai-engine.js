/**
 * RailRaksha — Unified AI Engine v8.0 (ai-engine.js)
 *
 * Routing priority (100% Cloudflare-native):
 *   1. If user entered a personal API key in Settings -> call their OpenAI-compatible endpoint.
 *   2. Otherwise -> call same-origin Cloudflare Worker `POST /api/chat` (Gemini 3 Flash failover).
 */

export function getAISettings() {
  const cfg = window.getConfig || ((key) => localStorage.getItem(key) || '');
  return {
    provider: cfg('ai_provider') || 'openai_compatible',
    apiKey:   cfg('ai_api_key') || '',
    baseUrl:  cfg('ai_base_url') || 'https://generativelanguage.googleapis.com/v1beta/openai',
    model:    cfg('ai_model') || 'auto',
  };
}

export async function checkServerHealth() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { reachable: false, offline: true, services: null };
  }
  try {
    const resp = await fetch('/api/health', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { reachable: false, status: resp.status, services: null };
    const data = await resp.json();
    return { reachable: true, ...data };
  } catch {
    return { reachable: false, services: null };
  }
}

export async function callAI({ prompt, imageBase64 = null, mimeType = 'image/jpeg' }) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const err = new Error('Device is offline');
    err.code = 'offline';
    throw err;
  }

  const settings = getAISettings();
  const hasUserKey = Boolean(settings.apiKey && settings.apiKey.trim());

  const userContent = imageBase64
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${imageBase64}` } },
      ]
    : prompt;

  const requestBody = {
    model: settings.model || 'auto',
    messages: [
      {
        role: 'system',
        content: 'You are an expert assistant for Indian Railways Permanent Way track safety and engineering (IRPWM / GR). Return valid JSON when requested. Output the final answer concisely without chain-of-thought.',
      },
      { role: 'user', content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 3072,
  };

  if (hasUserKey) {
    let url = (settings.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions') && !url.endsWith('/completions')) {
      url += '/chat/completions';
    }
    if (!requestBody.model || requestBody.model === 'auto') {
      requestBody.model = url.includes('googleapis.com') ? 'gemini-3-flash-preview' : 'gpt-4o-mini';
    }
    return executeRequest(url, requestBody, {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey.trim()}`,
    });
  }

  return executeRequest('/api/chat', requestBody, {
    'Content-Type': 'application/json',
  });
}

async function executeRequest(fetchUrl, requestBody, headers, retryCount = 0) {
  let response;
  try {
    response = await fetch(fetchUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(55000),
    });
  } catch (err) {
    const wrapped = new Error(err?.name === 'TimeoutError' ? 'AI request timed out' : 'Network unavailable');
    wrapped.code = err?.name === 'TimeoutError' ? 'timeout' : 'offline';
    throw wrapped;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || errorData.message || `AI service returned HTTP ${response.status}`;

    if (response.status === 429 && retryCount < 1) {
      await new Promise(r => setTimeout(r, 3500));
      return executeRequest(fetchUrl, requestBody, headers, retryCount + 1);
    }

    const err = new Error(errMsg);
    err.status = response.status;
    err.code = errorData.error?.code || (response.status === 503 || response.status === 404 ? 'ai_not_configured' : 'http_error');
    throw err;
  }

  const data = await response.json();
  const msg = data.choices?.[0]?.message || {};
  const rawText = stripThinking(msg.content || '') || stripThinking(msg.reasoning_content || '');
  return parseJSONOrText(rawText);
}

function stripThinking(text) {
  if (!text) return '';
  return String(text).replace(/<\s*think[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, '').trim();
}

function parseJSONOrText(rawText) {
  if (!rawText) throw new Error('Empty response from AI model');

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const objMatch = rawText.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0].trim()); } catch {}
  }

  try { return JSON.parse(rawText.trim()); }
  catch { return { rawText }; }
}
