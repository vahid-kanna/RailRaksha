/**
 * RailRaksha — Voice & Text Gang Diary v7.0 (gang-diary.js)
 *
 * Features:
 *   - Bilingual Telugu (te-IN) / English (en-IN) speech recognition with non-duplicating accumulator
 *   - Always-editable notes field + 1-tap railway work phrase chips (works in loud wind/traffic)
 *   - Cloud AI structuring when online + deterministic Offline Structured Formatter fallback
 *   - IST-accurate daily log storage in IndexedDB with shift export (.txt)
 */

import { saveDiaryEntry, getDiaryEntries, deleteDiaryEntry, getISTDateISO } from './db.js';
import { callAI } from './ai-engine.js';
import { Icons } from './icons.js';

let isRecording = false;
let recognition = null;
let finalTranscript = '';
let speechLang = 'te-IN';
let historyScope = 'today'; // 'today' | 'all'
let elements = {};

const QUICK_PHRASES = [
  { label: 'తెలుగు: స్లీపర్ & క్లిప్పులు', text: '40 స్లీపర్లు ప్యాకింగ్ చేసాము, 6 పాండ్రోల్ క్లిప్పులు బిగించాము, ఎర్ర జెండాతో లుక్ అవుట్ పెట్టాము' },
  { label: 'తెలుగు: వెల్డ్ క్రాక్ గమనిక', text: 'కి.మీ 293/4 అప్ లైన్ లో వెల్డ్ దగ్గర పగులు కనిపించింది, జోగుల్ ఫిష్ ప్లేట్ క్లాంప్ వేసి లుక్ అవుట్ పెట్టాము' },
  { label: 'Tenglish: Sleeper & Clips', text: '30 sleepers packing chesamu, 4 ERC clips tight chesamu, lookout red flag pettamu' },
  { label: 'Packed sleepers & ballast', text: 'Packed sleepers & dressed ballast' },
  { label: 'Tightened ERC & liners', text: 'Tightened ERC clips & replaced liners' },
  { label: 'Lookout man posted', text: 'Lookout man posted with red/green flags' },
  { label: 'Checked gauge & cross-level', text: 'Checked gauge & cross-level' },
  { label: 'Cleared side drains', text: 'Cleared side drains & catch-water drains' },
];

const TELUGU_PHRASE_RULES = [
  { re: /స్లీపర్|ప్యాకింగ్|tamp|packing\s*ches/i, en: 'Through packing and tamping of PSC sleepers completed' },
  { re: /క్లిప్|పాండ్రోల్|ఫాస్టెనింగ్|erc|pandrol|biginch|vesamu|marchemu/i, en: 'Elastic Rail Clips (Pandrol / ERC) and fastenings tightened or replaced' },
  { re: /లైనర్|రబ్బర్\s*ప్యాడ్|liner|rubber\s*pad/i, en: 'GFN insulating liners and grooved rubber pads inspected/replaced' },
  { re: /బ్యాలస్ట్|కంకర|ballast|kankara/i, en: 'Ballast boxing, shoulder dressing, and consolidation carried out' },
  { re: /ఫిష్\s*ప్లేట్|బోల్ట్|క్లాంప్|జోగుల్|fish\s?plate|joggle|clamp/i, en: 'Fishplates, bolts, or emergency joggle clamps attended' },
  { re: /గ్రీస్|ఆయిల్|నూనె|grease|lubricat|sej/i, en: 'Rail joints and SEJ sliding chairs lubricated' },
  { re: /డ్రైన్|కాలువ|గడ్డి|నీరు|drain|cess|weed/i, en: 'Side drains, catch-water drains, and cess cleared' },
  { re: /గేజ్|లెవెల్|gauge|cross-level/i, en: 'Track gauge and cross-level verified within IRPWM limits' },
  { re: /పట్రోల్|తనిఖీ|patrol|inspect/i, en: 'Keyman / beat track patrolling completed' },
  { re: /వెల్డ్|పగులు|విరిగ|క్రాక్|crack|weld|fracture|pagil|virig/i, en: 'Rail / AT weld defect observed and protected per IRPWM Para 2.6.1' },
  { re: /తుప్పు|corros|rust|tuppu/i, en: 'Coastal rail foot/web corrosion checked and recorded' },
  { re: /లుక్\s*అవుట్|జెండా|విజిల్|హారన్|lookout|flag|jenda/i, en: 'Lookout man posted with red/green hand signals and warning whistle' },
];

