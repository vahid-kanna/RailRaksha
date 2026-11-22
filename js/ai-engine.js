/**
 * RailRaksha — Unified AI Engine (ai-engine.js)
 *
 * Routing priority:
 *   1. If the user entered a personal API key in Settings → call their configured
 *      OpenAI-compatible endpoint directly.
 *   2. Otherwise → call the server-side proxy at `/api/chat` (works on both
 *      Cloudflare Pages and Vercel), falling back to `https://railraksha.vercel.app/api/chat`
 *      if same-origin `/api/chat` returns 404.
 */

const FALLBACK_PROXY_URL = "https://railraksha.vercel.app/api/chat";

export function getAISettings() {
  const cfg = window.getConfig || ((key) => localStorage.getItem(key) || "");
  return {
    provider: cfg("ai_provider") || "openai_compatible",
    apiKey:   cfg("ai_api_key") || "",
    baseUrl:  cfg("ai_base_url") || "https://generativelanguage.googleapis.com/v1beta/openai",
    model:    cfg("ai_model") || "auto",
  };
}

/**
 * Universal AI Completion function — supports text and vision inputs.
 */
export async function callAI({ prompt, imageBase64 = null, mimeType = "image/jpeg" }) {
  const settings = getAISettings();
  const hasUserKey = Boolean(settings.apiKey && settings.apiKey.trim());

  const userContent = imageBase64
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } },
      ]
    : prompt;

  const requestBody = {
    model: settings.model || "auto",
    messages: [
      {
        role: "system",
        content: "You are an expert assistant for Indian Railways Permanent Way track safety and engineering (IRPWM / GR). Return structured JSON when requested. Output the final answer only without chain-of-thought.",
      },
      { role: "user", content: userContent },
    ],
    temperature: 0.2,
    max_tokens: 2048,
  };

  // Direct call if user explicitly supplied their own API key in Settings
  if (hasUserKey) {
    let url = (settings.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/+$/, "");
    if (!url.endsWith("/chat/completions") && !url.endsWith("/completions")) {
      url += "/chat/completions";
    }
    if (!requestBody.model || requestBody.model === "auto") {
      requestBody.model = url.includes("googleapis.com") ? "gemini-2.5-flash" : "gpt-4o-mini";
    }
    return executeRequest(url, requestBody, {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey.trim()}`,
    });
  }

  // Otherwise use server-side proxy (same-origin first, then Vercel mirror on 404)
  const isLocal = typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
  const primaryProxy = isLocal ? FALLBACK_PROXY_URL : "/api/chat";

  try {
    return await executeRequest(primaryProxy, requestBody, { "Content-Type": "application/json" });
  } catch (err) {
    if (primaryProxy === "/api/chat" && err.status === 404) {
      return await executeRequest(FALLBACK_PROXY_URL, requestBody, { "Content-Type": "application/json" });
    }
    throw err;
  }
}

async function executeRequest(fetchUrl, requestBody, headers, retryCount = 0) {
  const response = await fetch(fetchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || errorData.message || `AI service returned HTTP ${response.status}`;

    if (response.status === 429 && retryCount < 1) {
      await new Promise(r => setTimeout(r, 4000));
      return executeRequest(fetchUrl, requestBody, headers, retryCount + 1);
    }

    const err = new Error(errMsg);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseJSONOrText(stripThinking(rawText));
}

function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<\s*think[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "").trim();
}

function parseJSONOrText(rawText) {
  if (!rawText) throw new Error("Empty response from AI model");

  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
    } catch { /* fallback below */ }
  }

  try { return JSON.parse(rawText.trim()); }
  catch { return { rawText }; }
}
