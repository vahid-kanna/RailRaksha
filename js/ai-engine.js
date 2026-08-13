/**
 * RailRaksha — Universal AI Engine (ai-engine.js)
 * Supports Google Gemini API AND any OpenAI-compatible provider
 * (OpenAI, Groq, OpenRouter, DeepSeek, Ollama, LM Studio, Together AI, etc.)
 */

export function getAISettings() {
  // Use window.getConfig if available (loaded by app.js), else fall back to localStorage
  const cfg = window.getConfig || ((key) => localStorage.getItem(key) || "");
  return {
    provider: cfg("ai_provider") || "gemini",
    apiKey:   cfg("ai_api_key") || cfg("gemini_api_key") || localStorage.getItem("ai_api_key") || "",
    baseUrl:  cfg("ai_base_url") || "https://api.openai.com/v1",
    model:    cfg("ai_model") || "gemini-1.5-flash"
  };
}

/**
 * Universal AI Completion function
 * Accepts prompt + optional imageBase64 & mimeType, returns parsed JSON object or raw text.
 */
export async function callAI({ prompt, imageBase64 = null, mimeType = "image/jpeg" }) {
  const { provider, apiKey, baseUrl, model } = getAISettings();

  if (!apiKey && provider !== "ollama") {
    throw new Error("Missing AI API Key. Please configure your key in Settings ⚙️.");
  }

  const activeModel = model || (provider === "gemini" ? "gemini-1.5-flash" : "gpt-4o-mini");

  console.log(`Calling AI API | Provider: ${provider} | Model: ${activeModel} | BaseURL: ${baseUrl}`);

  if (provider === "gemini") {
    return await callGeminiAPI({ apiKey, model: activeModel, prompt, imageBase64, mimeType });
  } else {
    return await callOpenAICompatibleAPI({ apiKey, baseUrl, model: activeModel, prompt, imageBase64, mimeType });
  }
}

/**
 * Google Gemini API Handler
 */
async function callGeminiAPI({ apiKey, model, prompt, imageBase64, mimeType }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: imageBase64
      }
    });
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1000
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `Gemini API returned status ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseJSONOrText(rawText);
}

/**
 * OpenAI-Compatible API Handler
 * Works with OpenAI, Groq, OpenRouter, DeepSeek, Local Ollama, etc.
 */
async function callOpenAICompatibleAPI({ apiKey, baseUrl, model, prompt, imageBase64, mimeType }) {
  // Normalize base URL (strip trailing slashes)
  let cleanBaseUrl = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!cleanBaseUrl.endsWith("/chat/completions") && !cleanBaseUrl.endsWith("/completions")) {
    cleanBaseUrl += "/chat/completions";
  }

  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Construct message content
  let userContent;
  if (imageBase64) {
    userContent = [
      { type: "text", text: prompt },
      {
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${imageBase64}`
        }
      }
    ];
  } else {
    userContent = prompt;
  }

  const requestBody = {
    model: model,
    messages: [
      {
        role: "system",
        content: "You are an expert AI assistant for Indian Railways track safety and engineering. The user is relying on you for specific feature processing (e.g. defect analysis, gang diary generation, rule lookup). Return structured JSON when requested and follow instructions precisely."
      },
      {
        role: "user",
        content: userContent
      }
    ],
    temperature: 0.2,
    max_tokens: 1500
  };

  try {
    const response = await fetch(cleanBaseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("AI API Error response:", errorData);
      throw new Error(errorData.error?.message || errorData.message || `AI API returned status ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content || "";
    return parseJSONOrText(rawText);
  } catch (err) {
    console.error("AI call failed in callOpenAICompatibleAPI:", err);
    throw err;
  }
}

/**
 * Helper to safely extract JSON from AI response markdown wrapper
 */
function parseJSONOrText(rawText) {
  if (!rawText) throw new Error("Empty response received from AI model");
  
  // Try extracting json code block
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      return JSON.parse(jsonStr.trim());
    } catch {
      // Fallback to raw text if JSON parse fails
    }
  }

  try {
    return JSON.parse(rawText.trim());
  } catch {
    return { rawText };
  }
}
