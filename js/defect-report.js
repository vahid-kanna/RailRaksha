/**
 * RailRaksha — Track Defect Photo Report (defect-report.js)
 * Uses Bynara vision (agnes-2.5-flash) for AI-powered defect classification.
 */

import { saveDefectReport, getDefectReports, updateDefectStatus } from './db.js';
import { callAI, getAISettings } from './ai-engine.js';
import { Icons } from './icons.js';

let capturedImageBase64 = null;
let capturedImageMime = "image/jpeg";

// ── DOM refs (set after HTML is loaded) ─────────────────────────────────────
let elements = {};

export function initDefectReport(els) {
  elements = els;
  loadDefectHistory();

  // Camera button — opens camera (capture="environment")
  elements.btnCamera?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (capturedImageBase64) return;
    elements.fileInput?.click();
  });

  // Upload button — opens file picker (no capture attr)
  elements.btnUpload?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (capturedImageBase64) return;
    elements.uploadInput?.click();
  });

  elements.fileInput?.addEventListener("change", handleFileSelect);
  elements.uploadInput?.addEventListener("change", handleFileSelect);
  elements.btnAnalyze?.addEventListener("click", analyzeDefect);
  elements.btnShareReport?.addEventListener("click", shareReport);
  elements.btnNewDefect?.addEventListener("click", resetDefectForm);
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  capturedImageMime = "image/jpeg";
  const reader = new FileReader();
  reader.onload = (ev) => {
    const rawDataUrl = ev.target.result;
    compressImage(rawDataUrl, 1280, 0.8, (compressedDataUrl) => {
      capturedImageBase64 = compressedDataUrl.split(",")[1];
      displayPreview(compressedDataUrl);
    });
  };
  reader.readAsDataURL(file);
}

function compressImage(dataUrl, maxDimension, quality, callback) {
  const img = new Image();
  img.onload = () => {
    let width = img.width;
    let height = img.height;

    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);

    const compressed = canvas.toDataURL("image/jpeg", quality);
    callback(compressed);
  };
  img.onerror = () => {
    callback(dataUrl);
  };
  img.src = dataUrl;
}

function displayPreview(dataUrl) {
  if (elements.imagePreview) {
    elements.imagePreview.src = dataUrl;
    elements.imagePreview.style.display = "block";
  }
  elements.captureZone?.classList.add("has-photo");
  elements.captureIcon && (elements.captureIcon.style.display = "none");
  elements.captureText && (elements.captureText.style.display = "none");
  elements.btnAnalyze && (elements.btnAnalyze.style.display = "flex");
}

// ── AI call ──────────────────────────────────────────────────────────

async function analyzeDefect() {
  if (!capturedImageBase64) { showToast("Please capture a photo first", "warn"); return; }
  const aiSettings = getAISettings();
  if (!aiSettings.apiKey && aiSettings.provider !== "ollama") {
    showToast("Please configure your AI API key in Settings", "warn");
    return;
  }

  showAnalyzingOverlay(true, "Analyzing track defect...", "AI is examining the photo");

  const prompt = `You are an expert Indian Railways track engineer with 20+ years of experience.
Analyze this photo to determine whether it contains railway track/infrastructure.

If the photo is NOT railway-related (e.g., a person, food, random objects, selfie, landscape with no track, animals, vehicles on road, etc.), respond ONLY in this exact JSON format:
{
  "defectType": "Not railway-related image",
  "severity": "INFO",
  "irpwmCode": "N/A",
  "confidence": "HIGH",
  "description": "Brief, polite explanation that this image does not appear to be related to railway track or infrastructure.",
  "immediateAction": "Please capture or upload a photo of the railway track, sleepers, rails, ballast, or related infrastructure.",
  "reportingRequired": false,
  "speedRestriction": "None",
  "irpwmReference": "N/A",
  "generalInfo": "One sentence describing what the image actually shows (e.g., 'This appears to be a selfie/person/food/vehicle/etc.')"
}

If the photo DOES contain railway track/infrastructure, identify any defects or issues and respond in this exact JSON format:
{
  "defectType": "Brief defect name (e.g., 'Cracked Rail Weld', 'Broken Concrete Sleeper', 'Missing Elastic Rail Clip', 'Gauge Widening', 'Rail Corrosion', 'Broken Fish Plate', 'Damaged Ballast', 'No defect visible')",
  "severity": "CRITICAL | HIGH | MEDIUM | LOW",
  "irpwmCode": "Relevant IRPWM defect code if applicable, or 'N/A'",
  "confidence": "HIGH | MEDIUM | LOW",
  "description": "One sentence description of what you see",
  "immediateAction": "What the Gang Mate should do right now",
  "reportingRequired": true,
  "speedRestriction": "Recommended speed restriction in km/h, or 'None'",
  "irpwmReference": "Relevant IRPWM paragraph if known, or 'N/A'",
  "generalInfo": "Brief general observation about the track photo (e.g., 'Broad Gauge track with concrete sleepers in daylight')"
}

If you cannot identify railway track defects or the image is unclear, set defectType to 'Image unclear - please retake' and severity to 'LOW'.`;

  try {
    console.log("Calling AI for track defect analysis (image → Bynara vision)...");
    const analysis = await callAI({
      prompt,
      imageBase64: capturedImageBase64,
      mimeType: capturedImageMime
    });

    if (!analysis || typeof analysis !== "object" || !analysis.defectType) {
      throw new Error("Invalid response format from AI model");
    }

    showAnalyzingOverlay(false);
    displayAnalysis(analysis);

  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("Analysis failed: " + err.message, "error");
    console.error("Defect analysis error:", err);
  }
}

