/**
 * RailRaksha — IRPWM & Permanent Way Manual Assistant v7.0 (pw-manual.js)
 *
 * 14 authentic Indian Railways Permanent Way Manual (IRPWM) and General Rules (GR)
 * references cached 100% offline, with instant category filtering, live keyword search,
 * Telugu/English voice query, and optional online AI lookup for custom questions.
 */

import { callAI } from './ai-engine.js';

let elements = {};
let isVoiceSearching = false;
let activeCategory = 'ALL';

export const QUICK_RULES = [
  {
    id: 'gauge-bg',
    group: 'GAUGE',
    category: 'GAUGE & TOLERANCES',
    title: 'Permissible Gauge Variation (BG)',
    preview: 'Standard BG: 1676 mm. Straight: −6 to +6 mm; curves: −6 to +15 mm.',
    fullText: 'As per IRPWM Para 2.4.3: Standard Broad Gauge = 1676 mm. Maximum permissible variation on straight track is −6 mm to +6 mm. On curves with radius ≥ 350 m, −6 mm to +15 mm (up to +20 mm on sharp curves < 350 m). Report exceedances to PWI immediately and impose prescribed speed restriction.',
    tag: 'gauge',
    irpwm: 'Para 2.4.3',
  },
  {
    id: 'cracked-rail',
    group: 'EMERGENCY',
    category: 'RAIL FRACTURE',
    title: 'Cracked or Fractured Rail',
    preview: '30 km/h caution for cracked rail; Stop Dead immediately for full fracture.',
    fullText: 'As per IRPWM Para 2.6.1: On detecting a cracked rail, impose an immediate 30 km/h caution order and fit joggle fishplates with C-clamps. If the rail fracture is complete (gap > 30 mm or unsafe), STOP all trains immediately, protect both directions with detonators/hand signals, and inform Station Master and PWI.',
    tag: 'emergency',
    irpwm: 'Para 2.6.1',
  },
  {
    id: 'hot-weather',
    group: 'WEATHER',
    category: 'HOT WEATHER / LWR',
    title: 'Rail Temperature & Sun Kink (LWR)',
    preview: 'Hot-weather patrolling required above Td+20°C (~65°C) on BG LWR.',
    fullText: 'As per IRPWM Para 2.9 & LWR Manual: Hot-weather patrolling is mandatory when rail steel temperature exceeds Td+20°C (typically 65°C on BG Zone III). Patrol curves, SEJs, and welds closely. Do not disturb ballast during hot hours. If buckling/sun kink occurs, stop trains immediately and protect both sides.',
    tag: 'safety',
    irpwm: 'Para 2.9',
  },
  {
    id: 'obstruction-protection',
    group: 'EMERGENCY',
    category: 'LINE PROTECTION',
    title: 'Track Obstruction Protection (BG)',
    preview: 'Stop trains both sides; 1 detonator at 600 m + 3 detonators at 1200 m.',
    fullText: 'As per GR 3.62 / 3.78 for Broad Gauge obstruction protection: 1) Display red danger flag/lamp and send protection parties in both directions on double line (or approaching side). 2) Place 1 detonator at 600 m and 3 detonators (10 m apart) at 1200 m from the obstruction. 3) Stand 45 m beyond the last detonator displaying red hand signal and alert Station Masters.',
    tag: 'emergency',
    irpwm: 'GR 3.62 / 3.78',
  },
  {
    id: 'monsoon-patrol',
    group: 'WEATHER',
    category: 'MONSOON',
    title: 'Monsoon Patrolling & Flooding',
    preview: 'Water above rail foot/top = Stop Dead. Inspect bridges, culverts, banks.',
    fullText: 'As per IRPWM Para 2.11: Patrol assigned monsoon beat systematically during heavy rainfall. Inspect bridge waterways, danger level marks, catch-water drains, and cutting slopes. If floodwater reaches rail foot/top or submerges ballast/bridge danger mark, stop all trains immediately and alert both Station Masters.',
    tag: 'safety',
    irpwm: 'Para 2.11',
  },
  {
    id: 'sabotage',
    group: 'EMERGENCY',
    category: 'SECURITY',
    title: 'Suspected Track Sabotage',
    preview: 'Stop trains immediately, preserve evidence, inform SM, PWI, and RPF (182).',
    fullText: 'Under GR 3.82: If deliberate tampering or missing rails/fishplates/fittings is suspected: 1) Stop trains from both directions immediately and protect the line. 2) Preserve the scene — do not disturb evidence or attempt solo repair. 3) Inform Station Master, PWI/SSE, and RPF Security Helpline (182 / 1800-111-322).',
    tag: 'emergency',
    irpwm: 'GR 3.82',
  },
  {
    id: 'psc-sleeper',
    group: 'TRACK',
    category: 'SLEEPERS',
    title: 'Defective PSC Sleeper Criteria',
    preview: '>3 transverse cracks, broken body, or loose insert = unserviceable.',
    fullText: 'As per IRPWM Para 3.2: A PSC concrete sleeper is unserviceable if it has >3 transverse cracks, cannot maintain gauge, has damaged inserts/liners, or is cracked through at the rail seat. More than 10% consecutive or clustered defective sleepers requires an immediate speed restriction and scheduled replacement.',
    tag: 'gauge',
    irpwm: 'Para 3.2',
  },
  {
    id: 'erc-fastenings',
    group: 'TRACK',
    category: 'FASTENINGS',
    title: 'ERC Clip & Toe Load Inspection',
    preview: 'Check ERC seating, GFN liners, and rubber pads; lubricate to prevent seizure.',
    fullText: 'As per IRPWM Para 3.3: Elastic Rail Clips (ERC Mk-III / Mk-V) must maintain firm toe load (850–1100 kgf) with intact grooved rubber sole plates (GRSP) and insulating liners on track-circuited sections. Grease clip legs periodically in coastal corrosive stretches like SKM–UPD to prevent rail-seat seizure.',
    tag: 'gauge',
    irpwm: 'Para 3.3',
  },
  {
    id: 'joggle-clamp',
    group: 'TRACK',
    category: 'EMERGENCY CLAMPING',
    title: 'Joggle Fishplate & Emergency Rail Joint',
    preview: 'Use 2 joggle fishplates + 2 C-clamps on defective welds; 30 km/h caution.',
    fullText: 'As per IRPWM / USFD instructions: When an AT weld shows a crack or IMR defect, immediately install joggle fishplates with two heavy-duty C-clamps (or far-end bolts), impose a 30 km/h caution order, post a watchman until permanent weld renewal, and log exact km post & rail side (LH/RH).',
    tag: 'safety',
    irpwm: 'Para 2.6 / USFD',
  },
  {
    id: 'sej-gap',
    group: 'TRACK',
    category: 'LWR / SEJ',
    title: 'Switch Expansion Joint (SEJ) Limits',
    preview: 'Check mean gap (~40 mm at Td), oiling of tongue/stock rails, and sleeper packing.',
    fullText: 'As per LWR Manual & IRPWM: SEJ gap must stay centered around mean design gap (~40 mm at Td, max opening 65–80 mm depending on 52/60 kg SEJ design). Oil sliding chairs every fortnight, ensure tight fastenings, and report abnormal closing/opening to PWI immediately.',
    tag: 'gauge',
    irpwm: 'LWR Para 4.4',
  },
  {
    id: 'lookout-man',
    group: 'PROTECTION',
    category: 'GANG SAFETY',
    title: 'Lookout Man & Worksite Protection',
    preview: 'Mandatory dedicated lookout with horn/whistle & hand flags on curves/double line.',
    fullText: 'As per IRPWM Para 8.2 / GR: Whenever visibility is restricted (curves, cuttings, fog, noisy tamping) or working on high-speed double lines (110–130 km/h), post a dedicated Lookout Man equipped with high-visibility jacket, whistle/horn, and red/green flags. Clear all tools and personnel off the track and NEVER step blindly onto the adjacent track.',
    tag: 'safety',
    irpwm: 'Para 8.2',
  },
  {
    id: 'push-trolley',
    group: 'PROTECTION',
    category: 'TROLLEY RULES',
    title: 'Push Trolley & Material Lorry Protection',
    preview: 'Minimum 4 able-bodied men; banner flags at 600 m & 1200 m when visibility < 1200 m.',
    fullText: 'As per GR 15.18 & IRPWM: Push trolleys must only run under competent official supervision with red flag/lamp mounted. On double-line sections with visibility < 1200 m, protect with flagmen and detonators at 600 m and 1200 m, or operate strictly under Line Block authority from Station Master.',
    tag: 'protection',
    irpwm: 'GR 15.18',
  },
  {
    id: 'curve-cant',
    group: 'GAUGE',
    category: 'CURVES',
    title: 'Broad Gauge Curve Cant & Versine',
    preview: 'Max BG cant 165 mm (Group A/B); check transition versine and rail wear.',
    fullText: 'As per IRPWM Para 4.2: Maximum permissible superelevation (cant) on BG Group A/B routes (like BZA–GDR mainline) is 165 mm (185 mm with special sanction). Inspect outer rail side wear, gauge widening, and check rail clearances regularly on sharp curves.',
    tag: 'gauge',
    irpwm: 'Para 4.2',
  },
  {
    id: 'fog-patrol',
    group: 'WEATHER',
    category: 'FOG / NIGHT',
    title: 'Fog & Night Patrolling Precautions',
    preview: 'Carry detonators, tri-colour LED torch, reflective vest, and walk facing traffic.',
    fullText: 'As per IRPWM Para 2.12: During dense fog or night cold-weather patrolling, carry 10 fog detonators, charged tri-colour hand signal lamp, whistle, and high-visibility vest. Walk on the cess facing oncoming traffic on double lines and test rail joints audibly/visually at known vulnerable welds.',
    tag: 'safety',
    irpwm: 'Para 2.12',
  },
];

