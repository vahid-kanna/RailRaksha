/**
 * RailRaksha — Single AI Engine (ai-engine.js)
 *
 * Text + Image → Bynara Router (mistral-medium-3-5) — text + vision in one model.
 * Users can override via Settings.
 */

export function getAISettings() {
  const cfg = window.getConfig || ((key) => localStorage.getItem(key) || "");
  return {
    provider: cfg("ai_provider") || "openai_compatible",
    apiKey:   cfg("ai_api_key") || "",
    baseUrl:  cfg("ai_base_url") || "https://router.bynara.id/v1",
    model:    cfg("ai_model") || "mistral-medium-3-5",
  };
}

/**
 * Universal AI Completion function — one path for text and images.
 */
export async function callAI({ prompt, imageBase64 = null, mimeType = "image/jpeg" }) {
  const settings = getAISettings();
  if (!settings.apiKey) {
    throw new Error("Missing AI API Key. Please configure your key in Settings.");
  }
  return await callOpenAICompatibleAPI({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    prompt,
    imageBase64,
    mimeType
  });
}

/**
 * OpenAI-Compatible API Handler (Groq) — text + vision
 */
async function callOpenAICompatibleAPI({ apiKey, baseUrl, model, prompt, imageBase64, mimeType, retryCount = 0 }) {
  let cleanBaseUrl = (baseUrl || "https://router.bynara.id/v1").replace(/\/+$/, "");
  if (!cleanBaseUrl.endsWith("/chat/completions") && !cleanBaseUrl.endsWith("/completions")) {
    cleanBaseUrl += "/chat/completions";
  }

  const activeModel = model || "mistral-medium-3-5";
  console.log(`Calling AI API | Model: ${activeModel} | Image: ${!!imageBase64} | URL: ${cleanBaseUrl}`);

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  // Vision: user content becomes [text, image_url] parts (OpenAI-compatible format)
  const userContent = imageBase64
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}` } }
      ]
    : prompt;

  const requestBody = {
    model: activeModel,
    messages: [
      {
        role: "system",
        content: "You are an expert AI assistant for Indian Railways track safety and engineering. Return structured JSON when requested. Do not show your reasoning — output the final answer only."
      },
      { role: "user", content: userContent }
    ],
    temperature: 0.2,
    // ponytail: 4096 not 1500 — qwen3.6 is a thinking model; reasoning tokens
    // share this budget and a low cap truncated answers (the old image bug).
    max_tokens: 4096
  };

  const response = await fetch(cleanBaseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || errorData.message || `AI API returned status ${response.status}`;
    const errCode = errorData.error?.code || '';
    const errType = errorData.error?.type || '';

    // Rate limit retry with exponential backoff (up to 2 retries)
    if ((response.status === 429 || errCode === 'rate_limit_exceeded') && retryCount < 2) {
      const waitMatch = errMsg.match(/(\d+(?:\.\d+)?)\s*s/);
      const waitSec = waitMatch ? parseFloat(waitMatch[1]) + 1 : (retryCount === 0 ? 22 : 45);
      console.warn(`Rate limited, waiting ${waitSec}s before retry ${retryCount + 1}/2...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return callOpenAICompatibleAPI({ apiKey, baseUrl, model, prompt, imageBase64, mimeType, retryCount: retryCount + 1 });
    }

    // Over capacity / server error retry (500/503 with "over capacity" message)
    if ((response.status === 500 || response.status === 503) && /over capacity/i.test(errMsg) && retryCount < 2) {
      const waitSec = retryCount === 0 ? 15 : 30;
      console.warn(`Server over capacity, waiting ${waitSec}s before retry ${retryCount + 1}/2...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return callOpenAICompatibleAPI({ apiKey, baseUrl, model, prompt, imageBase64, mimeType, retryCount: retryCount + 1 });
    }

    console.error("AI API Error:", errorData);
    throw new Error(errMsg);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseJSONOrText(stripThinking(rawText));
}

/**
 * Remove  reasoning blocks emitted by thinking models (Qwen3).
 * Handles both ``, ``, and `` variants.
 */
function stripThinking(text) {
  if (!text) return text;
  return text.replace(/<\s*think[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi, "").trim();
}

/**
 * Helper to safely extract JSON from AI response
 */
function parseJSONOrText(rawText) {
  if (!rawText) throw new Error("Empty response from AI model");

  // Try extracting json code block
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse((jsonMatch[1] || jsonMatch[0]).trim());
    } catch { /* fallback below */ }
  }

  try { return JSON.parse(rawText.trim()); }
  catch { return { rawText }; }
}

// ── Self-check (run: node --experimental-vm-modules ai-engine.js or in browser console) ──
export function _selfTest() {
  const cases = [
    ["\n\n```json\n{\"a\":1}\n```", { a: 1 }],
    ["{\"defectType\":\"Cracked Rail\"}", { defectType: "Cracked Rail" }],
    ["Plain text answer", { rawText: "Plain text answer" }],
  ];
  for (const [input, expected] of cases) {
    const got = parseJSONOrText(stripThinking(input));
    console.assert(JSON.stringify(got) === JSON.stringify(expected), "FAIL:", input, got);
  }
  console.log("ai-engine self-test passed");
}
