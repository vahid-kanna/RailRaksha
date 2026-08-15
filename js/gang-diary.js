/**
 * RailRaksha — Voice-to-Gang-Diary (gang-diary.js)
 * Converts spoken Telugu/English input → structured gang diary entry
 * using Groq AI (qwen/qwen3.6-27b).
 */

import { saveDiaryEntry, getDiaryEntries } from './db.js';
import { callAI, getAISettings } from './ai-engine.js';
import { Icons } from './icons.js';

let isRecording = false;
let recognition = null;
let transcriptionText = "";
let elements = {};

export function initGangDiary(els) {
  elements = els;
  updateDiaryHeader();
  loadTodayEntries();
  updateAttendance();

  elements.btnRecord?.addEventListener("click", toggleRecording);
  elements.btnGenerateDiary?.addEventListener("click", generateDiaryEntry);
  elements.btnSaveDiary?.addEventListener("click", saveDiaryToDb);
  elements.btnShareDiary?.addEventListener("click", shareDiaryEntry);
  elements.attendanceInput?.addEventListener("input", updateAttendance);
}

// ── Date Header ──────────────────────────────────────────────────────────────

function updateDiaryHeader() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  if (elements.diaryDateText) elements.diaryDateText.textContent = dateStr;
  const gangNo = localStorage.getItem("gang_no") || "—";
  const mateName = localStorage.getItem("mate_name") || "—";
  if (elements.diaryGangInfo) elements.diaryGangInfo.textContent = `Gang ${gangNo} · ${mateName} · SKM Section`;
}

// ── Attendance ───────────────────────────────────────────────────────────────

function updateAttendance() {
  const total = parseInt(localStorage.getItem("gang_strength") || "25");
  const present = parseInt(elements.attendanceInput?.value || total);
  const absent = total - present;
  if (elements.attendanceCount) elements.attendanceCount.innerHTML = `${present}<span>/${total} workers</span>`;
  const pct = (present / total) * 100;
  if (elements.attendanceBar) elements.attendanceBar.style.width = `${pct}%`;
  if (elements.attendanceSub) {
  elements.attendanceSub.textContent = absent > 0
    ? `${absent} worker${absent > 1 ? "s" : ""} absent today`
    : "Full attendance today";
  }
}

// ── Voice Recording ──────────────────────────────────────────────────────────

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    // Fallback: show text input
    showTextInputFallback();
    return;
  }
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = "te-IN";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    isRecording = true;
    updateRecordBtn(true);
    transcriptionText = "";
    if (elements.transcriptionCard) elements.transcriptionCard.classList.add("visible");
    if (elements.transcriptionText) elements.transcriptionText.textContent = "Listening in Telugu...";
  };

  recognition.onresult = (event) => {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += t + " ";
      else interim += t;
    }
    transcriptionText += final;
    if (elements.transcriptionText) {
      elements.transcriptionText.textContent = transcriptionText + (interim ? `[${interim}]` : "");
    }
  };

  recognition.onerror = (event) => {
    isRecording = false;
    updateRecordBtn(false);
    if (event.error === "network") {
      showToast("No internet — try typing your work details below", "warn");
      showTextInputFallback();
    } else if (event.error === "not-allowed") {
      showToast("Please allow microphone access", "warn");
    }
  };

  recognition.onend = () => {
    isRecording = false;
    updateRecordBtn(false);
    if (transcriptionText.trim()) {
      showToast("Recording complete — tap Generate Diary", "ok");
      if (elements.btnGenerateDiary) elements.btnGenerateDiary.style.display = "flex";
    }
  };

  recognition.start();
}

function stopRecording() {
  if (recognition) recognition.stop();
}

function updateRecordBtn(recording) {
  elements.btnRecord?.classList.toggle("recording", recording);
  if (elements.voiceTitle) elements.voiceTitle.textContent = recording ? "Tap to stop recording" : "Tap to record in Telugu";
  if (elements.voiceSub) elements.voiceSub.textContent = recording ? "Recording... speak freely about today's work" : "తెలుగులో మాట్లాడండి";
  if (elements.micEmoji) elements.micEmoji.innerHTML = recording ? Icons.alertCircle(24, '#EF4444') : Icons.mic(24, '#94A3B8');
}

function showTextInputFallback() {
  if (elements.textFallback) elements.textFallback.style.display = "block";
  if (elements.transcriptionCard) elements.transcriptionCard.classList.add("visible");
  if (elements.transcriptionText) {
    elements.transcriptionText.innerHTML = `<textarea id="manual-work-input" placeholder="Type today's work details here in Telugu or English..." style="width:100%;background:transparent;border:none;color:#B0C4DE;font-size:13px;resize:vertical;min-height:80px;line-height:1.6;" rows="4"></textarea>`;
    const ta = document.getElementById("manual-work-input");
    ta?.addEventListener("input", () => { transcriptionText = ta.value; });
    if (elements.btnGenerateDiary) elements.btnGenerateDiary.style.display = "flex";
  }
}

// ── AI Diary Generation ──────────────────────────────────────────────────