export function initPWManual(els) {
  elements = els;
  renderQuickRules();

  elements.btnVoiceSearch?.addEventListener('click', startVoiceSearch);
  elements.searchInput?.addEventListener('input', () => renderQuickRules(elements.searchInput.value.trim()));
  elements.searchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSearch(); });
  elements.btnSearch?.addEventListener('click', submitSearch);
  elements.btnCopyRule?.addEventListener('click', copyActiveRule);

  elements.manualCategoryBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    activeCategory = btn.dataset.cat;
    elements.manualCategoryBar.querySelectorAll('[data-cat]').forEach(b => {
      b.classList.toggle('active', b.dataset.cat === activeCategory);
    });
    renderQuickRules(elements.searchInput?.value?.trim() || '');
  });
}

function renderQuickRules(filterQuery = '') {
  if (!elements.quickRulesList) return;
  const q = filterQuery.toLowerCase();

  const filtered = QUICK_RULES.filter(r => {
    if (activeCategory !== 'ALL' && r.group !== activeCategory) return false;
    if (!q) return true;
    const hay = `${r.title} ${r.category} ${r.preview} ${r.fullText} ${r.irpwm}`.toLowerCase();
    return q.split(/\s+/).every(tok => hay.includes(tok));
  });

  if (elements.rulesCountLabel) {
    elements.rulesCountLabel.textContent = `${filtered.length} of ${QUICK_RULES.length} offline rules`;
  }

  elements.quickRulesList.innerHTML = '';
  if (filtered.length === 0) {
    elements.quickRulesList.innerHTML = `
      <div class="empty-state">
        <div class="es-title">No local IRPWM match for "${escapeHtml(filterQuery)}"</div>
        <div class="es-sub">Tap Search to query the AI assistant (requires internet).</div>
      </div>`;
    return;
  }

  filtered.forEach((rule) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'rule-card';
    const tagClass = { emergency: 'rc-tag-emergency', safety: 'rc-tag-safety', gauge: 'rc-tag-gauge', protection: 'rc-tag-safety' }[rule.tag] || '';
    card.innerHTML = `
      <div class="rc-top">
        <span class="rc-category">${rule.category}</span>
        <span class="rc-tag ${tagClass}">${rule.irpwm}</span>
      </div>
      <div class="rc-title">${rule.title}</div>
      <div class="rc-preview">${rule.preview}</div>`;
    card.addEventListener('click', () => showRuleAnswer(rule));
    elements.quickRulesList.appendChild(card);
  });
}

