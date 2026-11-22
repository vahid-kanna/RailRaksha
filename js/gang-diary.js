/**
 * RailRaksha — Voice & Text Gang Diary (gang-diary.js)
 * Converts spoken or typed Telugu/English notes into a structured
 * Indian Railways Gang Diary entry with offline IndexedDB persistence.
 */

import { saveDiaryEntry, getDiaryEntries } from './db.js';
import { callAI } from './ai-engine.js';
import { Icons } from './icons.js';

let isRecording = false;
let recognition = null;
let transcriptionText = "";
let finalTranscript = "";
let elements = {};

export function initGangDiary(els) {
  elements = els;
  syncAttendanceDefaults();
  updateDiaryHeader();
  loadTodayEntries();
  updateAttendance();

  elements.btnRecord?.addEventListener("click", toggleRecording);
  elements.btnTypeDiary?.addEventListener("click", openManualInput);
  elements.btnGenerateDiary?.addEventListener("click", generateDiaryEntry);
  elements.btnSaveDiary?.addEventListener("click", saveDiaryToDb);
  elements.btnShareDiary?.addEventListener("click", shareDiaryEntry);
  elements.attendanceInput?.addEventListener("input", updateAttendance);
}

function getGangStrength() {
  const cfg = window.getConfig || ((k) => localStorage.getItem(k) || "");
  return Math.max(1, parseInt(cfg("gang_strength") || "25", 10) || 25);
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

function updateDiaryHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  if (elements.diaryDateText) elements.diaryDateText.textContent = dateStr;
  const gangNo = localStorage.getItem("gang_no") || "Gang —";
  const mateName = localStorage.getItem("mate_name") || "Mate —";
  const section = localStorage.getItem("section") || "SKM–UPD Section";
  if (elements.diaryGangInfo) elements.diaryGangInfo.textContent = `${gangNo} · ${mateName} · ${section}`;
}

function updateAttendance() {
  const total = getGangStrength();
  const raw = parseInt(elements.attendanceInput?.value ?? total, 10);
  const present = Math.max(0, Math.min(total, Number.isFinite(raw) ? raw : total));
  if (elements.attendanceInput) {
    elements.attendanceInput.dataset.touched = "1";
    elements.attendanceInput.value = String(present);
  }
  const absent = total - present;
  if (elements.attendanceCount) elements.attendanceCount.innerHTML = `${present}<span>/${total} workers</span>`;
  if (elements.attendanceBar) elements.attendanceBar.style.width = `${(present / total) * 100}%`;
  if (elements.attendanceSub) {
    elements.attendanceSub.textContent = absent > 0
      ? `${absent} worker${absent > 1 ? "s" : ""} absent today`
      : "Full attendance today";
  }
}

function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

function startRecording() {
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    showToast("Voice recognition unavailable in this browser — type your work details below", "warn");
    openManualInput();
    return;
  }
  finalTranscript = "";
  transcriptionText = "";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = "te-IN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isRecording = true;
    updateRecordBtn(true);
    if (elements.transcriptionCard) elements.transcriptionCard.classList.add("visible");
    if (elements.transcriptionText) {
      elements.transcriptionText.textContent = "Listening in Telugu / English… tap stop when finished.";
    }
  };

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) finalTranscript += r[0].transcript + " ";
      else interim += r[0].transcript;
    }
    transcriptionText = finalTranscript;
    if (elements.transcriptionText) {
      elements.transcriptionText.textContent = (transcriptionText + (interim ? ` ${interim}` : "")).trim();
    }
  };

  recognition.onerror = (event) => {
    if (event.error === "network" || event.error === "service-not-allowed") {
      isRecording = false;
      updateRecordBtn(false);
      showToast("Voice requires internet — switched to manual typing", "warn");
      openManualInput();
    } else if (event.error === "not-allowed") {
      isRecording = false;
      updateRecordBtn(false);
      showToast("Microphone permission denied", "warn");
    }
  };

  recognition.onend = () => {
    if (isRecording) {
      setTimeout(() => { if (isRecording) { try { recognition.start(); } catch {} } }, 120);
    } else {
      updateRecordBtn(false);
      if (finalTranscript.trim()) {
        showToast("Recording complete — tap Generate Gang Diary", "ok");
        if (elements.btnGenerateDiary) elements.btnGenerateDiary.style.display = "flex";
      }
    }
  };

  recognition.start();
}

function stopRecording() {
  isRecording = false;
  try { recognition?.stop(); } catch {}
  updateRecordBtn(false);
  transcriptionText = finalTranscript;
  if (finalTranscript.trim()) {
    showToast("Recording stopped — tap Generate Gang Diary", "ok");
    if (elements.btnGenerateDiary) elements.btnGenerateDiary.style.display = "flex";
  }
}

function updateRecordBtn(recording) {
  elements.btnRecord?.classList.toggle("recording", recording);
  if (elements.voiceTitle) elements.voiceTitle.textContent = recording ? "Stop Recording" : "Record Today's Work";
  if (elements.voiceSub) elements.voiceSub.textContent = recording ? "Listening… speak in Telugu or English" : "తెలుగులో మాట్లాడండి — Tap to speak";
  if (elements.micEmoji) elements.micEmoji.innerHTML = recording ? Icons.alertCircle(20, '#EF4444') : Icons.mic(20, '#E2E8F0');
}

