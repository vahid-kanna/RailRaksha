/**
 * gps-tracker.js — Resilient worker-location engine.
 *
 * STATE MACHINE (evaluated every tick, not only on GPS callbacks)
 *
 *   ACQUIRING ──fix ok──▶ LOCKED ──age>15s | acc>50m | off>150m──▶ DEGRADED
 *       │                   ▲                                         │
 *       │                   └──────────── fresh good fix ─────────────┘
 *       │                                                              │ age>120s
 *       └──(30s no fix | PERMISSION_DENIED)──▶ FALLBACK ◀──────────────┘
 *
 *   FALLBACK uses the manual beat (if set) else the cached fix with growing
 *   uncertainty. Position is NEVER nulled by a transient error callback.
 *
 * FILTER: 2-state constant-velocity Kalman on along-track chainage s (metres).
 *   x = [s, v]ᵀ,  F = [[1,dt],[0,1]],  Q = q·[[dt³/3, dt²/2],[dt²/2, dt]]
 *   z = projected chainage,  H = [1,0],  R = σ_gps²  (from coords.accuracy)
 *   Innovation gate: y²/S > 9 (3σ) → reject; 3 consecutive rejects → re-init
 *   (handles the gang genuinely relocating by motor trolley / road vehicle).
 */
import { projectToTrack, STATION_BY_CODE, describeKm } from './corridor.js';

export const GPS_STATE = Object.freeze({
  ACQUIRING: 'ACQUIRING', LOCKED: 'LOCKED', DEGRADED: 'DEGRADED', FALLBACK: 'FALLBACK',
});

const CFG = {
  lockMaxAgeS: 15, lockMaxAccM: 50, lockMaxOffsetM: 150,
  degradedMaxAgeS: 120, degradedMaxAccM: 250,
  acquireTimeoutS: 30,
  maxOffCorridorM: 600,        // beyond this the fix is not on this corridor at all
  walkSpeedMps: 1.5,           // uncertainty growth while cached
  q: 0.8,                      // process noise (m²/s³); raise for motor-trolley use
  manualBeatSigmaM: 2000,      // manual beat = "somewhere within ±2 km of the station"
};

export class AlongTrackKalman {
  constructor() { this.reset(); }
  reset() { this.s = null; this.v = 0; this.P = [[1e6, 0], [0, 25]]; this.t = null; this.rejects = 0; }
  predict(tMs) {
    if (this.s == null) return;
    const dt = Math.max(0, (tMs - this.t) / 1000);
    if (dt === 0) return;
    const { q } = CFG, [[a, b], [c, d]] = this.P;
    this.s += this.v * dt;
    // P = F P Fᵀ + Q
    const p00 = a + dt * (b + c) + dt * dt * d + q * dt ** 3 / 3;
    const p01 = b + dt * d + q * dt ** 2 / 2;
    const p11 = d + q * dt;
    this.P = [[p00, p01], [p01, p11]];
    this.t = tMs;
  }
  /** @returns {boolean} accepted */
  update(zM, sigmaM, tMs) {
    if (this.s == null) { this.s = zM; this.v = 0; this.P = [[sigmaM ** 2, 0], [0, 4]]; this.t = tMs; return true; }
    this.predict(tMs);
    const R = sigmaM ** 2, S = this.P[0][0] + R, y = zM - this.s;
    if ((y * y) / S > 9) {
      if (++this.rejects >= 3) { this.reset(); return this.update(zM, sigmaM, tMs); }
      return false;
    }
    this.rejects = 0;
    const K0 = this.P[0][0] / S, K1 = this.P[1][0] / S;
    this.s += K0 * y; this.v += K1 * y;
    const [[a, b], [, d]] = this.P;
    this.P = [[(1 - K0) * a, (1 - K0) * b], [(1 - K0) * b, d - K1 * b]];
    // workers on foot: clamp velocity to something physical
    this.v = Math.max(-20, Math.min(20, this.v));
    return true;
  }
  sigma() { return this.s == null ? Infinity : Math.sqrt(Math.max(0, this.P[0][0])); }
}

export class GpsTracker extends EventTarget {
  constructor({ storage = globalThis.localStorage, geolocation = globalThis.navigator?.geolocation, now = () => Date.now() } = {}) {
    super();
    this.geo = geolocation; this.storage = storage; this.now = now;
    this.kf = new AlongTrackKalman();
    this.state = GPS_STATE.ACQUIRING;
    this.startedAt = now();
    this.lastFix = null;          // { km, offsetM, accM, t, lat, lon }
    this.lastError = null;
    this.permissionDenied = false;
    this.manual = this._loadManual(); // { code, km } | null
    this.watchId = null;
  }