function showRuleAnswer(rule) {
  if (!elements.manualAnswerCard) return;
  elements.manualAnswerCard.hidden = false;
  if (elements.maaTitle) elements.maaTitle.textContent = rule.title;
  if (elements.maaBody) elements.maaBody.textContent = rule.fullText;
  if (elements.maaSource) elements.maaSource.textContent = `Offline IRPWM Reference · ${rule.irpwm}`;
  elements.manualAnswerCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function copyActiveRule() {
  const title = elements.maaTitle?.textContent || '';
  const body = elements.maaBody?.textContent || '';
  const src = elements.maaSource?.textContent || '';
  if (!body) return;
  try {
    await navigator.clipboard.writeText(`${title}\n${body}\n(${src})`);
    showToast('Rule copied to clipboard', 'ok');
  } catch {
    showToast('Unable to access clipboard', 'warn');
  }
}

function startVoiceSearch() {
  if (isVoiceSearching) return;
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    showToast('Voice search unavailable — type your question', 'warn');
    elements.searchInput?.focus();
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'te-IN';
  rec.continuous = false;
  rec.interimResults = false;
  isVoiceSearching = true;
  elements.btnVoiceSearch?.classList.add('active');
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    if (elements.searchInput) elements.searchInput.value = text;
    isVoiceSearching = false;
    elements.btnVoiceSearch?.classList.remove('active');
    renderQuickRules(text);
    submitSearch();
  };
  rec.onerror = () => {
    isVoiceSearching = false;
    elements.btnVoiceSearch?.classList.remove('active');
    showToast('Voice input unavailable — type your question', 'warn');
    elements.searchInput?.focus();
  };
  rec.onend = () => {
    isVoiceSearching = false;
    elements.btnVoiceSearch?.classList.remove('active');
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

  if (navigator.onLine === false) {
    showToast('Offline — browse the 14 built-in IRPWM rules below', 'warn');
    return;
  }

  showAnalyzingOverlay(true, 'Searching IRPWM Manual', 'Consulting Permanent Way reference...');

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
    if (elements.manualAnswerCard) elements.manualAnswerCard.hidden = false;
    const text = typeof res === 'string'
      ? res
      : res?.rawText || res?.answer || Object.entries(res).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    if (elements.maaTitle) elements.maaTitle.textContent = query;
    if (elements.maaBody) elements.maaBody.textContent = text;
    if (elements.maaSource) elements.maaSource.textContent = 'AI Reference — verify critical safety orders against official IRPWM.';
    elements.manualAnswerCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    showAnalyzingOverlay(false);
    showToast(err.code === 'ai_not_configured'
      ? 'Cloud AI not configured — browse the 14 offline rules below'
      : 'Query failed: ' + err.message, 'warn');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function showAnalyzingOverlay(show, title = '', sub = '') {
  const overlay = document.getElementById('analyzing-overlay');
  if (!overlay) return;
  overlay.hidden = !show;
  overlay.setAttribute('aria-hidden', String(!show));
  if (show) {
    const t = overlay.querySelector('.analyzing-text');
    const s = overlay.querySelector('.analyzing-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
  }
}

function showToast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { msg, type } }));
}
