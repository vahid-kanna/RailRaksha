/**
 * RailRaksha — Dual AI Engine (ai-engine.js)
 *
 * Text tasks  → Groq (llama-3.3-70b-versatile) — fast, free
 * Image tasks → Gemini (gemini-2.5-flash) — multimodal vision
 *
 * Both keys are pre-loaded. Users can override via Settings.
 */

export function getAISettings() {
  const cfg = window.getConfig || ((key) => localStorage.getItem(key) || "");
  return {
    provider: cfg("ai_provider") || "openai_compatible",
    apiKey:   cfg("ai_api_key") || "",
    baseUrl:  cfg("ai_base_url") || "https://api.groq.com/openai/v1",
    model:    cfg("ai_model") || "llama-3.3-70b-versatile",
    // Image-specific settings (Gemini)
    imgProvider: cfg("image_ai_provider") || "gemini",
    imgApiKey:   cfg("image_ai_api_key") || "",
    imgModel:    cfg("image_ai_model") || "gemini-2.5-flash",
  };
}

/**
 * Universal AI Completion function
 * Automatically routes to Gemini when an image is attached,
 * otherwise uses the configured text provider (Groq).
 */
export async function callAI({ prompt, imageBase64 = null, mimeType = "image/jpeg" }) {
  const settings = getAISettings();

  if (imageBase64) {
    // ── Vision task → always use Gemini ──────────────────────────────
    if (!settings.imgApiKey) {
      throw new Error("Missing Gemini API key for image analysis. Check Settings ⚙️.");
    }
    return await callGeminiAPI({
      apiKey: settings.imgApiKey,
      model: settings.imgModel,
      prompt,
      imageBase64,
      mimeType
    });
  } else {
    // ── Text task → use configured provider (Groq by default) ────────
    if (!settings.apiKey && settings.provider !== "ollama") {
      throw new Error("Missing AI API Key. Please configure your key in Settings ⚙️.");
    }
    if (settings.provider === "gemini") {
      return await callGeminiAPI({
        apiKey: settings.apiKey,
        model: settings.model,
        prompt,
        imageBase64: null,
        mimeType
      });
    } else {
      return await callOpenAICompatibleAPI({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt,
        imageBase64: null,
        mimeType
      });
    }
  }
}

/**
 * Google Gemini API Handler (supports vision)
 */
async function callGeminiAPI({ apiKey, model, prompt, imageBase64, mimeType }) {
  const activeModel = model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: imageBase64
      }
    });
  }

  console.log(`Calling Gemini API | Model: ${activeModel} | Image: ${!!imageBase64}`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1500
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API returned status ${response.status}`);
  }

  const data = await response.json();
  const parts_resp = data.candidates?.[0]?.content?.parts || [];
  const rawText = parts_resp[0]?.text || "";
  if (!rawText && !parts_resp.some(p => p.text)) {
    throw new Error("Gemini returned empty response (thinking may have consumed token budget). Try again.");
  }
  return parseJSONOrText(rawText);
}

/**
 * OpenAI-Compatible API Handler (Groq, OpenAI, etc. — text only)
 */
async function callOpenAICompatibleAPI({ apiKey, baseUrl, model, prompt }) {
  let cleanBaseUrl = (baseUrl || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  if (!cleanBaseUrl.endsWith("/chat/completions") && !cleanBaseUrl.endsWith("/completions")) {
    cleanBaseUrl += "/chat/completions";
  }

  const activeModel = model || "llama-3.3-70b-versatile";
  console.log(`Calling OpenAI-compatible API | Model: ${activeModel} | URL: ${cleanBaseUrl}`);

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const requestBody = {
    model: activeModel,
    messages: [
      {
        role: "system",
        content: "You are an expert AI assistant for Indian Railways track safety and engineering. Return structured JSON when requested."
      },
      { role: "user", content: prompt }
    ],
    temperature: 0.2,
    max_tokens: 1500
  };

  const response = await fetch(cleanBaseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error("AI API Error:", errorData);
    throw new Error(errorData.error?.message || errorData.message || `AI API returned status ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseJSONOrText(rawText);
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
