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
  'Packed sleepers & dressed ballast',
  'Tightened ERC clips & replaced liners',
  'Lookout man posted with red/green flags',
  'Checked gauge & cross-level',
  'Lubricated rail joints & SEJ gaps',
  'Cleared side drains & catch-water drains',
];

/**
 * Deterministic offline Gang Diary formatter (unit-tested).
 * Ensures a Gang Mate in a zero-signal dead zone still gets a clean, official-format entry.
 */
export function buildOfflineDiaryEntry(rawText, meta = {}) {
  const clean = String(rawText || '').trim();
  const sentences = clean
    .split(/[\n.;।]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const workDone = sentences.length > 0
    ? sentences.map(s => `• ${s}`).join('\n')
    : `• Routine track inspection and maintenance along ${meta.section || 'assigned beat'}`;

  const lower = clean.toLowerCase();
  const matHits = [];
  if (/erc|clip|pandrol/i.test(lower)) matHits.push('ERC clips / fastenings');
  if (/liner|pad|rubber/i.test(lower)) matHits.push('GFN liners / rubber pads');
  if (/sleeper|psc/i.test(lower)) matHits.push('PSC sleepers');
  if (/ballast/i.test(lower)) matHits.push('Track ballast');
  if (/fish\s?plate|bolt|joggle|clamp/i.test(lower)) matHits.push('Fishplates / bolts / clamps');
  if (/grease|oil|lubricat/i.test(lower)) matHits.push('Graphite grease / lubricant');

  const defectHits = [];
  if (/fracture|broken rail/i.test(lower)) defectHits.push('Rail fracture reported');
  if (/crack|weld/i.test(lower)) defectHits.push('Rail/weld crack observed');
  if (/loose|missing.*clip|erc/i.test(lower)) defectHits.push('Loose/missing fastenings attended');
  if (/gauge/i.test(lower)) defectHits.push('Gauge variation checked');
  if (/void|pumping|sunken/i.test(lower)) defectHits.push('Ballast void / settlement attended');
  if (/buckle|kink/i.test(lower)) defectHits.push('Thermal alignment check performed');

  const safetyParts = [];
  if (/lookout|flag|banner|detonator|whistle|horn/i.test(lower)) {
    safetyParts.push('Lookout man posted with red/green hand signals and warning whistle as recorded');
  } else {
    safetyParts.push('Standard IRPWM lookout protocol, hand signals, and track clearance maintained');
  }

  return {
    workDone,
    materialsUsed: matHits.length > 0 ? matHits.join(', ') : 'Nil / Standard hand tools',
    defectsObserved: defectHits.length > 0 ? defectHits.join('; ') : 'Nil reported during shift',
    safetyMeasures: safetyParts.join('. '),
    specialInstructions: 'Follow PWI / SSE section instructions',
    remarks: `Logged offline on ${meta.dateStr || getISTDateISO()} (${meta.present ?? '—'}/${meta.total ?? '—'} workers).`,
    teluguSummary: `నేటి గ్యాంగ్ డైరీ నమోదు చేయబడింది (${meta.present ?? '—'}/${meta.total ?? '—'} కార్మికులు హాజరు).`,
    structuredBy: 'Offline Formatter',
  };
}

export function initGangDiary(els) {
  elements = els;
  syncAttendanceDefaults();
  updateDiaryHeader();
  renderQuickPhrases();
  loadSavedEntries();
  updateAttendance();

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
    elements.speechLangToggle.querySelectorAll('[data-lang]').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === speechLang);
      b.setAttribute('aria-pressed', String(b.dataset.lang === speechLang));
    });
    if (elements.voiceSub && !isRecording) {
      elements.voiceSub.textContent = speechLang === 'te-IN'
        ? 'తెలుగులో మాట్లాడండి — Tap Record to dictate'
        : 'Speak in English — Tap Record to dictate';
    }
  });

  elements.diaryHistoryScope?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-scope]');
    if (!btn) return;
    historyScope = btn.dataset.scope;
    elements.diaryHistoryScope.querySelectorAll('[data-scope]').forEach(b => {
      b.classList.toggle('active', b.dataset.scope === historyScope);
    });
    loadSavedEntries();
  });

  window.addEventListener('railraksha:settings-updated', () => {
    syncAttendanceDefaults();
    updateDiaryHeader();
    updateAttendance();
  });
}

