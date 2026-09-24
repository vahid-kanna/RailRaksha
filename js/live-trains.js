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
export class LiveTrainService extends EventTarget {
  /**
   * @param {{fetchLive:(trainNo:string, runDateISO:string, signal:AbortSignal)=>Promise<any>, now?:()=>number}} opts
   */
  constructor({ fetchLive, now = () => Date.now() }) {
    super();
    this.fetchLive = fetchLive; this.now = now;
    this.cache = new Map();   // key → { live, fetchedAt, failures, nextDueAt, lastKnownDelay }
    this.inflight = new Set();
    this.health = { ok: 0, fail: 0, lastOkAt: null };
  }

  async poll(workerKm) {
    if (workerKm == null) return;
    const now = this.now();
    const runs = candidateRuns(workerKm, now);
    const due = runs.filter(r => !this.inflight.has(r.key) && (this.cache.get(r.key)?.nextDueAt ?? 0) <= now)
      // nearest scheduled pass first
      .sort((a, b) => Math.abs(a.schedPassMs - now) - Math.abs(b.schedPassMs - now))
      .slice(0, CFG.maxConcurrent);
    await Promise.allSettled(due.map(r => this._fetchOne(r)));
  }

  async _fetchOne(run) {
    const entry = this.cache.get(run.key) ?? { live: null, fetchedAt: 0, failures: 0, nextDueAt: 0, lastKnownDelay: null };
    this.inflight.add(run.key);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CFG.requestTimeoutMs);
    try {
      const runDateISO = run.key.split('@')[1];
      const raw = await this.fetchLive(run.train.no, runDateISO, ctl.signal);
      const live = normalizeLiveStatus(raw, run.train.no, this.now());
      if (!live) throw new Error('invalid payload');
      // monotonic guard: ignore a report older than what we already hold
      if (!entry.live || live.reportedAtMs >= entry.live.reportedAtMs) entry.live = live;
      entry.lastKnownDelay = entry.live.delayMin;
      entry.failures = 0; entry.fetchedAt = this.now();
      entry.nextDueAt = this.now() + CFG.pollIntervalS * 1000;
      this.health.ok++; this.health.lastOkAt = this.now();
    } catch (err) {
      entry.failures++;
      const backoffS = Math.min(CFG.maxBackoffS, CFG.pollIntervalS * 2 ** (entry.failures - 1)) * (0.8 + Math.random() * 0.4);
      entry.nextDueAt = this.now() + backoffS * 1000;
      this.health.fail++;
      this.dispatchEvent(new CustomEvent('error', { detail: { key: run.key, err: String(err) } }));
    } finally {
      clearTimeout(timer); this.inflight.delete(run.key); this.cache.set(run.key, entry);
    }
  }

  /** Position envelopes for every candidate run. Never throws. */
  getTrainStates(workerKm) {
    if (workerKm == null) return [];
    const now = this.now();
    const out = [];
    for (const run of candidateRuns(workerKm, now)) {
      try {
        const e = this.cache.get(run.key);
        const st = estimatePosition(run, e?.live ?? null, now, e?.lastKnownDelay ?? null);
        if (st) out.push(st);
      } catch (err) { console.error('estimatePosition', run.key, err); }
    }
    return out;
  }

  feedStatus() {
    const now = this.now();
    const age = this.health.lastOkAt ? (now - this.health.lastOkAt) / 1000 : Infinity;
    return { state: age < 90 ? 'LIVE' : age < 600 ? 'STALE' : 'OFFLINE', ageS: age };
  }
}