function openManualInput() {
  if (isRecording) stopRecording();
  if (elements.transcriptionCard) elements.transcriptionCard.classList.add("visible");
  if (elements.transcriptionText) {
    const existing = transcriptionText.trim();
    elements.transcriptionText.innerHTML = `<textarea id="manual-work-input" class="manual-diary-textarea" placeholder="Type today's work details in Telugu or English (e.g., Packed 18 sleepers between km 292–293, tightened 30 ERC clips, lookout posted)..." rows="4"></textarea>`;
    const ta = document.getElementById("manual-work-input");
    if (ta) {
      ta.value = existing;
      ta.focus();
      ta.addEventListener("input", () => { transcriptionText = ta.value; });
    }
    if (elements.btnGenerateDiary) elements.btnGenerateDiary.style.display = "flex";
  }
}

async function generateDiaryEntry() {
  const ta = document.getElementById("manual-work-input");
  if (ta) transcriptionText = ta.value;
  const text = transcriptionText.trim();
  if (!text) {
    showToast("Record or type today's work details first", "warn");
    return;
  }

  showAnalyzingOverlay(true, "Structuring Gang Diary", "Formatting official Indian Railways entry...");

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
  const total = getGangStrength();
  const present = parseInt(elements.attendanceInput?.value || total, 10);
  const gangNo = localStorage.getItem("gang_no") || "—";
  const mateName = localStorage.getItem("mate_name") || "—";
  const section = localStorage.getItem("section") || "SKM–UPD, Vijayawada Division";

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
    if (!entry || typeof entry !== "object" || !entry.workDone) {
      throw new Error("Invalid response format from AI");
    }
    showAnalyzingOverlay(false);
    displayDiaryEntry(entry, { dateStr, gangNo, mateName, section, present, total });
    showToast("Gang Diary formatted", "ok");
  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("Generation failed: " + err.message, "error");
  }
}

function displayDiaryEntry(entry, meta) {
  if (!elements.diaryEntryCard) return;
  elements.diaryEntryCard.classList.add("visible");

  if (elements.entryDate) elements.entryDate.textContent = `Gang Diary — ${meta.dateStr}`;
  if (elements.entryTime) elements.entryTime.textContent = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  setText(elements.entryGang, `${meta.gangNo} · ${meta.mateName} · ${meta.section}`);
  setText(elements.entryAttendance, `${meta.present}/${meta.total} workers present`);
  setText(elements.entryWorkDone, entry.workDone);
  setText(elements.entryMaterials, entry.materialsUsed);
  setText(elements.entryDefects, entry.defectsObserved);
  setText(elements.entrySafety, entry.safetyMeasures);
  setText(elements.entrySpecial, entry.specialInstructions);
  setText(elements.entryRemarks, entry.remarks);
  setText(elements.entryTelugu, entry.teluguSummary || entry.teleguSummary || "—");

  elements.diaryEntryCard.dataset.entry = JSON.stringify({
    ...entry,
    teluguSummary: entry.teluguSummary || entry.teleguSummary || "",
    ...meta,
    rawTranscription: transcriptionText,
    timestamp: new Date().toISOString(),
  });

  if (elements.btnSaveDiary) elements.btnSaveDiary.style.display = "flex";
  if (elements.btnShareDiary) elements.btnShareDiary.style.display = "flex";
}

function setText(el, text) { if (el) el.textContent = text || "—"; }

async function saveDiaryToDb() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  await saveDiaryEntry(JSON.parse(card.dataset.entry));
  showToast("Diary entry saved offline", "ok");
  loadTodayEntries();
}

async function shareDiaryEntry() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  const e = JSON.parse(card.dataset.entry);
  const text = [
    `GANG DIARY — ${e.dateStr}`,
    `Gang: ${e.gangNo} | Mate: ${e.mateName}`,
    `Section: ${e.section}`,
    `Attendance: ${e.present}/${e.total} workers`,
    "---",
    "WORK DONE:",
    e.workDone,
    `MATERIALS: ${e.materialsUsed}`,
    `DEFECTS: ${e.defectsObserved}`,
    `SAFETY: ${e.safetyMeasures}`,
    `INSTRUCTIONS: ${e.specialInstructions}`,
    `REMARKS: ${e.remarks}`,
  ].join("\n");

  if (navigator.share) {
    try { await navigator.share({ title: `Gang Diary — ${e.dateStr}`, text }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Diary copied to clipboard", "ok");
  } catch {
    showToast("Could not copy — save locally instead", "warn");
  }
}

async function loadTodayEntries() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = await getDiaryEntries(today);
  if (elements.todayEntriesCount) {
    elements.todayEntriesCount.textContent = entries.length > 0
      ? `${entries.length} entr${entries.length > 1 ? "ies" : "y"} saved today`
      : "No entries saved today";
  }
  if (elements.savedEntriesList) {
    elements.savedEntriesList.innerHTML = entries.map(e => `
      <div class="saved-diary-item">
        <div class="saved-diary-meta">
          <strong>${escapeHtml(e.dateStr || e.date)}</strong>
          <span>${e.present ?? "—"}/${e.total ?? "—"} present · ${new Date(e.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div class="saved-diary-body">${escapeHtml(e.workDone || e.rawTranscription || "")}</div>
      </div>
    `).join("");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
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
