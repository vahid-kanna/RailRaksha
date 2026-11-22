/**
 * RailRaksha — IRPWM & Permanent Way Manual Assistant (pw-manual.js)
 * Instant offline rulebook search + AI fallback for custom Telugu/English queries.
 */

import { callAI } from './ai-engine.js';

let elements = {};
let isVoiceSearching = false;

export function initPWManual(els) {
  elements = els;
  renderQuickRules();
  elements.btnVoiceSearch?.addEventListener("click", startVoiceSearch);
  elements.searchInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitSearch(); });
  elements.btnSearch?.addEventListener("click", submitSearch);
}

const QUICK_RULES = [
  {
    category: "GAUGE & TOLERANCES",
    title: "Permissible Gauge Variation (BG)",
    preview: "Standard BG: 1676 mm. Straight: -6 to +6 mm; curves: -6 to +15 mm.",
    fullText: "As per IRPWM Para 2.4.3: Standard Broad Gauge = 1676 mm. Maximum permissible variation on straight track: -6 mm to +6 mm. On curves: -6 mm to +15 mm. When gauge exceeds these limits, immediately report to PWI and impose the prescribed speed restriction.",
    tag: "gauge",
    irpwm: "Para 2.4.3",
  },
  {
    category: "SPEED RESTRICTION",
    title: "Cracked or Fractured Rail",
    preview: "Immediate 30 km/h caution for cracked rail; Stop Dead for full fracture.",
    fullText: "As per IRPWM Para 2.6.1: On detecting a cracked rail, impose an immediate 30 km/h caution order and clamp/joggle-fishplate. If the rail fracture is complete, STOP all train movements immediately, protect the line with detonators/hand signals, and inform Station Master and PWI.",
    tag: "emergency",
    irpwm: "Para 2.6.1",
  },
  {
    category: "HOT WEATHER",
    title: "Rail Temperature & Sun Kink",
    preview: "Hot-weather patrolling required above 65°C rail temperature on BG LWR.",
    fullText: "As per IRPWM Para 2.9: Hot-weather patrolling is mandatory when rail temperature exceeds Td+20°C / 65°C on BG LWR track. Post patrolmen at curves, SEJs, and welds. If buckling/sun kink occurs, stop trains immediately and inform PWI.",
    tag: "safety",
    irpwm: "Para 2.9",
  },
  {
    category: "EMERGENCY",
    title: "Track Obstruction Protection",
    preview: "Stop trains both sides; detonators at 600 m and 1200 m (BG).",
    fullText: "If track is obstructed (GR 3.62 / IRPWM): 1) Display red hand signal and protect both directions. 2) On Broad Gauge, place 1 detonator at 600 m and 3 detonators (10 m apart) at 1200 m from the obstruction. 3) Inform Station Masters on both ends and PWI/SSE immediately.",
    tag: "emergency",
    irpwm: "GR 3.62",
  },
  {
    category: "MONSOON",
    title: "Monsoon Patrolling & Flooding",
    preview: "Water above rail top = Stop Dead. Inspect bridges, culverts, and banks.",
    fullText: "As per IRPWM Para 2.11: Patrol assigned monsoon beat twice daily and after heavy downpours. If flood water reaches rail top or submerges ballast/bridge danger mark, stop all trains immediately and alert both Station Masters.",
    tag: "safety",
    irpwm: "Para 2.11",
  },
  {
    category: "SECURITY",
    title: "Suspected Track Sabotage",
    preview: "Stop trains immediately, preserve scene, inform SM, PWI, and RPF.",
    fullText: "If deliberate tampering or removal of rails/fittings is suspected (GR 3.82): 1) Stop trains from both directions immediately. 2) Do not disturb evidence or attempt solo repair. 3) Inform Station Master, PWI/SSE, and RPF (1800-111-322).",
    tag: "emergency",
    irpwm: "GR 3.82",
  },
  {
    category: "SLEEPERS",
    title: "Defective PSC Sleeper Criteria",
    preview: ">3 transverse cracks, broken body, or loose insert = defective.",
    fullText: "As per IRPWM Para 3.2: A concrete sleeper is unserviceable if it has >3 transverse cracks, cannot hold gauge, has damaged inserts/clips, or is broken through. More than 10% consecutive/clustered defective sleepers requires speed restriction and replacement.",
    tag: "gauge",
    irpwm: "Para 3.2",
  },
  {
    category: "SIGNALS",
    title: "Detonator Placement Rules (BG)",
    preview: "1 detonator at 600 m + 3 detonators (10 m apart) at 1200 m.",
    fullText: "As per GR 3.62 / 3.78 for Broad Gauge line protection: Place 1 detonator at 600 m from the obstruction and 3 detonators at 10 m intervals at 1200 m, standing at 45 m beyond with a red danger flag/lamp.",
    tag: "safety",
    irpwm: "GR 3.62 / 3.78",
  },
];

