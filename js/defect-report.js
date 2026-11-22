/**
 * RailRaksha — Track Defect Photo Report (defect-report.js)
 * Captures/compresses track photos, classifies defects via AI proxy,
 * maps to IRPWM codes, stores offline in IndexedDB, and formats PWI reports.
 */

import { saveDefectReport, getDefectReports, updateDefectStatus } from './db.js';
import { callAI } from './ai-engine.js';
import { Icons } from './icons.js';

let capturedImageBase64 = null;
let capturedImageMime = "image/jpeg";
let elements = {};

export function initDefectReport(els) {
  elements = els;
  loadDefectHistory();

  elements.btnCamera?.addEventListener("click", (e) => {
    e.stopPropagation();
    elements.fileInput?.click();
  });

  elements.btnUpload?.addEventListener("click", (e) => {
    e.stopPropagation();
    elements.uploadInput?.click();
  });

  elements.fileInput?.addEventListener("change", handleFileSelect);
  elements.uploadInput?.addEventListener("change", handleFileSelect);
  elements.btnAnalyze?.addEventListener("click", analyzeDefect);
  elements.btnShareReport?.addEventListener("click", shareReport);
  elements.btnNewDefect?.addEventListener("click", resetDefectForm);
}

function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  capturedImageMime = "image/jpeg";
  const reader = new FileReader();
  reader.onload = (ev) => {
    compressImage(ev.target.result, 1280, 0.8, (compressedDataUrl) => {
      capturedImageBase64 = compressedDataUrl.split(",")[1];
      displayPreview(compressedDataUrl);
    });
  };
  reader.readAsDataURL(file);
}

function compressImage(dataUrl, maxDimension, quality, callback) {
  const img = new Image();
  img.onload = () => {
    let { width, height } = img;
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
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL("image/jpeg", quality));
  };
  img.onerror = () => callback(dataUrl);
  img.src = dataUrl;
}

function displayPreview(dataUrl) {
  if (elements.imagePreview) {
    elements.imagePreview.src = dataUrl;
    elements.imagePreview.style.display = "block";
  }
  elements.captureZone?.classList.add("has-photo");
  if (elements.capturePlaceholder) elements.capturePlaceholder.style.display = "none";
  if (elements.btnAnalyze) elements.btnAnalyze.style.display = "flex";
}

async function analyzeDefect() {
  if (!capturedImageBase64) {
    showToast("Capture or upload a track photo first", "warn");
    return;
  }

  showAnalyzingOverlay(true, "Analyzing Track Photo", "Checking for IRPWM track defects...");

  const prompt = `You are a senior Indian Railways Permanent Way (P-Way) engineer.
Analyze this photo to determine whether it shows railway track or infrastructure.

If the photo is NOT railway-related (person, food, random object, selfie, road vehicle, etc.), respond ONLY in this exact JSON:
{
  "defectType": "Not railway-related image",
  "severity": "INFO",
  "irpwmCode": "N/A",
  "confidence": "HIGH",
  "description": "This photo does not appear to show railway track or infrastructure.",
  "immediateAction": "Capture or upload a clear photo of rails, sleepers, fastenings, welds, or ballast.",
  "reportingRequired": false,
  "speedRestriction": "None",
  "irpwmReference": "N/A",
  "generalInfo": "Brief one-sentence description of what the image actually shows."
}

If the photo DOES show railway track/infrastructure, respond ONLY in this exact JSON:
{
  "defectType": "Concise defect name (e.g. Cracked Rail Weld, Broken PSC Sleeper, Missing ERC Clip, Gauge Widening, Rail Corrosion, Broken Fish Plate, Ballast Void, No Defect Visible)",
  "severity": "CRITICAL | HIGH | MEDIUM | LOW",
  "irpwmCode": "Relevant IRPWM code or N/A",
  "confidence": "HIGH | MEDIUM | LOW",
  "description": "Concise technical observation of the track condition",
  "immediateAction": "Immediate field action for the Gang Mate",
  "reportingRequired": true,
  "speedRestriction": "Recommended speed restriction (e.g. Stop Dead, 20 km/h, 30 km/h, or None)",
  "irpwmReference": "Relevant IRPWM paragraph or N/A",
  "generalInfo": "Brief general context (e.g. Broad Gauge track with PSC sleepers)"
}`;

  try {
    const analysis = await callAI({
      prompt,
      imageBase64: capturedImageBase64,
      mimeType: capturedImageMime,
    });

    if (!analysis || typeof analysis !== "object" || !analysis.defectType) {
      throw new Error("Unexpected response format from AI");
    }

    showAnalyzingOverlay(false);
    displayAnalysis(analysis);
  } catch (err) {
    showAnalyzingOverlay(false);
    showToast("Analysis failed: " + err.message, "error");
  }
}