  start() {
    if (!this.geo) { this.permissionDenied = true; this.tick(); return; }
    this.watchId = this.geo.watchPosition(
      p => this._onFix(p),
      e => this._onError(e),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  }
  stop() { if (this.watchId != null) this.geo.clearWatch(this.watchId); this.watchId = null; }

  /** Manual beat: station code, optional km offset (±) for fine positioning. */
  setManualBeat(code, kmAdjust = 0) {
    const st = STATION_BY_CODE[code];
    if (!st) throw new Error(`Unknown station ${code}`);
    this.manual = { code, km: st.km + kmAdjust };
    this.storage?.setItem('rr.manualBeat', JSON.stringify(this.manual));
    this.tick();
  }
  nudgeManual(deltaKm) { if (this.manual) this.setManualBeat(this.manual.code, this.manual.km - STATION_BY_CODE[this.manual.code].km + deltaKm); }
  clearManualBeat() { this.manual = null; this.storage?.removeItem('rr.manualBeat'); this.tick(); }

  _loadManual() { try { return JSON.parse(this.storage?.getItem('rr.manualBeat')) || null; } catch { return null; } }

  _onFix(p) {
    const { latitude: lat, longitude: lon, accuracy: accM = 50 } = p.coords;
    const t = p.timestamp || this.now();
    const hint = this.kf.s != null ? this.kf.s / 1000 : this.manual?.km ?? null;
    const proj = projectToTrack(lat, lon, hint);
    this.lastError = null; this.permissionDenied = false;
    if (proj.offsetM > CFG.maxOffCorridorM) {
      this.lastFix = { ...proj, accM, t, lat, lon, offCorridor: true };
      this.tick(); return;
    }
    // Effective measurement σ: GPS accuracy (≈68%) inflated by cross-track offset
    const sigma = Math.max(5, Math.hypot(accM, proj.offsetM * 0.5));
    const accepted = this.kf.update(proj.km * 1000, sigma, t);
    this.lastFix = { ...proj, accM, t, lat, lon, accepted, offCorridor: false };
    this.tick();
  }

  _onError(e) {
    // ❌ OLD BUG: window._lastGPS = null  → dropped to schedule math on every flicker.
    // ✅ Keep the cached estimate; only the state machine decides degradation.
    this.lastError = { code: e.code, message: e.message, t: this.now() };
    if (e.code === 1) this.permissionDenied = true;   // PERMISSION_DENIED
    this.tick();
  }

  /** Call at 1 Hz from the app loop; also called on every callback. */
  tick() {
    const now = this.now();
    const prev = this.state;
    const fix = this.lastFix;
    const ageS = fix ? (now - fix.t) / 1000 : Infinity;
    let next;
    if (!fix || fix.offCorridor) {
      next = (this.permissionDenied || (now - this.startedAt) / 1000 > CFG.acquireTimeoutS) ? GPS_STATE.FALLBACK : GPS_STATE.ACQUIRING;
    } else if (ageS <= CFG.lockMaxAgeS && fix.accM <= CFG.lockMaxAccM && fix.offsetM <= CFG.lockMaxOffsetM) {
      next = GPS_STATE.LOCKED;
    } else if (ageS <= CFG.degradedMaxAgeS && fix.accM <= CFG.degradedMaxAccM) {
      next = GPS_STATE.DEGRADED;
    } else {
      next = GPS_STATE.FALLBACK;
    }
    this.state = next;
    if (next !== prev) this.dispatchEvent(new CustomEvent('statechange', { detail: { from: prev, to: next } }));
    return next;
  }

  /**
   * Worker position consumed by the alert engine. Never throws; returns null
   * only when there is literally no information (UI must then force beat pick).
   * @returns {{km:number, sigmaM:number, source:'GPS'|'GPS_CACHED'|'MANUAL', state:string, ageS:number, label:string, badge:string}|null}
   */
  getPosition() {
    const now = this.now();
    const st = this.tick();
    const fix = this.lastFix;
    const ageS = fix ? (now - fix.t) / 1000 : Infinity;
    const haveKf = this.kf.s != null && fix && !fix.offCorridor;

    if (haveKf && (st === GPS_STATE.LOCKED || st === GPS_STATE.DEGRADED)) {
      // uncertainty grows with worker walking speed while cached
      const grow = st === GPS_STATE.DEGRADED ? CFG.walkSpeedMps * ageS : 0;
      const sigmaM = Math.hypot(this.kf.sigma(), grow);
      const km = this.kf.s / 1000;
      const badge = st === GPS_STATE.LOCKED
        ? `GPS LOCKED ±${Math.round(Math.max(sigmaM, fix.accM))}m`
        : `GPS CACHED ${Math.round(ageS)}s ago · km ${km.toFixed(1)}`;
      return { km, sigmaM, source: st === GPS_STATE.LOCKED ? 'GPS' : 'GPS_CACHED', state: st, ageS, label: describeKm(km), badge };
    }
    if (this.manual) {
      return { km: this.manual.km, sigmaM: CFG.manualBeatSigmaM, source: 'MANUAL', state: st, ageS: 0,
        label: describeKm(this.manual.km), badge: `MANUAL BEAT · ${this.manual.code} km ${this.manual.km.toFixed(1)}` };
    }
    if (haveKf) {
      // FALLBACK without manual beat: still better than nothing, but huge σ + prompt
      const sigmaM = Math.hypot(this.kf.sigma(), CFG.walkSpeedMps * ageS);
      const km = this.kf.s / 1000;
      return { km, sigmaM, source: 'GPS_CACHED', state: st, ageS, label: describeKm(km),
        badge: `GPS LOST ${Math.round(ageS / 60)}m · SELECT BEAT` };
    }
    return null;
  }
}
