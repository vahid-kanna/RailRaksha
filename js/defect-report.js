/**
 * RailRaksha — Track Defect Reporter v7.0 (defect-report.js)
 *
 * Dual-mode reliability:
 *   - Online: Multimodal AI IRPWM vision classification via Cloudflare /api/chat
 *   - Offline / Instant: Built-in 8-template IRPWM manual field classifier so track
 *     defects are always documented, GPS-tagged, saved to IndexedDB, and shareable.
 */

import { saveDefectReport, getDefectReports, updateDefectStatus, deleteDefectReport, getISTDateISO } from './db.js';
import { callAI } from './ai-engine.js';
import { Icons } from './icons.js';

export const OFFLINE_DEFECT_PRESETS = [
  {
    id: 'rail-fracture',
    defectType: 'Complete Rail Fracture',
    severity: 'CRITICAL',
    irpwmCode: 'RF-01',
    speedRestriction: 'Stop Dead (0 km/h)',
    irpwmReference: 'IRPWM Para 2.6.1 & GR 3.62',
    immediateAction: 'Stop all trains immediately. Protect both sides with detonators (600 m & 1200 m). Inform Station Master and PWI/SSE.',
    description: 'Complete transverse rail fracture observed across rail head/web/foot.',
  },
  {
    id: 'weld-crack',
    defectType: 'Cracked Rail / AT Weld',
    severity: 'HIGH',
    irpwmCode: 'WC-02',
    speedRestriction: '30 km/h Caution Order',
    irpwmReference: 'IRPWM Para 2.6.1 / USFD Manual',
    immediateAction: 'Clamp with joggle fishplates and C-clamps immediately. Impose 30 km/h caution order and report to PWI/USFD team.',
    description: 'Visible hairline or progressive crack at rail or Alumino-Thermic (AT) weld joint.',
  },
  {
    id: 'sun-kink',
    defectType: 'LWR Buckling / Sun Kink',
    severity: 'CRITICAL',
    irpwmCode: 'LWR-09',
    speedRestriction: 'Stop Dead (0 km/h)',
    irpwmReference: 'IRPWM Para 2.9 — LWR Manual',
    immediateAction: 'Stop all train movements immediately. Protect line both directions. Do not disturb ballast until rail cools; call PWI/SSE.',
    description: 'Lateral misalignment / buckling detected on Long Welded Rail under thermal stress.',
  },
  {
    id: 'missing-erc',
    defectType: 'Missing / Loose ERC Fastenings',
    severity: 'MEDIUM',
    irpwmCode: 'FN-03',
    speedRestriction: 'None (replace immediately)',
    irpwmReference: 'IRPWM Para 3.3',
    immediateAction: 'Re-drive loose Elastic Rail Clips (ERC), replace missing liners/rubber pads, and inspect adjoining 10 sleepers.',
    description: 'Missing or unseated Elastic Rail Clips / GFN liners reducing rail-seat toe load.',
  },
  {
    id: 'broken-sleeper',
    defectType: 'Broken / Cracked PSC Sleeper',
    severity: 'HIGH',
    irpwmCode: 'SL-04',
    speedRestriction: '30 km/h if >10% clustered',
    irpwmReference: 'IRPWM Para 3.2',
    immediateAction: 'Mark defective sleeper with white paint, verify gauge across adjacent sleepers, and schedule replacement with PWI.',
    description: 'PSC concrete sleeper showing >3 transverse cracks, damaged insert, or through-fracture.',
  },
  {
    id: 'gauge-variation',
    defectType: 'Gauge Variation Beyond Limit',
    severity: 'HIGH',
    irpwmCode: 'GV-05',
    speedRestriction: '30 km/h Caution Order',
    irpwmReference: 'IRPWM Para 2.4.3',
    immediateAction: 'Verify BG gauge (1676 mm; straight ±6 mm, curve -6/+15 mm). Re-gauge fastenings and notify PWI immediately.',
    description: 'Measured track gauge outside permissible Broad Gauge tolerance limits.',
  },
  {
    id: 'ballast-void',
    defectType: 'Ballast Void / Pumping Joint',
    severity: 'MEDIUM',
    irpwmCode: 'BV-06',
    speedRestriction: '45 km/h if severe settlement',
    irpwmReference: 'IRPWM Para 2.5',
    immediateAction: 'Pack affected sleepers with clean ballast, improve shoulder drainage, and log for tamping machine attention.',
    description: 'Mud pumping, fouled ballast, or void under sleeper rail seat causing track settlement.',
  },
  {
    id: 'monsoon-scour',
    defectType: 'Monsoon Waterlogging / Scour',
    severity: 'CRITICAL',
    irpwmCode: 'MN-11',
    speedRestriction: 'Stop Dead if water at rail foot',
    irpwmReference: 'IRPWM Para 2.11',
    immediateAction: 'Inspect embankment slope, bridge waterway, and ballast toe. Stop trains immediately if water reaches rail foot or scours formation.',
    description: 'Heavy waterlogging, embankment erosion, or formation scour observed during rainfall.',
  },
];