function displayAnalysis(analysis) {
  elements.defectAnalysisCard?.classList.add("visible");

  // Severity badge
  if (elements.defectTypeBadge) {
    const cls = { CRITICAL: "severity-critical", HIGH: "severity-high", MEDIUM: "severity-medium", LOW: "severity-low" };
    elements.defectTypeBadge.className = `defect-type-badge ${cls[analysis.severity] || "severity-low"}`;
    elements.defectTypeBadge.innerHTML = `${severityIcon(analysis.severity)} ${analysis.defectType}`;
  }

  // Detail rows
  setText(elements.detailSeverity, analysis.severity);
  setText(elements.detailConfidence, analysis.confidence);
  setText(elements.detailIRPWM, analysis.irpwmCode);
  setText(elements.detailSpeed, analysis.speedRestriction);
  setText(elements.detailGPS, getCurrentGPSLabel());
  setText(elements.detailTime, new Date().toLocaleTimeString("en-IN"));
  setText(elements.detailDescription, analysis.description);
  setText(elements.recommendedAction, analysis.immediateAction);
  if (elements.irpwmReference) elements.irpwmReference.textContent = `IRPWM Ref: ${analysis.irpwmReference}`;

  // Show general info if provided (useful for non-railway images)
  if (elements.detailGeneralInfo && analysis.generalInfo) {
    elements.detailGeneralInfo.textContent = analysis.generalInfo;
    elements.detailGeneralInfo.style.display = "block";
  } else if (elements.detailGeneralInfo) {
    elements.detailGeneralInfo.style.display = "none";
  }

  // Store for sharing
  elements.defectAnalysisCard.dataset.analysis = JSON.stringify({
    ...analysis,
    gps: getCurrentGPSLabel(),
    timestamp: new Date().toISOString(),
    imageBase64: capturedImageBase64
  });

  // Show share button
  if (elements.btnShareReport) elements.btnShareReport.style.display = "flex";
}

function severityIcon(severity) {
  return { 
    CRITICAL: Icons.dot(12, '#EF4444'), 
    HIGH: Icons.dot(12, '#F97316'), 
    MEDIUM: Icons.dot(12, '#F59E0B'), 
    LOW: Icons.dot(12, '#10B981') 
  }[severity] || Icons.dot(12, '#94A3B8');
}

function setText(el, text) {
  if (el) el.textContent = text || "—";
}

function getCurrentGPSLabel() {
  const gps = window._lastGPS;
  if (!gps) return "GPS locating...";
  return `${gps.lat.toFixed(4)}°N, ${gps.lon.toFixed(4)}°E`;
}

// ── Save & Share Report ──────────────────────────────────────────────────────