/**
 * Deterministic offline Gang Diary formatter (unit-tested).
 * Parses English, Telugu script (తెలుగు), and colloquial romanized Telugu (Tenglish)
 * into official Indian Railways Gang Diary compliance format.
 */
export function buildOfflineDiaryEntry(rawText, meta = {}) {
  const clean = String(rawText || '').trim();
  const sentences = clean
    .replace(/కి\.మీ\.?/g, 'కి__మీ__')
    .replace(/(\d)\.(\d)/g, '$1__DOT__$2')
    .split(/[\n.;।,]+/)
    .map(s => s.replace(/కి__మీ__/g, 'కి.మీ').replace(/__DOT__/g, '.').trim())
    .filter(Boolean);

  const hasTelugu = /[\u0C00-\u0C7F]/.test(clean);
  const hasTenglish = /\b(chesamu|vesamu|pettamu|chusamu|marchemu|biginchamu|kanipinchindi|virigindi|pagilindi|kankara|patta|jenda|tuppu|digabadindi)\b/i.test(clean);
  const workBullets = [];

  if (hasTelugu || hasTenglish) {
    for (const rule of TELUGU_PHRASE_RULES) {
      if (rule.re.test(clean) && !workBullets.includes(`• ${rule.en}`)) {
        workBullets.push(`• ${rule.en}`);
      }
    }
    const kmMatch = clean.match(/(?:km|కి\.మీ\.?)\s*([0-9]+(?:[./][0-9]+)?)/i);
    if (kmMatch && workBullets.length > 0) {
      workBullets[0] = `${workBullets[0]} (near km ${kmMatch[1]})`;
    }
    for (const s of sentences) {
      if (!workBullets.some(b => b.includes(s))) workBullets.push(`• [Field note] ${s}`);
    }
  } else {
    for (const s of sentences) workBullets.push(`• ${s}`);
  }

  const section = meta.section || 'SKM–UPD, Vijayawada Div.';
  const dateISO = meta.date || getISTDateISO();
  const workDone = workBullets.length > 0
    ? workBullets.join('\n')
    : `• Routine track inspection and maintenance along ${section}`;

  const matHits = [];
  if (/erc|clip|pandrol|క్లిప్|పాండ్రోల్|ఫాస్టెనింగ్/i.test(clean)) matHits.push('ERC clips / fastenings');
  if (/liner|pad|rubber|లైనర్|రబ్బర్\s*ప్యాడ్|ప్యాడ్/i.test(clean)) matHits.push('GFN liners / rubber pads');
  if (/sleeper|psc|స్లీపర్/i.test(clean)) matHits.push('PSC sleepers');
  if (/ballast|బ్యాలస్ట్|కంకర|kankara/i.test(clean)) matHits.push('Track ballast');
  if (/fish\s?plate|bolt|joggle|clamp|ఫిష్\s*ప్లేట్|బోల్ట్|క్లాంప్|జోగుల్/i.test(clean)) matHits.push('Fishplates / bolts / clamps');
  if (/grease|oil|lubricat|గ్రీస్|ఆయిల్|నూనె/i.test(clean)) matHits.push('Graphite grease / lubricant');

  const explicitNoDefect = /\b(no\s+(?:rail\s+)?defects?|nil\s+defects?)\b|ఏ\s*లోపం\s*లేదు|లోపాలు\s*లేవు|లోపం\s*లేదు/i.test(clean);
  const defectHits = [];
  if (/fracture|broken rail|రైలు\s*విరిగ|పట్టా\s*విరిగ|ఫ్రాక్చర్|patta\s*virig/i.test(clean)) defectHits.push('Rail fracture reported (IRPWM Para 2.6.1)');
  if (/crack|weld|పగులు|క్రాక్|వెల్డ్|చీలిక|pagulu|cheelika/i.test(clean)) defectHits.push('Rail/weld crack observed (IRPWM Para 2.6.1)');
  if (/loose.*(?:clip|erc|pandrol)|missing.*(?:clip|erc|pandrol)|క్లిప్\s*లేదు|వదులుగా|లూజ్/i.test(clean)) defectHits.push('Loose/missing fastenings attended');
  if (/corros|rust|తుప్పు|tuppu/i.test(clean)) defectHits.push('Rail corrosion observed (IRPWM Para 2.7)');
  if (/broken\s*sleeper|cracked\s*sleeper|స్లీపర్\s*(?:పగిల|విరిగ)|sleeper\s*pagil/i.test(clean)) defectHits.push('Defective PSC sleeper noted (IRPWM Para 3.2)');
  if (/gauge|గేజ్/i.test(clean) && /variation|wide|tight|excess|fault|తేడా|ఎక్కువ/i.test(clean)) defectHits.push('Gauge variation checked');
  if (/void|pumping|sunken|గుంట|దిగబడి|digabad/i.test(clean)) defectHits.push('Ballast void / settlement attended');
  if (/buckle|kink|వంగింది|బక్లింగ్|vangindi/i.test(clean)) defectHits.push('Thermal alignment check performed');
  if (explicitNoDefect && defectHits.length === 0) defectHits.length = 0;

  const explicitSafety = /lookout|flag|banner|detonator|whistle|horn|jenda|లుక్\s*అవుట్|జెండా|విజిల్|హారన్|డిటోనేటర్|బ్యానర్/i.test(clean);
  const safetyMeasures = explicitSafety
    ? 'Lookout man posted with red/green hand signals and warning whistle as recorded'
    : 'Standard IRPWM lookout protocol, hand signals, and track clearance maintained';

  const defectsText = defectHits.length > 0 ? defectHits.join('; ') : 'Nil reported during shift';

  return {
    date: dateISO,
    section,
    workDone,
    materialsUsed: matHits.length > 0 ? matHits.join(', ') : 'Nil / Standard hand tools',
    defectsObserved: defectsText,
    defectsNoted: defectsText,
    safetyMeasures,
    safetyVerified: true,
    specialInstructions: defectHits.some(d => /fracture|crack/i.test(d))
      ? 'Inform PWI/SSE & impose 30 km/h caution order per IRPWM Para 2.6.1'
      : 'Follow PWI / SSE section instructions',
    remarks: `Logged offline on ${meta.dateStr || dateISO} (${meta.present ?? '—'}/${meta.total ?? '—'} workers).`,
    teluguSummary: defectHits.length > 0
      ? `నేటి గ్యాంగ్ డైరీ నమోదైంది — ${defectHits.length} లోపం గుర్తించబడింది (${meta.present ?? '—'}/${meta.total ?? '—'} హాజరు).`
      : `నేటి గ్యాంగ్ డైరీ నమోదు చేయబడింది (${meta.present ?? '—'}/${meta.total ?? '—'} కార్మికులు హాజరు).`,
    structuredBy: 'Offline Formatter',
  };
}