let capturedImageBase64 = null;
let capturedImageMime = 'image/jpeg';
let elements = {};
let activeFilter = 'ALL';

export function initDefectReport(els) {
  elements = els;
  renderOfflinePresets();
  loadDefectHistory();

  elements.btnCamera?.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.fileInput?.click();
  });

  elements.btnUpload?.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.uploadInput?.click();
  });

  elements.fileInput?.addEventListener('change', handleFileSelect);
  elements.uploadInput?.addEventListener('change', handleFileSelect);
  elements.btnAnalyze?.addEventListener('click', analyzeDefect);
  elements.btnRetake?.addEventListener('click', resetPhotoOnly);
  elements.btnToggleManualDefect?.addEventListener('click', toggleManualPanel);
  elements.btnLogOfflineDefect?.addEventListener('click', submitOfflineDefect);
  elements.btnShareReport?.addEventListener('click', shareReport);
  elements.btnNewDefect?.addEventListener('click', resetDefectForm);
  elements.btnExportDefects?.addEventListener('click', exportDefectsTxt);

  elements.defectFilterBar?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    elements.defectFilterBar.querySelectorAll('[data-filter]').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === activeFilter);
    });
    loadDefectHistory();
  });
}

function renderOfflinePresets() {
  const sel = elements.offlineDefectSelect;
  if (!sel) return;
  sel.innerHTML = OFFLINE_DEFECT_PRESETS.map(p =>
    `<option value="${p.id}">${p.defectType} (${p.severity} · ${p.irpwmCode})</option>`
  ).join('');
}

function toggleManualPanel(forceOpen = null) {
  const panel = elements.manualDefectPanel;
  if (!panel) return;
  const nextHidden = forceOpen === true ? false : forceOpen === false ? true : !panel.hidden;
  panel.hidden = nextHidden;
  elements.btnToggleManualDefect?.setAttribute('aria-expanded', String(!nextHidden));
}

function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  capturedImageMime = 'image/jpeg';
  const reader = new FileReader();
  reader.onload = (ev) => {
    compressImage(ev.target.result, 1280, 0.8, (compressedDataUrl) => {
      capturedImageBase64 = compressedDataUrl.split(',')[1];
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
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    callback(canvas.toDataURL('image/jpeg', quality));
  };
  img.onerror = () => callback(dataUrl);
  img.src = dataUrl;
}

function displayPreview(dataUrl) {
  if (elements.imagePreview) {
    elements.imagePreview.src = dataUrl;
    elements.imagePreview.hidden = false;
  }
  elements.captureZone?.classList.add('has-photo');
  if (elements.capturePlaceholder) elements.capturePlaceholder.hidden = true;
  if (elements.photoActionRow) elements.photoActionRow.hidden = false;
}

function resetPhotoOnly() {
  capturedImageBase64 = null;
  if (elements.imagePreview) { elements.imagePreview.hidden = true; elements.imagePreview.src = ''; }
  elements.captureZone?.classList.remove('has-photo');
  if (elements.capturePlaceholder) elements.capturePlaceholder.hidden = false;
  if (elements.photoActionRow) elements.photoActionRow.hidden = true;
  if (elements.fileInput) elements.fileInput.value = '';
  if (elements.uploadInput) elements.uploadInput.value = '';
}

async function analyzeDefect() {
  if (!capturedImageBase64) {
    showToast('Capture or upload a track photo first', 'warn');
    return;
  }

  showAnalyzingOverlay(true, 'Analyzing Track Photo', 'Checking IRPWM defect categories...');

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

    if (!analysis || typeof analysis !== 'object' || !analysis.defectType) {
      throw new Error('Unexpected response format from AI');
    }

    showAnalyzingOverlay(false);
    displayAnalysis({ ...analysis, mode: 'AI Vision' });
  } catch (err) {
    showAnalyzingOverlay(false);
    toggleManualPanel(true);
    const reason = err.code === 'offline'
      ? 'Offline — use Quick Offline IRPWM Classifier below'
      : 'AI unavailable — opened Offline IRPWM Classifier below';
    showToast(reason, 'warn');
  }
}

