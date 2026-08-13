/**
 * RailRaksha — PW Manual Voice Assistant (pw-manual.js)
 * Telugu/English voice queries over Indian Railways IRPWM rules.
 * Uses Gemini 1.5 Flash with built-in IRPWM knowledge + quick-reference cards.
 */

import { callAI, getAISettings } from './ai-engine.js';

let elements = {};
let isVoiceSearching = false;

export function initPWManual(els) {
  elements = els;
  renderQuickRules();
  elements.btnVoiceSearch?.addEventListener("click", startVoiceSearch);
  elements.searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitSearch(); });
  elements.btnSearch?.addEventListener("click", submitSearch);
}

// ── Quick Reference Rules ────────────────────────────────────────────────────

const QUICK_RULES = [
  {
    category: "GAUGE & TOLERANCES",
    title: "Permissible Gauge Variation (BG)",
    preview: "Standard BG gauge: 1676mm. Permissible variation: -6mm to +6mm on straight, -6 to +15mm on curves.",
    fullText: "As per IRPWM Para 2.4.3: Standard Broad Gauge = 1676mm. Maximum permissible variation on straight track: -6mm to +6mm. On curves: -6mm to +15mm. When gauge exceeds these limits, the gang must immediately report to PWI and impose appropriate speed restriction.",
    tag: "gauge", irpwm: "Para 2.4.3"
  },
  {
    category: "SPEED RESTRICTION",
    title: "Speed Restriction — Cracked/Broken Rail",
    preview: "A cracked or fractured rail requires immediate speed restriction to 30 km/h or complete stop.",
    fullText: "As per IRPWM Para 2.6.1: On detection of a cracked or broken rail, the mate must immediately impose a caution order at 30 km/h. If the fracture is complete, train movement must be stopped. The PWI must be informed immediately and a hand signal/detonator must be placed.",
    tag: "emergency", irpwm: "Para 2.6.1"
  },
  {
    category: "HOT WEATHER",
    title: "Rail Temperature — Sun Kink Precautions",
    preview: "Hot weather patrolling required when rail temperature exceeds 65°C on BG track.",
    fullText: "As per IRPWM Para 2.9: Hot weather patrolling is required when rail temperature exceeds 65°C (BG). During hot weather patrolling, men must be posted at curves, joints, and switches. If a sun kink is detected, trains must be stopped and PWI informed. Trains may be allowed at 10 km/h after inspection.",
    tag: "safety", irpwm: "Para 2.9"
  },
  {
    category: "EMERGENCY",
    title: "Track Obstruction Emergency Procedure",
    preview: "Steps when a tree, vehicle, or landslide blocks the track — detonators, hand signals, train stop.",
    fullText: "If track is obstructed: 1) Immediately send someone to stop approaching trains from both directions. 2) Place detonators (3 detonators at 900m intervals) in the direction of approaching trains. 3) Display Red/Danger hand signal. 4) Inform Station Master on both sides by phone/walkie-talkie. 5) Inform PWI/SSE/AEN. 6) Do not allow trains until track is clear and inspected.",
    tag: "emergency", irpwm: "GR 3.78 + IRPWM 2.5"
  },
  {
    category: "MONSOON",
    title: "Monsoon Patrolling Rules",
    preview: "During heavy rain: inspect bridges, culverts, embankments. Water above rail level = stop trains.",
    fullText: "As per IRPWM Para 2.11: During monsoon, patrol every assigned km length twice daily. If water level reaches the top of rails — stop trains immediately and inform both station masters. Check bridge foundations, culverts, embankments after every heavy rain. Patrolman must carry a flashlight and detonators at night.",
    tag: "safety", irpwm: "Para 2.11"
  },
  {
    category: "TRACK SAFETY",
    title: "Suspected Track Sabotage Procedure",
    preview: "If you find rails or fittings deliberately removed or tampered with — STOP all trains immediately.",
    fullText: "If track sabotage is suspected: 1) IMMEDIATELY stop trains from both directions using detonators and hand signals. 2) Do not touch or move anything — preserve the scene. 3) Inform PWI, Station Master, and Railway Protection Force (RPF). 4) Wait for PWI before allowing any train. This is a criminal matter — do not attempt to repair alone.",
    tag: "emergency", irpwm: "GR 3.82"
  },
  {
    category: "SLEEPERS",
    title: "Defective Sleeper Limits",
    preview: "A sleeper is 'bad' if it has > 3 cracks, gauge cannot be maintained, or it cannot hold rail clips.",
    fullText: "As per IRPWM Para 3.2: A concrete sleeper is classified as defective if: it has more than 3 transverse cracks, gauge cannot be maintained on it, the insert/clip cannot be tightened, or it is broken into two pieces. Defective sleepers must be flagged and replaced within the next maintenance cycle. >10% defective sleepers in any 100m requires speed restriction.",
    tag: "gauge", irpwm: "Para 3.2"
  },
  {
    category: "SIGNALS",
    title: "Detonator Signal Rules",
    preview: "Detonators must be placed 90m, 270m, and 1080m ahead of danger. One detonator = caution.",
    fullText: "As per GR 3.78: Detonator placement for emergency: 1) Single detonator = Caution signal. 2) Three detonators at 10m apart = DANGER — train must stop. For long-duration obstruction: place 3 detonators at 90m, 270m, and 1080m ahead of obstruction. After train acknowledges (2 long whistles), the detonator can be removed.",
    tag: "safety", irpwm: "GR 3.78"
  }
];