function displayAnalysis(analysis) {
  elements.defectAnalysisCard?.classList.add("visible");

  if (elements.defectTypeBadge) {
    const cls = {
      CRITICAL: "severity-critical",
      HIGH: "severity-high",
      MEDIUM: "severity-medium",
      LOW: "severity-low",
      INFO: "severity-info",
    };
    elements.defectTypeBadge.className = `defect-type-badge ${cls[analysis.severity] || "severity-low"}`;
    elements.defectTypeBadge.innerHTML = `${severityIcon(analysis.severity)} <span>${escapeHtml(analysis.defectType)}</span>`;
  }

  const loc = getCurrentLocationText();
  setText(elements.detailSeverity, analysis.severity);
  setText(elements.detailConfidence, analysis.confidence);
  setText(elements.detailIRPWM, analysis.irpwmCode);
  setText(elements.detailSpeed, analysis.speedRestriction);
  setText(elements.detailGPS, loc);
  setText(elements.detailTime, new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
  setText(elements.detailDescription, analysis.description);
  setText(elements.recommendedAction, analysis.immediateAction);
  if (elements.irpwmReference) elements.irpwmReference.textContent = `IRPWM Ref: ${analysis.irpwmReference || "N/A"}`;

  if (elements.detailGeneralInfo) {
    const row = elements.detailGeneralInfo.closest(".detail-row");
    if (analysis.generalInfo) {
      elements.detailGeneralInfo.textContent = analysis.generalInfo;
      if (row) row.hidden = false;
    } else if (row) {
      row.hidden = true;
    }
  }

  elements.defectAnalysisCard.dataset.analysis = JSON.stringify({
    ...analysis,
    gps: loc,
    timestamp: new Date().toISOString(),
  });

  if (elements.btnShareReport) {
    elements.btnShareReport.style.display = analysis.reportingRequired === false ? "none" : "flex";
  }
}

function severityIcon(severity) {
  return {
    CRITICAL: Icons.dot(10, '#EF4444'),
    HIGH: Icons.dot(10, '#F97316'),
    MEDIUM: Icons.dot(10, '#F59E0B'),
    LOW: Icons.dot(10, '#22C55E'),
    INFO: Icons.dot(10, '#94A3B8'),
  }[severity] || Icons.dot(10, '#94A3B8');
}

function setText(el, text) {
  if (el) el.textContent = text || "—";
}

function getCurrentLocationText() {
  if (window._currentLocationLabel) return window._currentLocationLabel;
  const pos = window._currentWorkerPos;
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
    return `${pos.label || ""} (${pos.lat.toFixed(4)}°N, ${pos.lon.toFixed(4)}°E)`.trim();
  }
  return "km 293.0 · SKM (Default Beat)";
}