function renderQuickRules() {
  if (!elements.quickRulesList) return;
  elements.quickRulesList.innerHTML = "";
  QUICK_RULES.forEach((rule) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "rule-card";
    const tagClass = { emergency: "rc-tag-emergency", safety: "rc-tag-safety", gauge: "rc-tag-gauge" }[rule.tag] || "";
    card.innerHTML = `
      <div class="rc-top">
        <span class="rc-category">${rule.category}</span>
        <span class="rc-tag ${tagClass}">${rule.irpwm}</span>
      </div>
      <div class="rc-title">${rule.title}</div>
      <div class="rc-preview">${rule.preview}</div>`;
    card.addEventListener("click", () => showRuleAnswer(rule));
    elements.quickRulesList.appendChild(card);
  });
}

function showRuleAnswer(rule) {
  if (!elements.manualAnswerCard) return;
  elements.manualAnswerCard.classList.add("visible");
  if (elements.maaTitle) elements.maaTitle.textContent = rule.title;
  if (elements.maaBody) elements.maaBody.textContent = rule.fullText;
  if (elements.maaSource) elements.maaSource.textContent = `Offline IRPWM Reference · ${rule.irpwm}`;
  elements.manualAnswerCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function startVoiceSearch() {
  if (isVoiceSearching) return;
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    showToast("Voice not supported — type your question", "warn");
    elements.searchInput?.focus();
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = "te-IN";
  rec.continuous = false;
  rec.interimResults = false;
  isVoiceSearching = true;
  if (elements.btnVoiceSearch) elements.btnVoiceSearch.style.opacity = "0.6";
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    if (elements.searchInput) elements.searchInput.value = text;
    isVoiceSearching = false;
    if (elements.btnVoiceSearch) elements.btnVoiceSearch.style.opacity = "1";
    submitSearch();
  };
  rec.onerror = () => {
    isVoiceSearching = false;
    if (elements.btnVoiceSearch) elements.btnVoiceSearch.style.opacity = "1";
    showToast("Voice input failed — type your question", "warn");
    elements.searchInput?.focus();
  };
  rec.start();
}

function matchLocalRule(query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  if (tokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const r of QUICK_RULES) {
    const hay = `${r.title} ${r.category} ${r.preview} ${r.fullText} ${r.irpwm}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (hay.includes(t)) score++;
    if (score > bestScore && score >= Math.ceil(tokens.length * 0.6)) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

async function submitSearch() {
  const query = elements.searchInput?.value?.trim();
  if (!query) return;

  const localMatch = matchLocalRule(query);
  if (localMatch) {
    showRuleAnswer(localMatch);
    return;
  }

  showAnalyzingOverlay(true, "Searching PW Manual", "Looking up IRPWM guidance...");

  const prompt = `You are an expert on the Indian Railways Permanent Way Manual (IRPWM) and General Rules (GR).
A Gang Mate asks (in Telugu or English): "${query}"

Reply in plain, clear English under 180 words with:
1. Exact rule / tolerance value
2. IRPWM or GR reference
3. Immediate field action & safety precaution
Output plain text only (no JSON, no markdown code blocks).`;

  try {
    const res = await callAI({ prompt });
    showAnalyzingOverlay(false);
    if (elements.manualAnswerCard) elements.manualAnswerCard.classList.add("visible");
    const text = typeof res === "string"
      ? res
      : res?.rawText || res?.answer || Object.entries(res).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
    if (elements.maaTitle) elements.maaTitle.textContent = query;
    if (elements.maaBody) elements.maaBody.textContent = text;
    if (elements.maaSource) elements.maaSource.textContent = "AI Reference — verify critical orders against official IRPWM.";
    elements.manualAnswerCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("Query failed: " + err.message, "error");
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