function renderQuickRules() {
  if (!elements.quickRulesList) return;
  elements.quickRulesList.innerHTML = "";
  QUICK_RULES.forEach((rule, i) => {
    const card = document.createElement("div");
    card.className = "rule-card slide-in-up";
    card.style.animationDelay = `${i * 0.05}s`;
    const tagClass = { emergency: "rc-tag-emergency", safety: "rc-tag-safety", gauge: "rc-tag-gauge" }[rule.tag] || "";
    card.innerHTML = `
      <div class="rc-category">${rule.category}</div>
      <div class="rc-title">${rule.title}</div>
      <div class="rc-preview">${rule.preview}</div>
      <span class="rc-tag ${tagClass}">${rule.irpwm}</span>`;
    card.addEventListener("click", () => showRuleAnswer(rule));
    elements.quickRulesList.appendChild(card);
  });
}

function showRuleAnswer(rule) {
  if (!elements.manualAnswerCard) return;
  elements.manualAnswerCard.classList.add("visible");
  if (elements.maaTitle) elements.maaTitle.textContent = rule.title;
  if (elements.maaBody) elements.maaBody.textContent = rule.fullText;
  if (elements.maaSource) elements.maaSource.textContent = `Source: Indian Railways IRPWM — ${rule.irpwm}`;
  elements.manualAnswerCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Voice Search ─────────────────────────────────────────────────────────────

function startVoiceSearch() {
  if (isVoiceSearching) return;
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    showToast("🎙️ Voice not supported — type your question", "warn");
    elements.searchInput?.focus();
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = "te-IN";
  rec.continuous = false;
  rec.interimResults = false;
  isVoiceSearching = true;
  elements.btnVoiceSearch.style.opacity = "0.6";
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    if (elements.searchInput) elements.searchInput.value = text;
    isVoiceSearching = false;
    elements.btnVoiceSearch.style.opacity = "1";
    submitSearch();
  };
  rec.onerror = () => {
    isVoiceSearching = false;
    elements.btnVoiceSearch.style.opacity = "1";
    showToast("🎙️ Voice failed — type your question", "warn");
    elements.searchInput?.focus();
  };
  rec.start();
}

async function submitSearch() {
  const query = elements.searchInput?.value?.trim();
  if (!query) return;

  // First check local quick rules
  const lower = query.toLowerCase();
  const localMatch = QUICK_RULES.find(r =>
    r.title.toLowerCase().includes(lower) ||
    r.category.toLowerCase().includes(lower) ||
    r.fullText.toLowerCase().includes(lower)
  );
  if (localMatch) { showRuleAnswer(localMatch); return; }

  const aiSettings = getAISettings();
  if (!aiSettings.apiKey && aiSettings.provider !== "ollama") {
    showToast("⚙️ Set your AI API key in Settings for custom queries", "warn");
    return;
  }

  showAnalyzingOverlay(true, "Searching PW Manual...", "AI is looking up the rule");

  const prompt = `You are an expert on the Indian Railways Permanent Way Manual (IRPWM), General Rules (GR), and track maintenance procedures.

A Gang Mate (Track Maintainer Grade-I) is asking the following question in the field (may be in Telugu or English):
"${query}"

Answer in simple, clear English that a track maintenance worker can immediately act on. Include:
1. The exact rule or tolerance value if applicable
2. The relevant IRPWM paragraph/section reference
3. What immediate action the Gang Mate should take
4. Any safety precautions

Keep your answer under 200 words. Be specific and actionable.`;

  try {
    console.log("Calling AI for PW Manual search...");
    const res = await callAI({ prompt });
    const answer = typeof res === "string" ? res : res.rawText || JSON.stringify(res, null, 2);

    showAnalyzingOverlay(false);
    if (elements.manualAnswerCard) elements.manualAnswerCard.classList.add("visible");
    if (elements.maaTitle) elements.maaTitle.textContent = `Answer: "${query}"`;
    if (elements.maaBody) elements.maaBody.textContent = answer;
    if (elements.maaSource) elements.maaSource.textContent = "Generated by AI Engine — verify with official IRPWM before critical decisions.";
    elements.manualAnswerCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("❌ Query failed: " + err.message, "error");
    console.error("AI Error in PW Manual search:", err);
  }
}

function showAnalyzingOverlay(show, title = "", sub = "") {
  const overlay = document.getElementById("analyzing-overlay");
  if (!overlay) return;
  overlay.classList.toggle("active", show);
  if (show) {
    const t = overlay.querySelector(".analyzing-text");
    const s = overlay.querySelector(".analyzing-sub");
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
  }
}

function showToast(msg, type = "info") {
  window.dispatchEvent(new CustomEvent("showToast", { detail: { msg, type } }));
}