async function shareReport() {
  const card = elements.defectAnalysisCard;
  if (!card?.dataset.analysis) return;
  const analysis = JSON.parse(card.dataset.analysis);

  // Build the report text
  const reportText = generateReportText(analysis);

  // Save to IndexedDB
  await saveDefectReport({
    defectType: analysis.defectType,
    severity: analysis.severity,
    description: analysis.description,
    gps: analysis.gps,
    timestamp: analysis.timestamp,
    irpwmCode: analysis.irpwmCode,
    speedRestriction: analysis.speedRestriction,
    immediateAction: analysis.immediateAction,
    status: "REPORTED"
  });

  // Try native share
  if (navigator.share) {
    try {
      await navigator.share({ title: "Track Defect Report — RailRaksha", text: reportText });
      showToast("Report shared successfully", "ok");
      loadDefectHistory();
      return;
    } catch {}
  }

  // Fallback: copy to clipboard
  navigator.clipboard?.writeText(reportText).then(() => {
    showToast("Report copied to clipboard", "ok");
    loadDefectHistory();
  });
}

function generateReportText(analysis) {
  const now = new Date(analysis.timestamp);
  const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-IN");
  const gangNo = localStorage.getItem("gang_no") || "Gang No. ___";
  const mateName = localStorage.getItem("mate_name") || "Mate Name ___";
  const section = localStorage.getItem("section") || "SKM Section";

  return `
📋 TRACK DEFECT REPORT — RailRaksha
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Date: ${dateStr}  Time: ${timeStr}
Gang: ${gangNo}  |  Mate: ${mateName}
Section: ${section}
GPS: ${analysis.gps}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEFECT TYPE: ${analysis.defectType}
SEVERITY: ${analysis.severity}
IRPWM Code: ${analysis.irpwmCode}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DESCRIPTION:
${analysis.description}

IMMEDIATE ACTION REQUIRED:
${analysis.immediateAction}

SPEED RESTRICTION: ${analysis.speedRestriction}
IRPWM Reference: ${analysis.irpwmReference}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AI Confidence: ${analysis.confidence}
Generated by RailRaksha — AI Safety Platform
`.trim();
}

// ── Defect History ───────────────────────────────────────────────────────────

async function loadDefectHistory() {
  const reports = await getDefectReports();
  if (!elements.defectHistoryList) return;
  elements.defectHistoryList.innerHTML = "";

  if (reports.length === 0) {
    elements.defectHistoryList.innerHTML = `<div class="empty-state"><div class="es-icon">${Icons.search(40, '#64748B')}</div><div class="es-title">No defects reported yet</div><div class="es-sub">Photograph and report track defects here</div></div>`;
    return;
  }

  reports.slice(0, 10).forEach(r => {
    const item = document.createElement("div");
    item.className = "defect-history-item slide-in-up";
    const statusClass = { OPEN: "dstatus-open", REPORTED: "dstatus-reported", FIXED: "dstatus-fixed" }[r.status] || "dstatus-open";
    item.innerHTML = `
      <div class="defect-thumb">${severityIcon(r.severity)}</div>
      <div class="defect-info">
        <div class="defect-name">${r.defectType}</div>
        <div class="defect-loc">${r.gps || "GPS pending"} · ${new Date(r.date).toLocaleDateString("en-IN")}</div>
      </div>
      <span class="defect-status-badge ${statusClass}">${r.status}</span>`;
    elements.defectHistoryList.appendChild(item);
  });
}

function resetDefectForm() {
  capturedImageBase64 = null;
  if (elements.imagePreview) { elements.imagePreview.style.display = "none"; elements.imagePreview.src = ""; }
  elements.captureZone?.classList.remove("has-photo");
  if (elements.captureIcon) elements.captureIcon.style.display = "block";
  if (elements.captureText) elements.captureText.style.display = "block";
  if (elements.btnAnalyze) elements.btnAnalyze.style.display = "none";
  if (elements.btnShareReport) elements.btnShareReport.style.display = "none";
  elements.defectAnalysisCard?.classList.remove("visible");
  // Hide general info on reset
  if (elements.detailGeneralInfo) elements.detailGeneralInfo.style.display = "none";
  if (elements.fileInput) elements.fileInput.value = "";
  if (elements.uploadInput) elements.uploadInput.value = "";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
