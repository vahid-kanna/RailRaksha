/**
 * live-trains.js — Live running status → position ENVELOPE per train.
 *
 * FLAW 4 (the delay bug) — root cause & fix
 *   OLD:  baseTime = departureTime − delay      ← moves departure EARLIER
 *         elapsed  = now − baseTime              ← inflated by +delay
 *         → a 30-min-late train was placed 30·v/60 ≈ 55 km too far ahead.
 *   NEW:  depActual = actualDeparture ?? (scheduledDeparture + delay)
 *         elapsed   = max(0, now − depActual)
 *   And NEVER apply delay to a timestamp that is already "actual" (double count).
 *
 * POSITION ENVELOPE (all in chainage km, dir = +1 UP / −1 DN)
 *   kmNominal : best estimate
 *   kmLead    : furthest the train could plausibly be  → used for APPROACH alarms
 *   kmLag     : least  the train could plausibly be    → used to declare PASSED
 *   Using lead for approach and lag for "passed" is fail-safe in both directions.
 *
 *   LIVE mode (fresh report from last station L, next booked point N):
 *     f        = clamp( (now − depActual_L) / (arrActual_N − depActual_L), 0, 1 )
 *     nominal  = km_L + f·(km_N − km_L)
 *     lead     = km_L + dir·min(|km_N − km_L|, v_max·elapsed)   (≥ nominal)
 *     lag      = nominal − dir·(0.3 km + 0.5 km/min · dataAge)   (not behind L)
 *     beyond N with no new report → continue on schedule shifted by δ, lead
 *     assumes up to 5 min recovery, lag assumes up to 10 min further loss.
 *
 *   SCHEDULE mode (no/stale live data), δ₀ = last known delay or 0:
 *     nominal = s(now − δ₀),  lead = s(now − δ₀ + 5 min),  lag = s(now − δ₀ − 120 min)
 *     → flagged UNCONFIRMED; the alert engine caps these at WARN.
 */
import { TRAINS } from './timetable-data.js';
import { STATION_BY_CODE } from './corridor.js';
import { candidateRuns, positionAtTime, nextPointAhead, pointByCode, dirSign, timeAtKm } from './timetable-data.js';

const CFG = {
  pollIntervalS: 30,          // per train, while relevant
  requestTimeoutMs: 8000,
  maxBackoffS: 300,
  liveFreshMaxAgeS: 15 * 60,  // older reports are treated as schedule-only
  unknownDelayWindowMin: 120,
  earlyRunningMin: 5,
  maxConcurrent: 4,
};

/* ------------------------------------------------------------------ *
 * Provider adapter. Map whatever your upstream returns into this shape.
 * ------------------------------------------------------------------ */
/**
 * @typedef {Object} LiveStatus
 * @property {string}  trainNo
 * @property {string}  lastStationCode   last station departed/passed (or arrived)
 * @property {'DEPARTED'|'ARRIVED'|'PASSED'} event
 * @property {number|null} actualEventMs actual time of that event, epoch ms
 * @property {number}  delayMin          + late / − early
 * @property {number|null} speedKmh      if the provider has it (GPS-based feeds)
 * @property {number}  reportedAtMs      when the provider generated the record
 */