async function shareReport() {
  const card = elements.defectAnalysisCard;
  if (!card?.dataset.analysis) return;
  const analysis = JSON.parse(card.dataset.analysis);
  const reportText = generateReportText(analysis);

  await saveDefectReport({
    defectType: analysis.defectType,
    severity: analysis.severity,
    description: analysis.description,
    gps: analysis.gps,
    timestamp: analysis.timestamp,
    irpwmCode: analysis.irpwmCode,
    speedRestriction: analysis.speedRestriction,
    immediateAction: analysis.immediateAction,
    status: "REPORTED",
  });
  loadDefectHistory();

  if (navigator.share) {
    try {
      await navigator.share({ title: "Track Defect Report — RailRaksha", text: reportText });
      showToast("Report shared and logged", "ok");
      return;
    } catch {}
  }

  try {
    await navigator.clipboard.writeText(reportText);
    showToast("Report copied to clipboard and logged", "ok");
  } catch {
    showToast("Report saved to local history", "ok");
  }
}

function generateReportText(analysis) {
  const now = new Date(analysis.timestamp);
  const dateStr = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const gangNo = localStorage.getItem("gang_no") || "—";
  const mateName = localStorage.getItem("mate_name") || "—";
  const section = localStorage.getItem("section") || "SKM–UPD Section";

  return [
    "TRACK DEFECT REPORT — RailRaksha",
    `Date: ${dateStr} | Time: ${timeStr}`,
    `Gang: ${gangNo} | Mate: ${mateName}`,
    `Section: ${section}`,
    `Location: ${analysis.gps}`,
    "---",
    `Defect: ${analysis.defectType}`,
    `Severity: ${analysis.severity} | IRPWM: ${analysis.irpwmCode}`,
    `Speed Restriction: ${analysis.speedRestriction}`,
    `Observation: ${analysis.description}`,
    `Immediate Action: ${analysis.immediateAction}`,
    `Reference: ${analysis.irpwmReference}`,
  ].join("\n");
}

async function loadDefectHistory() {
  const reports = await getDefectReports();
  if (!elements.defectHistoryList) return;
  elements.defectHistoryList.innerHTML = "";

  if (reports.length === 0) {
    elements.defectHistoryList.innerHTML = `
      <div class="empty-state">
        <div class="es-title">No defects logged yet</div>
        <div class="es-sub">Captured and shared track reports are saved offline here.</div>
      </div>`;
    return;
  }

  reports.slice(0, 12).forEach(r => {
    const item = document.createElement("div");
    item.className = "defect-history-item";
    const statusClass = { OPEN: "dstatus-open", REPORTED: "dstatus-reported", FIXED: "dstatus-fixed" }[r.status] || "dstatus-open";
    item.innerHTML = `
      <div class="defect-thumb">${severityIcon(r.severity)}</div>
      <div class="defect-info">
        <div class="defect-name">${escapeHtml(r.defectType)}</div>
        <div class="defect-loc">${escapeHtml(r.gps || "SKM Section")} · ${new Date(r.createdAt || r.date).toLocaleDateString("en-IN")}</div>
      </div>
      <button type="button" class="defect-status-badge ${statusClass}" title="Toggle fixed status">${escapeHtml(r.status)}</button>`;
    item.querySelector("button")?.addEventListener("click", async () => {
      const next = r.status === "FIXED" ? "REPORTED" : "FIXED";
      await updateDefectStatus(r.id, next);
      loadDefectHistory();
    });
    elements.defectHistoryList.appendChild(item);
  });
}

function resetDefectForm() {
  capturedImageBase64 = null;
  if (elements.imagePreview) { elements.imagePreview.style.display = "none"; elements.imagePreview.src = ""; }
  elements.captureZone?.classList.remove("has-photo");
  if (elements.capturePlaceholder) elements.capturePlaceholder.style.display = "flex";
  if (elements.btnAnalyze) elements.btnAnalyze.style.display = "none";
  if (elements.btnShareReport) elements.btnShareReport.style.display = "none";
  elements.defectAnalysisCard?.classList.remove("visible");
  if (elements.fileInput) elements.fileInput.value = "";
  if (elements.uploadInput) elements.uploadInput.value = "";
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