function renderQuickPhrases() {
  const wrap = elements.diaryPhraseChips;
  if (!wrap) return;
  wrap.innerHTML = QUICK_PHRASES.map(p =>
    `<button type="button" class="chip-btn" data-phrase="${escapeHtml(p)}">+ ${escapeHtml(p)}</button>`
  ).join('');
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
  if (elements.diaryGangInfo) elements.diaryGangInfo.textContent = `${gangNo} · ${mateName} · ${section}`;
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
    showToast('Speech recognition unavailable here — type notes directly below', 'warn');
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
    if (event.error === 'network' || event.error === 'service-not-allowed') {
      isRecording = false;
      updateRecordBtn(false);
      showToast('Voice dictation requires internet — type or tap phrases below', 'warn');
      elements.notesInput?.focus();
    } else if (event.error === 'not-allowed') {
      isRecording = false;
      updateRecordBtn(false);
      showToast('Microphone permission denied', 'warn');
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      setTimeout(() => { if (isRecording) { try { recognition.start(); } catch {} } }, 120);
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
    elements.micEmoji.innerHTML = recording ? Icons.alertCircle(18, '#EF4444') : Icons.mic(18, 'currentColor');
  }
}

function clearNotes() {
  if (isRecording) stopRecording();
  finalTranscript = '';
  if (elements.notesInput) elements.notesInput.value = '';
  if (elements.diaryEntryCard) elements.diaryEntryCard.hidden = true;
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
  const present = parseInt(elements.attendanceInput?.value || total, 10);
  const gangNo = localStorage.getItem('gang_no') || '—';
  const mateName = localStorage.getItem('mate_name') || '—';
  const section = localStorage.getItem('section') || 'SKM–UPD, Vijayawada Div.';
  const meta = { dateStr, gangNo, mateName, section, present, total };

  // Immediate offline path if browser reports offline
  if (navigator.onLine === false) {
    const offlineEntry = buildOfflineDiaryEntry(text, meta);
    displayDiaryEntry(offlineEntry, meta, text);
    showToast('Formatted offline — ready to save in IndexedDB', 'ok');
    return;
  }

  showAnalyzingOverlay(true, 'Structuring Gang Diary', 'Formatting Indian Railways shift entry...');

  const prompt = `You are formatting an official Indian Railways Gang Diary entry for a Gang Mate (Track Maintainer Grade-I).

Gang Details:
- Date: ${dateStr}
- Gang: ${gangNo} | Mate: ${mateName}
- Section: ${section}
- Attendance: ${present}/${total} workers present

Field Notes (Telugu/English):
"${text}"

Return ONLY this JSON object:
{
  "workDone": "Itemized bullet points starting with • in clear Indian Railways terminology",
  "materialsUsed": "Materials/fittings used or 'Nil'",
  "defectsObserved": "Track defects noticed or 'Nil'",
  "safetyMeasures": "Safety precautions taken (e.g. Lookout man posted, banner flag & hand signals maintained)",
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
    displayDiaryEntry({ ...entry, structuredBy: 'Cloud AI' }, meta, text);
    showToast('Gang Diary formatted with AI', 'ok');
  } catch {
    showAnalyzingOverlay(false);
    const offlineEntry = buildOfflineDiaryEntry(text, meta);
    displayDiaryEntry(offlineEntry, meta, text);
    showToast('Cloud AI unavailable — structured cleanly offline', 'warn');
  }
}

function displayDiaryEntry(entry, meta, rawText) {
  if (!elements.diaryEntryCard) return;
  elements.diaryEntryCard.hidden = false;

  if (elements.entryDate) elements.entryDate.textContent = `${meta.dateStr} · ${entry.structuredBy || 'Formatted'}`;
  if (elements.entryTime) {
    elements.entryTime.textContent = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  setText(elements.entryGang, `${meta.gangNo} · ${meta.mateName} · ${meta.section}`);
  setText(elements.entryAttendance, `${meta.present}/${meta.total} workers present`);
  setText(elements.entryWorkDone, entry.workDone);
  setText(elements.entryMaterials, entry.materialsUsed);
  setText(elements.entryDefects, entry.defectsObserved);
  setText(elements.entrySafety, entry.safetyMeasures);
  setText(elements.entrySpecial, entry.specialInstructions);
  setText(elements.entryRemarks, entry.remarks);
  setText(elements.entryTelugu, entry.teluguSummary || entry.teleguSummary || '—');

  elements.diaryEntryCard.dataset.entry = JSON.stringify({
    ...entry,
    teluguSummary: entry.teluguSummary || entry.teleguSummary || '',
    ...meta,
    rawTranscription: rawText,
    date: getISTDateISO(),
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