export function normalizeLiveStatus(raw, trainNo, nowMs) {
  if (!raw || typeof raw !== 'object') return null;
  const code = String(raw.last_station_code ?? raw.lastStation ?? raw.current_station ?? '').toUpperCase();
  const delayMin = Number(raw.delay_min ?? raw.delay ?? raw.late_mins);
  const actual = raw.actual_departure ?? raw.actual_time ?? raw.actualDeparture ?? null;
  const reported = raw.updated_at ?? raw.reported_at ?? raw.timestamp ?? null;
  const out = {
    trainNo,
    lastStationCode: code,
    event: (raw.event ?? (raw.has_departed === false ? 'ARRIVED' : 'DEPARTED')).toUpperCase(),
    actualEventMs: actual ? Date.parse(actual) : null,
    delayMin: Number.isFinite(delayMin) ? delayMin : NaN,
    speedKmh: Number.isFinite(Number(raw.speed_kmh)) ? Number(raw.speed_kmh) : null,
    reportedAtMs: reported ? Date.parse(reported) : nowMs,
  };
  // Validation — reject garbage instead of trusting it
  if (!STATION_BY_CODE[out.lastStationCode] && !raw.allow_off_corridor) return null;
  if (!Number.isFinite(out.delayMin) || out.delayMin < -30 || out.delayMin > 1440) return null;
  if (out.reportedAtMs > nowMs + 5 * 60000) return null;                // clock skew / bad data
  if (out.actualEventMs && out.actualEventMs > nowMs + 2 * 60000) return null;
  if (out.speedKmh != null && (out.speedKmh < 0 || out.speedKmh > 160)) out.speedKmh = null;
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure position estimator (unit-tested)
 * ------------------------------------------------------------------ */
export function estimatePosition(run, live, nowMs, lastKnownDelayMin = null) {
  const { train, runStartMs } = run;
  const dir = dirSign(train);
  const vmaxKmPerMs = train.vmaxKmh / 3600000;
  const base = { key: run.key, no: train.no, name: train.name, te: train.te, dir: train.dir, line: live?.wrongLine ? 'BOTH' : train.dir,
    vmaxKmh: train.vmaxKmh, lengthKm: train.lengthKm };

  const dataAgeS = live ? (nowMs - live.reportedAtMs) / 1000 : Infinity;
  const anchor = live && pointByCode(train, runStartMs, live.lastStationCode);
  const anchorKm = live && STATION_BY_CODE[live.lastStationCode]?.km;

  if (live && dataAgeS <= CFG.liveFreshMaxAgeS && anchorKm != null) {
    const delayMs = live.delayMin * 60000;
    // Scheduled departure at the anchor: booked halt, or interpolated pass time
    const schedDepMs = anchor ? anchor.depMs : timeAtKm(train, runStartMs, anchorKm);
    // ✅ FIX: add the delay (or use the actual timestamp as-is)
    let depActualMs = live.actualEventMs ?? (schedDepMs != null ? schedDepMs + delayMs : live.reportedAtMs);
    if (live.event === 'ARRIVED') depActualMs = Math.max(nowMs, depActualMs); // still standing at L

    const next = nextPointAhead(train, runStartMs, anchorKm);
    const elapsedMs = Math.max(0, nowMs - depActualMs);
    let nominal, lead, lag, phase;

    if (!next) {
      nominal = anchorKm + dir * elapsedMs * vmaxKmPerMs * 0.8;  // beyond last booked point
      lead = anchorKm + dir * elapsedMs * vmaxKmPerMs; phase = 'AFTER';
    } else {
      const arrNextActualMs = next.arrMs + delayMs;
      const span = Math.abs(next.km - anchorKm);
      if (nowMs <= arrNextActualMs) {
        const denom = Math.max(60000, arrNextActualMs - depActualMs);
        const f = Math.min(1, Math.max(0, elapsedMs / denom));
        nominal = anchorKm + dir * f * span;
        lead = anchorKm + dir * Math.min(span, elapsedMs * vmaxKmPerMs);
        phase = live.event === 'ARRIVED' ? 'HALT' : 'RUNNING';
      } else {
        // Overdue at N and no fresh report: schedule shifted by δ, bounded recovery
        const pN = positionAtTime(train, runStartMs, nowMs - delayMs);
        const pL = positionAtTime(train, runStartMs, nowMs - delayMs + CFG.earlyRunningMin * 60000);
        nominal = pN?.km ?? next.km; lead = pL?.km ?? nominal; phase = pN?.phase ?? 'AFTER';
      }
    }
    lead = dir > 0 ? Math.max(lead, nominal) : Math.min(lead, nominal);
    lag = nominal - dir * (0.3 + 0.5 * (dataAgeS / 60));
    lag = dir > 0 ? Math.max(lag, anchorKm) : Math.min(lag, anchorKm);   // never behind confirmed L

    const bookedH = next && schedDepMs != null ? (next.arrMs - schedDepMs) / 3600000 : 0;
    const secKmh = bookedH > 0 ? Math.abs(next.km - anchorKm) / bookedH : train.vmaxKmh * 0.8;
    return { ...base, source: 'LIVE', confirmed: true, dataAgeS, delayMin: live.delayMin, phase,
      kmNominal: nominal, kmLead: lead, kmLag: lag, speedKmh: live.speedKmh ?? Math.min(train.vmaxKmh, secKmh) };
  }

  // ---------- SCHEDULE fallback ----------
  const d0 = (lastKnownDelayMin ?? 0) * 60000;
  const pNom = positionAtTime(train, runStartMs, nowMs - d0);
  const pLead = positionAtTime(train, runStartMs, nowMs - d0 + CFG.earlyRunningMin * 60000);
  const pLag = positionAtTime(train, runStartMs, nowMs - d0 - CFG.unknownDelayWindowMin * 60000, CFG.unknownDelayWindowMin + 60);
  if (!pNom && !pLead) return null;
  const nominal = pNom?.km ?? pLead.km;
  return { ...base, source: 'SCHEDULE', confirmed: false, dataAgeS, delayMin: lastKnownDelayMin, phase: pNom?.phase ?? 'BEFORE',
    kmNominal: nominal, kmLead: pLead?.km ?? nominal,
    // lag unknown → train may not even have started: infinitely "behind"
    kmLag: pLag?.km ?? (dir > 0 ? -Infinity : Infinity), speedKmh: train.vmaxKmh * 0.75 };
}

/* ------------------------------------------------------------------ *
 * Polling service
 * ------------------------------------------------------------------ */
/**
 * Compute continuous live corridor position directly from `/api/corridor-live` entries.
 * Anchored to RailRadar's server timestamp (`refNowMs`) so client clock skew never distorts km.
 */
export function buildLiveCorridorState(entry, refNowMs) {
  const staticTrain = TRAINS.find(t => t.no === entry.no);
  const detail = entry.detail;
  const dir = entry.dir || detail?.dir || staticTrain?.dir;
  if (!dir) return null;

  const sign = dir === 'UP' ? 1 : -1;
  const vmaxKmh = detail?.vmax_kmh || staticTrain?.vmaxKmh || 115;
  const nomSpeed = detail?.speed_kmh || staticTrain?.speedKmh || 85;
  const delayMin = Number(detail?.delay_min ?? entry.delayMin ?? 0) || 0;

  let kmNominal = null;
  let kmLead = null;
  let kmLag = null;
  let speedKmh = nomSpeed;
  let phase = 'RUNNING';
  let dataAgeS = 0;
  let lastStation = null;

  if (detail && STATION_BY_CODE[detail.last_station_code]) {
    const st = STATION_BY_CODE[detail.last_station_code];
    lastStation = detail.last_station_code;
    const updMs = Date.parse(detail.updated_at || '') || refNowMs;
    dataAgeS = Math.max(0, (refNowMs - updMs) / 1000);
    const depMs = Date.parse(detail.actual_departure || '') || updMs;
    const dtSinceDepH = Math.max(0, Math.min(1.5, (refNowMs - depMs) / 3600000));
    const reportedOffsetKm = Number(detail.distance_from_last_km || 0);

    if (detail.event === 'ARRIVED' && dataAgeS < 180) {
      kmNominal = st.km;
      kmLead = st.km + sign * Math.min(3, (dataAgeS / 3600) * vmaxKmh + 0.5);
      kmLag = st.km;
      phase = 'HALTED';
    } else {
      const movedKm = Math.max(reportedOffsetKm, nomSpeed * dtSinceDepH);
      kmNominal = st.km + sign * movedKm;
      const spreadKm = Math.max(0.8, Math.min(8, (dataAgeS / 3600) * vmaxKmh * 0.4 + 0.8));
      kmLead = kmNominal + sign * spreadKm;
      kmLag = kmNominal - sign * spreadKm;
      phase = 'RUNNING';
    }
  } else {
    const anchors = ['SKM', 'OGL', 'NLR'];
    for (const code of anchors) {
      const b = entry.boards?.[code];
      if (!b) continue;
      const tMs = Date.parse(b.expectedArrival || b.expectedDeparture || '');
      if (!Number.isFinite(tMs)) continue;
      const st = STATION_BY_CODE[code];
      const dtH = (tMs - refNowMs) / 3600000;
      if (Math.abs(dtH) > 2.5) continue;
      lastStation = code;
      kmNominal = st.km - sign * (nomSpeed * dtH);
      kmLead = kmNominal + sign * 2.0;
      kmLag = kmNominal - sign * 2.0;
      phase = b.type === 'at-station' ? 'HALTED' : 'RUNNING';
      break;
    }
  }

  if (kmNominal == null || !Number.isFinite(kmNominal)) return null;
  if (kmNominal < 60 || kmNominal > 510) return null;

  return {
    key: `LIVE-${entry.no}`,
    no: entry.no,
    name: staticTrain?.name || entry.name || `Train ${entry.no}`,
    te: staticTrain?.te || entry.name || entry.no,
    dir,
    line: dir,
    vmaxKmh,
    speedKmh,
    lengthKm: staticTrain?.lengthKm || 0.55,
    source: 'LIVE',
    confirmed: Boolean(entry.isLive),
    dataAgeS,
    delayMin,
    phase,
    lastStation,
    nextHalt: detail?.next_halt_code || null,
    kmNominal,
    kmLead,
    kmLag,
  };
}

export class LiveTrainService {
  constructor(opts = {}) {
    this.fetchCorridorLive = opts.fetchCorridorLive || null;
    this.fetchLive = opts.fetchLive || null;
    this.liveByKey = new Map();
    this.corridorSnapshot = null; // { trains, fetchedAt, serverNowMs, anchors }
    this.lastSuccessAt = 0;
    this.lastErrorAt = 0;
    this.preferLive = true;
    this.inflight = false;
  }

  /**
   * Live-Data-First poll: hits `/api/corridor-live` (OGL/SKM/NLR live boards + live detail)
   * catching every real-time delayed & special train across the corridor.
   */
  async poll(workerKm, nowMs = Date.now(), forceFresh = false) {
    if (!this.preferLive || this.inflight) return;
    this.inflight = true;
    try {
      if (this.fetchCorridorLive) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 11000);
          const snap = await this.fetchCorridorLive(ctrl.signal, forceFresh);
          clearTimeout(timer);
          if (snap && snap.ok && Array.isArray(snap.trains)) {
            const parsedServerMs = Date.parse(snap.updatedAt || '');
            this.corridorSnapshot = {
              ...snap,
              fetchedAt: nowMs,
              serverNowMs: Number.isFinite(parsedServerMs) ? parsedServerMs : nowMs,
            };
            this.lastSuccessAt = nowMs;
          }
        } catch {
          this.lastErrorAt = nowMs;
        }
      }
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Returns corridor train states at `nowMs`.
   * Live RailRadar corridor feed always takes priority whenever fresh (< 5 min).
   * Embedded 53-train timetable serves strictly as offline / dead-zone fallback.
   */
  getTrainStates(workerKm, nowMs = Date.now()) {
    const liveFresh = this.preferLive && this.corridorSnapshot && (nowMs - this.corridorSnapshot.fetchedAt < 300000);
    const out = [];
    const seenNos = new Set();

    if (liveFresh) {
      const refNowMs = this.corridorSnapshot.serverNowMs + Math.max(0, nowMs - this.corridorSnapshot.fetchedAt);
      for (const entry of this.corridorSnapshot.trains) {
        const st = buildLiveCorridorState(entry, refNowMs);
        if (!st) continue;
        seenNos.add(st.no);
        out.push(st);
      }
    }

    // Offline / fallback schedule path when live feed is unavailable
    if (!liveFresh || out.length === 0) {
      for (const run of candidateRuns(nowMs)) {
        if (seenNos.has(run.train.no)) continue;
        const live = this.liveByKey.get(run.key) || null;
        const est = estimatePosition(run, live, nowMs);
        if (!est) continue;
        out.push({
          key: run.key,
          no: run.train.no, name: run.train.name, te: run.train.te,
          dir: run.train.dir, line: run.train.dir,
          vmaxKmh: run.train.vmaxKmh,
          lengthKm: run.train.lengthKm || 0.5,
          ...est,
        });
      }
    }
    return out;
  }

  feedStatus(nowMs = Date.now()) {
    if (!this.preferLive) return { state: 'OFFLINE', ageS: Infinity, liveCount: 0 };
    if (!this.lastSuccessAt) return { state: 'SCHEDULE', ageS: Infinity, liveCount: 0 };
    const ageS = (nowMs - this.lastSuccessAt) / 1000;
    const liveCount = this.corridorSnapshot?.trains?.length || 0;
    if (ageS < 180) return { state: 'LIVE', ageS, liveCount };
    if (ageS < 420) return { state: 'STALE', ageS, liveCount };
    return { state: 'SCHEDULE', ageS, liveCount: 0 };
  }
}