function submitOfflineDefect() {
  const presetId = elements.offlineDefectSelect?.value;
  const preset = OFFLINE_DEFECT_PRESETS.find(p => p.id === presetId) || OFFLINE_DEFECT_PRESETS[0];
  const note = elements.offlineDefectNotes?.value?.trim();
  const analysis = {
    defectType: preset.defectType,
    severity: preset.severity,
    irpwmCode: preset.irpwmCode,
    confidence: 'FIELD VERIFIED',
    description: note ? `${preset.description} Field note: ${note}` : preset.description,
    immediateAction: preset.immediateAction,
    reportingRequired: true,
    speedRestriction: preset.speedRestriction,
    irpwmReference: preset.irpwmReference,
    generalInfo: capturedImageBase64 ? 'Photo attached locally on device' : 'Manual field observation (no photo)',
    mode: 'Offline IRPWM',
  };
  displayAnalysis(analysis);
  toggleManualPanel(false);
  showToast('Offline IRPWM classification ready — tap Save & Share', 'ok');
}

function displayAnalysis(analysis) {
  if (elements.defectAnalysisCard) elements.defectAnalysisCard.hidden = false;

  if (elements.defectTypeBadge) {
    const cls = {
      CRITICAL: 'sev-critical',
      HIGH: 'sev-high',
      MEDIUM: 'sev-medium',
      LOW: 'sev-low',
      INFO: 'sev-info',
    };
    elements.defectTypeBadge.className = `defect-type-badge ${cls[analysis.severity] || 'sev-low'}`;
    elements.defectTypeBadge.innerHTML = `${severityIcon(analysis.severity)} <span>${escapeHtml(analysis.defectType)}</span>`;
  }

  const loc = getCurrentLocationText();
  setText(elements.detailSeverity, analysis.severity);
  setText(elements.detailConfidence, `${analysis.confidence || '—'}${analysis.mode ? ` · ${analysis.mode}` : ''}`);
  setText(elements.detailIRPWM, analysis.irpwmCode);
  setText(elements.detailSpeed, analysis.speedRestriction);
  setText(elements.detailGPS, loc);
  setText(elements.detailTime, new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
  setText(elements.detailDescription, analysis.description);
  setText(elements.recommendedAction, analysis.immediateAction);
  if (elements.irpwmReference) elements.irpwmReference.textContent = `Reference: ${analysis.irpwmReference || 'IRPWM'}`;

  if (elements.detailGeneralInfo) {
    const row = elements.detailGeneralInfo.closest('.detail-row');
    if (analysis.generalInfo) {
      elements.detailGeneralInfo.textContent = analysis.generalInfo;
      if (row) row.hidden = false;
    } else if (row) {
      row.hidden = true;
    }
  }

  if (elements.defectAnalysisCard) {
    elements.defectAnalysisCard.dataset.analysis = JSON.stringify({
      ...analysis,
      gps: loc,
      timestamp: new Date().toISOString(),
    });
  }

  if (elements.btnShareReport) {
    elements.btnShareReport.hidden = analysis.reportingRequired === false;
  }
  elements.defectAnalysisCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
  if (el) el.textContent = text || '—';
}

function getCurrentLocationText() {
  if (window._currentLocationLabel) return window._currentLocationLabel;
  const pos = window._currentWorkerPos;
  if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
    return `${pos.label || ''} (${pos.lat.toFixed(4)}°N, ${pos.lon.toFixed(4)}°E)`.trim();
  }
  return 'km 293.0 · SKM (Default Beat)';
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
    irpwmReference: analysis.irpwmReference,
    mode: analysis.mode || 'Field',
    status: 'REPORTED',
  });
  await loadDefectHistory();

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Track Defect Report — RailRaksha', text: reportText });
      showToast('Defect logged offline and shared', 'ok');
      return;
    } catch {}
  }

  try {
    await navigator.clipboard.writeText(reportText);
    showToast('Defect logged offline and copied to clipboard', 'ok');
  } catch {
    showToast('Defect saved to offline history', 'ok');
  }
}