async function generateDiaryEntry() {
  const text = transcriptionText.trim();
  if (!text) { showToast("Please record or type work details first", "warn"); return; }

  const aiSettings = getAISettings();
  if (!aiSettings.apiKey && aiSettings.provider !== "ollama") {
    showToast("Please configure your AI API key in Settings", "warn");
    return;
  }

  showAnalyzingOverlay(true, "Generating Gang Diary...", "Structuring work details into official format");

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
  const total = parseInt(localStorage.getItem("gang_strength") || "25");
  const present = parseInt(elements.attendanceInput?.value || total);
  const gangNo = localStorage.getItem("gang_no") || "—";
  const mateName = localStorage.getItem("mate_name") || "—";
  const section = localStorage.getItem("section") || "Singarayakonda Section, Vijayawada Division";

  const prompt = `You are helping an Indian Railways Gang Mate (Track Maintainer Grade-I) fill out the official Gang Diary.

Gang Information:
- Date: ${dateStr}
- Gang Number: ${gangNo}
- Mate Name: ${mateName}
- Section: ${section}
- Attendance: ${present} present out of ${total} total workers
- Division: Vijayawada Division, South Central Railway

The Gang Mate has spoken/typed the following about today's work (may be in Telugu or English, possibly mixed):
"${text}"

Extract and structure this into official Indian Railways gang diary format. Respond in this exact JSON format:
{
  "workDone": "Detailed summary of work performed (in English), itemized as bullet points starting with •",
  "materialsUsed": "List of materials/fittings used (e.g., '6 PSC sleepers, 28 elastic rail clips, 4 fish bolts') or 'Nil' if none",
  "defectsObserved": "Any track defects or abnormalities observed, or 'Nil'",
  "safetyMeasures": "Safety precautions taken (e.g., 'Look-out man posted, hand signals maintained')",
  "specialInstructions": "Any instructions received from PWI/SSE/AEN, or 'Nil'",
  "remarks": "Any additional remarks for the official diary",
  "teleguSummary": "One line summary in Telugu script of the day's work"
}

Keep entries professional, in the style of Indian Railways official records.`;

  try {
    console.log("Calling AI for Gang Diary generation...");
    const entry = await callAI({ prompt });

    if (!entry || typeof entry !== "object" || !entry.workDone) {
      throw new Error("Invalid response format from AI model");
    }

    showAnalyzingOverlay(false);
    displayDiaryEntry(entry, { dateStr, gangNo, mateName, section, present, total });
    showToast("Gang Diary generated!", "ok");

  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("Generation failed: " + err.message, "error");
    console.error("AI Error in gang diary:", err);
  }
}

function displayDiaryEntry(entry, meta) {
  if (!elements.diaryEntryCard) return;
  elements.diaryEntryCard.classList.add("visible");

  if (elements.entryDate) elements.entryDate.textContent = `Gang Diary — ${meta.dateStr}`;
  if (elements.entryTime) elements.entryTime.textContent = new Date().toLocaleTimeString("en-IN");

  setText(elements.entryGang, `Gang ${meta.gangNo} | ${meta.mateName} | ${meta.section}`);
  setText(elements.entryAttendance, `${meta.present}/${meta.total} workers present`);
  setText(elements.entryWorkDone, entry.workDone);
  setText(elements.entryMaterials, entry.materialsUsed);
  setText(elements.entryDefects, entry.defectsObserved);
  setText(elements.entrySafety, entry.safetyMeasures);
  setText(elements.entrySpecial, entry.specialInstructions);
  setText(elements.entryRemarks, entry.remarks);
  if (elements.entryTelugu) elements.entryTelugu.textContent = entry.teleguSummary;

  // Store for saving
  elements.diaryEntryCard.dataset.entry = JSON.stringify({ ...entry, ...meta, rawTranscription: transcriptionText, timestamp: new Date().toISOString() });

  if (elements.btnSaveDiary) elements.btnSaveDiary.style.display = "flex";
  if (elements.btnShareDiary) elements.btnShareDiary.style.display = "flex";
}

function setText(el, text) { if (el) el.textContent = text || "—"; }

// ── Save & Share ─────────────────────────────────────────────────────────────

async function saveDiaryToDb() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  const entry = JSON.parse(card.dataset.entry);
  await saveDiaryEntry(entry);
  showToast("Diary entry saved!", "ok");
  loadTodayEntries();
}

async function shareDiaryEntry() {
  const card = elements.diaryEntryCard;
  if (!card?.dataset.entry) return;
  const e = JSON.parse(card.dataset.entry);

  const text = `
📔 GANG DIARY — ${e.dateStr}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Gang: ${e.gangNo} | Mate: ${e.mateName}
Section: ${e.section}
Attendance: ${e.present}/${e.total} workers
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORK DONE:
${e.workDone}

MATERIALS USED: ${e.materialsUsed}
DEFECTS OBSERVED: ${e.defectsObserved}
SAFETY MEASURES: ${e.safetyMeasures}
SPECIAL INSTRUCTIONS: ${e.specialInstructions}
REMARKS: ${e.remarks}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated by RailRaksha — AI Safety Platform
`.trim();

  if (navigator.share) {
    try { await navigator.share({ title: "Gang Diary Entry", text }); return; } catch {}
  }
  navigator.clipboard?.writeText(text).then(() => showToast("Diary copied to clipboard — send to PWI/SSE", "ok"));
}

// ── Today's entries summary ───────────────────────────────────────────────────

async function loadTodayEntries() {
  const today = new Date().toISOString().slice(0, 10);
  const entries = await getDiaryEntries(today);
  if (elements.todayEntriesCount) {
    elements.todayEntriesCount.textContent = entries.length > 0
      ? `${entries.length} entr${entries.length > 1 ? "ies" : "y"} saved today`
      : "No entries saved yet today";
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