export function initGangDiary(els) {
  elements = els;
  syncAttendanceDefaults();
  updateDiaryHeader();
  renderQuickPhrases();
  syncSpeechLangUI();
  syncHistoryScopeUI();
  loadSavedEntries();
  updateAttendance();
  const overlay = document.getElementById('analyzing-overlay');
  if (overlay && !overlay.dataset.active) showAnalyzingOverlay(false);

  elements.btnRecord?.addEventListener('click', toggleRecording);
  elements.btnClearNotes?.addEventListener('click', clearNotes);
  elements.btnGenerateDiary?.addEventListener('click', generateDiaryEntry);
  elements.btnSaveDiary?.addEventListener('click', saveDiaryToDb);
  elements.btnShareDiary?.addEventListener('click', shareDiaryEntry);
  elements.btnExportDiary?.addEventListener('click', exportDiaryTxt);
  elements.attendanceInput?.addEventListener('input', updateAttendance);

  elements.btnAttMinus?.addEventListener('click', () => stepAttendance(-1));
  elements.btnAttPlus?.addEventListener('click', () => stepAttendance(+1));

  elements.speechLangToggle?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lang]');
    if (!btn) return;
    speechLang = btn.dataset.lang;
    syncSpeechLangUI();
  });

  elements.diaryHistoryScope?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn) return;
    historyScope = btn.dataset.scope;
    syncHistoryScopeUI();
    loadSavedEntries();
  });

  window.addEventListener('railraksha:settings-updated', () => {
    syncAttendanceDefaults();
    updateDiaryHeader();
    updateAttendance();
  });
}