export function generateReportText(analysis) {
  const now = new Date(analysis.timestamp || Date.now());
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const gangNo = localStorage.getItem('gang_no') || '—';
  const mateName = localStorage.getItem('mate_name') || '—';
  const section = localStorage.getItem('section') || 'SKM–UPD Section';

  return [
    'TRACK DEFECT REPORT — RailRaksha',
    `Date: ${dateStr} | Time: ${timeStr}`,
    `Gang: ${gangNo} | Mate: ${mateName}`,
    `Section: ${section}`,
    `Location: ${analysis.gps || '—'}`,
    '---',
    `Defect: ${analysis.defectType}`,
    `Severity: ${analysis.severity} | IRPWM Code: ${analysis.irpwmCode || 'N/A'}`,
    `Speed Restriction: ${analysis.speedRestriction || 'None'}`,
    `Observation: ${analysis.description || '—'}`,
    `Immediate Action: ${analysis.immediateAction || '—'}`,
    `Reference: ${analysis.irpwmReference || 'IRPWM'}`,
  ].join('\n');
}

async function loadDefectHistory() {
  const all = await getDefectReports();
  if (!elements.defectHistoryList) return;

  const reports = activeFilter === 'ALL'
    ? all
    : activeFilter === 'FIXED'
    ? all.filter(r => r.status === 'FIXED')
    : all.filter(r => r.status !== 'FIXED');

  elements.defectHistoryList.innerHTML = '';

  if (reports.length === 0) {
    elements.defectHistoryList.innerHTML = `
      <div class="empty-state">
        <div class="es-title">${all.length === 0 ? 'No defects logged yet' : 'No matching defects'}</div>
        <div class="es-sub">${all.length === 0 ? 'AI vision and offline IRPWM reports save here automatically.' : 'Change the filter above to view other records.'}</div>
      </div>`;
    return;
  }

  reports.slice(0, 20).forEach(r => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const statusClass = { OPEN: 'st-open', REPORTED: 'st-reported', FIXED: 'st-fixed' }[r.status] || 'st-open';
    const dateLabel = new Date(r.createdAt || r.timestamp || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    item.innerHTML = `
      <div class="hi-lead">${severityIcon(r.severity)}</div>
      <div class="hi-body">
        <div class="hi-title">${escapeHtml(r.defectType)}</div>
        <div class="hi-meta">${escapeHtml(r.irpwmCode || 'IRPWM')} · ${escapeHtml(r.gps || 'SKM Section')} · ${dateLabel}</div>
        ${r.speedRestriction ? `<div class="hi-sub">Restriction: ${escapeHtml(r.speedRestriction)}</div>` : ''}
      </div>
      <div class="hi-actions">
        <button type="button" class="status-pill ${statusClass}" data-action="status" title="Cycle defect status">${escapeHtml(r.status)}</button>
        <button type="button" class="icon-btn-sm" data-action="copy" aria-label="Copy defect report" title="Copy report">Copy</button>
        <button type="button" class="icon-btn-sm icon-btn-danger" data-action="delete" aria-label="Delete defect report" title="Delete">Del</button>
      </div>`;

    item.querySelector('[data-action="status"]')?.addEventListener('click', async () => {
      const cycle = { OPEN: 'REPORTED', REPORTED: 'FIXED', FIXED: 'OPEN' };
      await updateDefectStatus(r.id, cycle[r.status] || 'FIXED');
      loadDefectHistory();
    });

    item.querySelector('[data-action="copy"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(generateReportText(r));
        showToast('Report copied to clipboard', 'ok');
      } catch {
        showToast('Unable to access clipboard', 'warn');
      }
    });

    item.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      await deleteDefectReport(r.id);
      loadDefectHistory();
      showToast('Defect removed', 'info');
    });

    elements.defectHistoryList.appendChild(item);
  });
}

async function exportDefectsTxt() {
  const reports = await getDefectReports();
  if (reports.length === 0) {
    showToast('No defect reports to export', 'warn');
    return;
  }
  const content = reports.map(generateReportText).join('\n\n==============================\n\n');
  downloadTextFile(`railraksha-defects-${getISTDateISO()}.txt`, content);
  showToast(`Exported ${reports.length} defect report(s)`, 'ok');
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetDefectForm() {
  resetPhotoOnly();
  if (elements.offlineDefectNotes) elements.offlineDefectNotes.value = '';
  if (elements.defectAnalysisCard) elements.defectAnalysisCard.hidden = true;
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