function setHidden(el, hide) {
  if (!el) return;
  const hidden = Boolean(hide);
  el.hidden = hidden;
  el.classList.toggle('hidden', hidden);
}

function syncSpeechLangUI() {
  elements.speechLangToggle?.querySelectorAll('[data-lang]').forEach(b => {
    const active = b.dataset.lang === speechLang;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  if (elements.voiceSub && !isRecording) {
    elements.voiceSub.textContent = speechLang === 'te-IN'
      ? 'తెలుగులో మాట్లాడండి — Tap Record to dictate'
      : 'Speak in English — Tap Record to dictate';
  }
}

function syncHistoryScopeUI() {
  elements.diaryHistoryScope?.querySelectorAll('[data-scope]').forEach(b => {
    const active = b.dataset.scope === historyScope;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
}

function renderQuickPhrases() {
  const wrap = elements.diaryPhraseChips;
  if (!wrap) return;
  wrap.innerHTML = QUICK_PHRASES.map(p => {
    const label = typeof p === 'string' ? p : p.label;
    const text = typeof p === 'string' ? p : p.text;
    const isTe = /[\u0C00-\u0C7F]/.test(label);
    return `<button type="button" class="phrase-chip chip-btn" ${isTe ? 'lang="te"' : ''} data-phrase="${escapeHtml(text)}">+ ${escapeHtml(label)}</button>`;
  }).join('');
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-phrase]');
    if (!btn || !elements.notesInput) return;
    const cur = elements.notesInput.value.trim();
    elements.notesInput.value = cur ? `${cur}. ${btn.dataset.phrase}` : btn.dataset.phrase;
    elements.notesInput.focus();
  });
}

function getGangStrength() {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || '');
  return Math.max(1, parseInt(cfg('gang_strength') || '25', 10) || 25);
}

function syncAttendanceDefaults() {
  const total = getGangStrength();
  if (elements.attendanceInput) {
    elements.attendanceInput.max = String(total);
    if (!elements.attendanceInput.dataset.touched) {
      elements.attendanceInput.value = String(total);
    }
  }
}

function stepAttendance(delta) {
  if (!elements.attendanceInput) return;
  const total = getGangStrength();
  const cur = parseInt(elements.attendanceInput.value || total, 10) || 0;
  elements.attendanceInput.value = String(Math.max(0, Math.min(total, cur + delta)));
  updateAttendance();
}

function updateDiaryHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  if (elements.diaryDateText) elements.diaryDateText.textContent = dateStr;
  const gangNo = localStorage.getItem('gang_no') || 'Gang —';
  const mateName = localStorage.getItem('mate_name') || 'Mate —';
  const section = localStorage.getItem('section') || 'SKM–UPD Section';
  if (elements.diaryGangInfo) {
    const stA = window.getConfig?.('work_station_a') || 'SKM';
    const stB = window.getConfig?.('work_station_b') || 'UPD';
    const rawGang = (localStorage.getItem('gang_no') || '').trim();
    elements.diaryGangInfo.textContent = rawGang ? `${rawGang} · ${stA}–${stB}` : `${stA}–${stB}`;
  }
}

function updateAttendance() {
  const total = getGangStrength();
  const raw = parseInt(elements.attendanceInput?.value ?? total, 10);
  const present = Math.max(0, Math.min(total, Number.isFinite(raw) ? raw : total));
  if (elements.attendanceInput) {
    elements.attendanceInput.dataset.touched = '1';
    elements.attendanceInput.value = String(present);
  }
  const absent = total - present;
  if (elements.attendanceCount) elements.attendanceCount.innerHTML = `${present}<span>/${total}</span>`;
  if (elements.attendanceBar) elements.attendanceBar.style.width = `${(present / total) * 100}%`;
  if (elements.attendanceSub) {
    elements.attendanceSub.textContent = absent > 0
      ? `${absent} worker${absent > 1 ? 's' : ''} absent`
      : 'Full gang present';
  }
}

function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

function startRecording() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    showToast('Speech recognition unavailable on this device — tap a Telugu/English chip or type below', 'warn');
    elements.notesInput?.focus();
    return;
  }

  const existing = elements.notesInput?.value?.trim() || '';
  finalTranscript = existing ? `${existing} ` : '';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = speechLang;
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isRecording = true;
    updateRecordBtn(true);
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript.trim() + ' ';
      else interim += r[0].transcript;
    }
    if (elements.notesInput) {
      elements.notesInput.value = (finalTranscript + interim).trim();
    }
  };

  recognition.onerror = (event) => {
    isRecording = false;
    updateRecordBtn(false);
    if (event.error === 'network' || event.error === 'service-not-allowed') {
      showToast('Voice dictation requires internet — tap a Telugu/English sample chip or type below', 'warn');
      elements.notesInput?.focus();
    } else if (event.error === 'not-allowed') {
      showToast('Microphone permission denied — tap a sample phrase or type below', 'warn');
      elements.notesInput?.focus();
    } else if (event.error === 'audio-capture' || event.error === 'language-not-supported') {
      showToast('No active microphone found — tap a Telugu/English sample chip or type below', 'warn');
      elements.notesInput?.focus();
    } else if (event.error === 'no-speech') {
      showToast('No speech detected — tap Record again or use a sample phrase', 'info');
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      setTimeout(() => { if (isRecording) { try { recognition.start(); } catch { isRecording = false; updateRecordBtn(false); } } }, 120);
    } else {
      updateRecordBtn(false);
      if (elements.notesInput?.value?.trim()) {
        showToast('Dictation captured — review or tap Format Gang Diary', 'ok');
      }
    }
  };

  try {
    recognition.start();
  } catch {
    isRecording = false;
    updateRecordBtn(false);
    showToast('Microphone unavailable — tap a Telugu/English sample chip or type below', 'warn');
  }
}

function stopRecording() {
  isRecording = false;
  try { recognition?.stop(); } catch {}
  updateRecordBtn(false);
}

function updateRecordBtn(recording) {
  elements.btnRecord?.classList.toggle('recording', recording);
  if (elements.btnRecordLabel) elements.btnRecordLabel.textContent = recording ? 'Stop Recording' : 'Record Voice';
  if (elements.voiceTitle) elements.voiceTitle.textContent = recording ? 'Listening...' : 'Daily Field Notes';
  if (elements.voiceSub) {
    elements.voiceSub.textContent = recording
      ? `Dictating in ${speechLang === 'te-IN' ? 'Telugu' : 'English'} — tap Stop when done`
      : (speechLang === 'te-IN' ? 'తెలుగులో మాట్లాడండి — Tap Record to dictate' : 'Speak in English — Tap Record to dictate');
  }
  if (elements.micEmoji) {
    elements.micEmoji.innerHTML = recording ? Icons.alertCircle(18, '#C81E1E') : Icons.mic(18, 'currentColor');
  }
}

function clearNotes() {
  if (isRecording) stopRecording();
  finalTranscript = '';
  if (elements.notesInput) elements.notesInput.value = '';
  setHidden(elements.diaryEntryCard, true);
}

async function generateDiaryEntry() {
  if (isRecording) stopRecording();
  const text = elements.notesInput?.value?.trim() || '';
  if (!text) {
    showToast("Record, tap a phrase, or type today's work details first", "warn");
    elements.notesInput?.focus();
    return;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  const total = getGangStrength();
  const parsedAtt = parseInt(elements.attendanceInput?.value ?? '', 10);
  const present = Number.isFinite(parsedAtt) ? parsedAtt : total;
  const gangNo = localStorage.getItem('gang_no') || '—';
  const mateName = localStorage.getItem('mate_name') || '—';
  const section = localStorage.getItem('section') || 'SKM–UPD, Vijayawada Div.';
  const dateISO = getISTDateISO();
  const meta = { date: dateISO, dateStr, gangNo, mateName, section, present, total };

  // Immediate offline path if browser reports offline
  if (navigator.onLine === false) {
    const offlineEntry = buildOfflineDiaryEntry(text, meta);
    displayDiaryEntry(offlineEntry, meta, text);
    showToast('Formatted offline — ready to save in IndexedDB', 'ok');
    return;
  }

  showAnalyzingOverlay(true, 'Structuring Gang Diary', 'Formatting Indian Railways shift entry...');

  const prompt = `You are formatting an official Indian Railways Gang Diary compliance entry for a Gang Mate (Track Maintainer Grade-I).
The field notes may be in colloquial Telugu script, romanized Telugu (Tenglish), or English. Translate any Telugu observations accurately into official Indian Railways IRPWM terminology.

Gang Details:
- Date: ${dateStr} (${dateISO})
- Gang: ${gangNo} | Mate: ${mateName}
- Section: ${section}
- Attendance: ${present}/${total} workers present

Field Notes (Telugu / Tenglish / English):
"${text}"

Return ONLY this JSON object:
{
  "workDone": "Itemized bullet points starting with • in clear official Indian Railways terminology",
  "materialsUsed": "Materials/fittings used (e.g. ERC/Pandrol clips, PSC sleepers, GFN liners, ballast) or 'Nil'",
  "defectsObserved": "Track defects noticed (with IRPWM reference if applicable) or 'Nil'",
  "safetyMeasures": "Safety precautions taken (e.g. Lookout man posted, red/green hand signals & banner flags maintained)",
  "safetyVerified": true,
  "specialInstructions": "Instructions from PWI/SSE/AEN or 'Nil'",
  "remarks": "Brief official remark",
  "teluguSummary": "One-sentence summary in Telugu script"
}`;

  try {
    const entry = await callAI({ prompt });
    if (!entry || typeof entry !== 'object' || !entry.workDone) {
      throw new Error('Invalid AI format');
    }
    showAnalyzingOverlay(false);
    displayDiaryEntry({
      ...entry,
      date: dateISO,
      section,
      defectsNoted: entry.defectsNoted || entry.defectsObserved || 'Nil',
      safetyVerified: entry.safetyVerified !== false,
      structuredBy: 'Cloud AI',
    }, meta, text);
    showToast('Gang Diary formatted with AI', 'ok');
  } catch {
    showAnalyzingOverlay(false);
    const offlineEntry = buildOfflineDiaryEntry(text, meta);
    displayDiaryEntry(offlineEntry, meta, text);
    showToast('Cloud AI unavailable — structured cleanly offline', 'warn');
  } finally {
    showAnalyzingOverlay(false);
  }
}

function displayDiaryEntry(entry, meta, rawText) {
  if (!elements.diaryEntryCard) return;
  setHidden(elements.diaryEntryCard, false);

  if (elements.entryDate) elements.entryDate.textContent = `${meta.dateStr} · ${entry.structuredBy || 'Formatted'}`;
  if (elements.entryTime) {
    elements.entryTime.textContent = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const defectsVal = entry.defectsObserved || entry.defectsNoted || 'Nil';
  const safetyVal = entry.safetyMeasures || 'Standard IRPWM lookout protocol maintained';

  setText(elements.entryGang, `${meta.gangNo} · ${meta.mateName} · ${meta.section}`);
  setText(elements.entryAttendance, `${meta.present}/${meta.total} workers present`);
  setText(elements.entryWorkDone, entry.workDone);
  setText(elements.entryMaterials, entry.materialsUsed);
  setText(elements.entryDefects, defectsVal);
  setText(elements.entrySafety, safetyVal);
  setText(elements.entrySpecial, entry.specialInstructions);
  setText(elements.entryRemarks, entry.remarks);
  setText(elements.entryTelugu, entry.teluguSummary || entry.teleguSummary || '—');

  elements.diaryEntryCard.dataset.entry = JSON.stringify({
    ...entry,
    defectsObserved: defectsVal,
    defectsNoted: defectsVal,
    safetyMeasures: safetyVal,
    safetyVerified: entry.safetyVerified ?? true,
    teluguSummary: entry.teluguSummary || entry.teleguSummary || '',
    ...meta,
    rawTranscription: rawText,
    date: meta.date || getISTDateISO(),
    timestamp: new Date().toISOString(),
  });

  elements.diaryEntryCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setText(el, text) { if (el) el.textContent = text || '—'; }

function formatEntryAsText(e) {
  return [
    `GANG DIARY — ${e.dateStr || e.date}`,
    `Gang: ${e.gangNo || '—'} | Mate: ${e.mateName || '—'}`,
    `Section: ${e.section || 'SKM–UPD'}`,
    `Attendance: ${e.present ?? '—'}/${e.total ?? '—'} workers`,
    '---',
    'WORK DONE:',
    e.workDone || e.rawTranscription || '—',
    `MATERIALS: ${e.materialsUsed || 'Nil'}`,
    `DEFECTS: ${e.defectsObserved || 'Nil'}`,
    `SAFETY: ${e.safetyMeasures || 'Standard lookout'}`,
    `INSTRUCTIONS: ${e.specialInstructions || 'Nil'}`,
    `REMARKS: ${e.remarks || '—'}`,
  ].join('\n');
}

async function saveDiaryToDb() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  await saveDiaryEntry(JSON.parse(card.dataset.entry));
  showToast('Gang Diary saved offline (IndexedDB)', 'ok');
  loadSavedEntries();
}

async function shareDiaryEntry() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  const e = JSON.parse(card.dataset.entry);
  const text = formatEntryAsText(e);

  if (navigator.share) {
    try { await navigator.share({ title: `Gang Diary — ${e.dateStr}`, text }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Diary entry copied to clipboard', 'ok');
  } catch {
    showToast('Clipboard unavailable — save offline instead', 'warn');
  }
}

async function loadSavedEntries() {
  const todayIST = getISTDateISO();
  const entries = await getDiaryEntries(historyScope === 'today' ? todayIST : null);

  if (elements.todayEntriesCount) {
    const label = historyScope === 'today' ? 'today (IST)' : 'total';
    elements.todayEntriesCount.textContent = entries.length > 0
      ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} ${label}`
      : `No entries ${label}`;
  }

  if (!elements.savedEntriesList) return;
  if (entries.length === 0) {
    elements.savedEntriesList.innerHTML = `
      <div class="empty-state">
        <div class="es-title">No saved diary entries</div>
        <div class="es-sub">Formatted entries save locally in IndexedDB and persist offline.</div>
      </div>`;
    return;
  }

  elements.savedEntriesList.innerHTML = '';
  entries.slice(0, 20).forEach(e => {
    const card = document.createElement('div');
    card.className = 'saved-diary-item';
    const timeStr = new Date(e.createdAt || Date.now()).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
    card.innerHTML = `
      <div class="saved-diary-meta">
        <div>
          <strong>${escapeHtml(e.dateStr || e.date)}</strong>
          <span class="sdi-sub">${e.present ?? '—'}/${e.total ?? '—'} present · ${timeStr} IST</span>
        </div>
        <div class="hi-actions">
          <button type="button" class="icon-btn-sm" data-action="copy">Copy</button>
          <button type="button" class="icon-btn-sm icon-btn-danger" data-action="delete">Del</button>
        </div>
      </div>
      <div class="saved-diary-body">${escapeHtml(e.workDone || e.rawTranscription || '')}</div>
      ${e.teluguSummary ? `<div class="saved-diary-te" lang="te">${escapeHtml(e.teluguSummary)}</div>` : ''}`;

    card.querySelector('[data-action="copy"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(formatEntryAsText(e));
        showToast('Entry copied to clipboard', 'ok');
      } catch {
        showToast('Unable to copy', 'warn');
      }
    });
    card.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      await deleteDiaryEntry(e.id);
      loadSavedEntries();
      showToast('Diary entry deleted', 'info');
    });

    elements.savedEntriesList.appendChild(card);
  });
}

async function exportDiaryTxt() {
  const entries = await getDiaryEntries();
  if (entries.length === 0) {
    showToast('No diary entries to export', 'warn');
    return;
  }
  const content = entries.map(formatEntryAsText).join('\n\n==============================\n\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `railraksha-gang-diary-${getISTDateISO()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Exported ${entries.length} diary entry(ies)`, 'ok');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function showAnalyzingOverlay(show, title = '', sub = '') {
  const overlay = document.getElementById('analyzing-overlay');
  if (!overlay) return;
  if (show) overlay.dataset.active = '1';
  else delete overlay.dataset.active;
  setHidden(overlay, !show);
  overlay.setAttribute('aria-hidden', String(!show));
  if (show) {
    const t = overlay.querySelector('#analyzing-text, .analyzing-text');
    const s = overlay.querySelector('#analyzing-sub, .analyzing-sub');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
  }
}

function showToast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { msg, type } }));
}
