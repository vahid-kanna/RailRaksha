/**
 * train-alert.js — Track-aware threat engine + single-voice alert orchestrator.
 *
 * APPROACH TEST (dir = +1 UP, −1 DN; s_w = worker km, σ_w = worker σ in km)
 *   D_lead = (s_w − s_lead)·dir − σ_w      smallest plausible distance-to-go
 *   D_lag  = (s_w − s_lag )·dir + σ_w      largest  plausible distance-to-go
 *   APPROACHING  ⇔ D_lead > 0
 *   AT WORKSITE  ⇔ D_lead ≤ 0  ∧  D_lag ≥ −(L_train + buffer)
 *   PASSED       ⇔ D_lag  < −(L_train + buffer)
 *   ETA_lower    = D_lead / v_max          (never optimistic)
 *
 * LEVELS (escalate instantly, de-escalate after 15 s continuously lower)
 *   CRITICAL : ETA_lower ≤ T_clear (180 s)  ∨ D_lead ≤ 3 km  ∨ AT WORKSITE
 *   WARN     : ETA_lower ≤ 300 s            ∨ D_lead ≤ 8 km
 *   PREPARE  : ETA_lower ≤ 600 s            ∨ D_lead ≤ 15 km
 *   AMBIENT  : ETA_lower ≤ 30 min
 *   Unconfirmed (schedule-only) trains are capped at WARN.
 *
 * TRACK FILTER
 *   active ⇔ mode = BOTH ∨ train.line = BOTH ∨ train.line = mode
 *   Non-active trains are AMBIENT for sirens, BUT a non-active CRITICAL raises a
 *   one-shot "ADJACENT LINE" cue: stepping back onto the other line into an
 *   oncoming train is a classic gangman fatality pattern; silencing it fully is wrong.
 */

export const LEVEL = Object.freeze({ NONE: 0, AMBIENT: 1, PREPARE: 2, WARN: 3, CRITICAL: 4, CLEARED: -1 });
export const LEVEL_NAME = { 0: 'NONE', 1: 'AMBIENT', 2: 'PREPARE', 3: 'WARN', 4: 'CRITICAL', '-1': 'CLEARED' };
export const TRACK_MODE = Object.freeze({ UP: 'UP', DN: 'DN', BOTH: 'BOTH' });

export const DEFAULT_ALERT_CFG = {
  clearanceS: 180, warnS: 300, prepareS: 600, ambientS: 1800,
  criticalKm: 3, warnKm: 8, prepareKm: 15,
  passBufferKm: 0.2, deescalateHoldS: 15,
  unconfirmedMaxLevel: LEVEL.WARN,
};

/** Pure evaluation of one train against one worker. */
export function evaluateTrain(worker, ts, cfg = DEFAULT_ALERT_CFG) {
  const dir = ts.dir === 'UP' ? 1 : -1;
  const sW = (worker.sigmaM ?? 0) / 1000;
  const dLead = (worker.km - ts.kmLead) * dir - sW;
  const dLag = (worker.km - ts.kmLag) * dir + sW;
  const dNom = (worker.km - ts.kmNominal) * dir;
  const passed = dLag < -(ts.lengthKm + cfg.passBufferKm);
  const atSite = !passed && dLead <= 0;
  const etaLowerS = dLead > 0 ? (dLead / ts.vmaxKmh) * 3600 : 0;
  const etaNomS = dNom > 0 ? (dNom / Math.max(20, ts.speedKmh || ts.vmaxKmh)) * 3600 : 0;

  let level;
  if (passed) level = ts.confirmed ? LEVEL.CLEARED : LEVEL.NONE;
  else if (!ts.confirmed && dLead <= 0) level = LEVEL.AMBIENT;       // "may still come" (delay unknown)
  else if (atSite || etaLowerS <= cfg.clearanceS || dLead <= cfg.criticalKm) level = LEVEL.CRITICAL;
  else if (etaLowerS <= cfg.warnS || dLead <= cfg.warnKm) level = LEVEL.WARN;
  else if (etaLowerS <= cfg.prepareS || dLead <= cfg.prepareKm) level = LEVEL.PREPARE;
  else if (etaLowerS <= cfg.ambientS) level = LEVEL.AMBIENT;
  else level = LEVEL.NONE;

  if (!ts.confirmed && level > cfg.unconfirmedMaxLevel) level = cfg.unconfirmedMaxLevel;
  return { level, atSite, passed, dLeadKm: dLead, dLagKm: dLag, dNomKm: dNom, etaLowerS, etaNomS };
}

export const isActiveLine = (line, mode) => mode === TRACK_MODE.BOTH || line === 'BOTH' || line === mode;

/**
 * Stateful engine: hysteresis per train, priority ordering, events.
 */
export class ThreatEngine {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_ALERT_CFG, ...cfg };
    this.mode = TRACK_MODE.BOTH;
    this.mem = new Map(); // key → { level, lowerSince, peak, clearedAnnounced, adjacentAnnounced }
  }
  setMode(mode) { if (!TRACK_MODE[mode]) throw new Error(mode); this.mode = mode; }

  update(worker, trainStates, nowMs) {
    if (!worker) return { primary: null, threats: [], ambient: [], events: [], noLocation: true };
    const events = [];
    const rows = [];
    const seen = new Set();
    for (const ts of trainStates) {
      seen.add(ts.key);
      const ev = evaluateTrain(worker, ts, this.cfg);
      const m = this.mem.get(ts.key) ?? { level: LEVEL.NONE, lowerSince: null, peak: LEVEL.NONE, clearedAnnounced: false, adjacentAnnounced: false };
      let level = m.level;
      if (ev.level === LEVEL.CLEARED) {
        if (m.peak >= LEVEL.WARN && !m.clearedAnnounced) { events.push({ type: 'CLEARED', ts }); m.clearedAnnounced = true; }
        level = LEVEL.CLEARED; m.lowerSince = null;
      } else if (ev.level >= m.level || m.level === LEVEL.CLEARED) {
        level = ev.level; m.lowerSince = null;
      } else {
        m.lowerSince ??= nowMs;
        if ((nowMs - m.lowerSince) / 1000 >= this.cfg.deescalateHoldS) { level = ev.level; m.lowerSince = null; }
      }
      m.level = level; m.peak = Math.max(m.peak, level);
      const active = isActiveLine(ts.line, this.mode);
      if (!active && level === LEVEL.CRITICAL && !ev.passed && !m.adjacentAnnounced) {
        events.push({ type: 'ADJACENT', ts }); m.adjacentAnnounced = true;
      }
      this.mem.set(ts.key, m);
      rows.push({ ...ts, ...ev, level, active });
    }
    for (const k of this.mem.keys()) if (!seen.has(k)) this.mem.delete(k);

    const score = r => (r.active ? 1e7 : 0) + Math.max(0, r.level) * 1e6 + (1e6 - Math.min(999999, r.etaLowerS));
    const visible = rows.filter(r => r.level > LEVEL.NONE).sort((a, b) => score(b) - score(a));
    const threats = visible.filter(r => r.active && r.level >= LEVEL.PREPARE);
    const ambient = visible.filter(r => !(r.active && r.level >= LEVEL.PREPARE));
    return { primary: threats[0] ?? null, threats, ambient, events, noLocation: false };
  }
}

/* ================================================================== *
 * Output channels
 * ================================================================== */

const TE_DIGITS = ['సున్నా', 'ఒకటి', 'రెండు', 'మూడు', 'నాలుగు', 'ఐదు', 'ఆరు', 'ఏడు', 'ఎనిమిది', 'తొమ్మిది'];
const EN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const LINE_TE = { UP: 'అప్ లైన్', DN: 'డౌన్ లైన్', BOTH: 'రెండు లైన్ల' };
const LINE_EN = { UP: 'UP line', DN: 'DOWN line', BOTH: 'either line' };
const spokenKm = d => (d >= 2 ? Math.round(d) : Math.max(0.5, Math.round(d * 2) / 2));

export function buildMessage(kind, r, extraCount = 0) {
  const teNo = [...r.no].map(c => TE_DIGITS[c] ?? c).join(' ');
  const enNo = [...r.no].map(c => EN_DIGITS[c] ?? c).join(' ');
  const km = spokenKm(Math.max(0, r.dLeadKm ?? 0));
  const min = Math.max(1, Math.round((r.etaLowerS ?? 0) / 60));
  const lt = LINE_TE[r.line], le = LINE_EN[r.line];
  const tag = r.confirmed === false ? { te: 'షెడ్యూల్ ప్రకారం, ', en: 'Scheduled, unconfirmed. ' } : { te: '', en: '' };
  const more = extraCount > 0 ? { te: ` మరో ${extraCount} రైలు కూడా వస్తోంది.`, en: ` Plus ${extraCount} more.` } : { te: '', en: '' };
  switch (kind) {
    case 'CRITICAL':
      if (r.atSite) return { te: `ప్రమాదం! ${lt} లో రైలు ${teNo} ఇక్కడే ఉంది! ట్రాక్ వదలండి!`, en: `Danger! Train ${enNo} at worksite on ${le}! Get clear!` };
      return { te: `ప్రమాదం! వెంటనే ట్రాక్ ఖాళీ చేయండి! ${lt} లో రైలు ${teNo}, ${km} కిలోమీటర్ల దూరం!${more.te}`,
               en: `Danger! Clear the track now! Train ${enNo} on ${le}, ${km} kilometres.${more.en}` };
    case 'WARN':
      return { te: `${tag.te}జాగ్రత్త! ${lt} లో రైలు ${teNo}, ${km} కిలోమీటర్ల దూరం! సామాను తీయండి.${more.te}`,
               en: `${tag.en}Warning! Train ${enNo} on ${le}, ${km} kilometres, about ${min} minutes. Remove tools.${more.en}` };
    case 'PREPARE':
      return { te: `${tag.te}సిద్ధంగా ఉండండి. ${lt} లో రైలు ${teNo}, ${min} నిమిషాల్లో.`,
               en: `${tag.en}Prepare. Train ${enNo} on ${le}, in about ${min} minutes.` };
    case 'ADJACENT':
      return { te: `పక్క ${lt} లో రైలు ${teNo} వస్తోంది. ఆ లైన్ పైకి వెళ్ళవద్దు!`, en: `Train ${enNo} on adjacent ${le}. Do not step onto it!` };
    case 'CLEARED':
      return { te: `రైలు ${teNo} వెళ్ళిపోయింది. తదుపరి రైలు కోసం చూడండి.`, en: `Train ${enNo} has passed. Watch for the next train.` };
    default: return { te: '', en: '' };
  }
}

/** One voice at a time. Higher priority pre-empts; equal/lower waits (latest wins). */
export class VoiceManager {
  constructor({ synth = globalThis.speechSynthesis, lang = 'te+en', clipPlayer = null } = {}) {
    this.synth = synth; this.lang = lang; this.clipPlayer = clipPlayer;
    this.current = null; this.pending = null; this.watchdog = null;
    this.teVoice = null; this.enVoice = null;
    const pick = () => {
      const v = this.synth?.getVoices?.() ?? [];
      this.teVoice = v.find(x => /^te(-|_|$)/i.test(x.lang)) ?? null;
      this.enVoice = v.find(x => /^en-IN/i.test(x.lang)) ?? v.find(x => /^en/i.test(x.lang)) ?? null;
    };
    pick(); this.synth?.addEventListener?.('voiceschanged', pick);
  }
  get hasTelugu() { return !!this.teVoice || !!this.clipPlayer; }

  speak(msg) { // msg: { priority, te, en, key }
    if (!this.synth) return;
    if (this.current) {
      if (msg.priority > this.current.priority) { this._stop(); }
      else { if (!this.pending || msg.priority >= this.pending.priority) this.pending = msg; return; }
    }
    this._play(msg);
  }
  _play(msg) {
    this.current = msg;
    const parts = [];
    const wantTe = this.lang !== 'en', wantEn = this.lang !== 'te' || !this.hasTelugu;
    if (wantTe && this.teVoice) parts.push({ text: msg.te, voice: this.teVoice, lang: 'te-IN' });
    else if (wantTe && this.clipPlayer) parts.push({ clip: msg.clipKey });
    if (wantEn) parts.push({ text: msg.en, voice: this.enVoice, lang: 'en-IN' });
    const totalChars = parts.reduce((n, p) => n + (p.text?.length ?? 40), 0);
    clearTimeout(this.watchdog); // Chrome sometimes never fires onend
    this.watchdog = setTimeout(() => this._done(), 2500 + totalChars * 90);
    parts.forEach((p, i) => {
      if (!p.text) return;
      const u = new SpeechSynthesisUtterance(p.text);
      if (p.voice) u.voice = p.voice; u.lang = p.lang; u.rate = 0.95; u.volume = 1;
      if (i === parts.length - 1) { u.onend = () => this._done(); u.onerror = () => this._done(); }
      this.synth.speak(u);
    });
  }
  _stop() { clearTimeout(this.watchdog); this.synth.cancel(); this.current = null; }
  _done() {
    clearTimeout(this.watchdog); this.current = null;
    const next = this.pending; this.pending = null;
    if (next) this._play(next);
  }
  cancelAll() { this.pending = null; this._stop(); }
}

/** One AudioContext, one pattern at a time. */
export class SirenManager {
  constructor() { this.ctx = null; this.level = LEVEL.NONE; this.timer = null; this.muteUntil = 0; }
  unlock() { // must be called from a user gesture
    this.ctx ??= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  _tone(freqA, freqB, durS, gain = 0.9) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(freqA, t);
    o.frequency.linearRampToValueAtTime(freqB, t + durS);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + durS);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + durS + 0.05);
  }
  set(level, { muted = false } = {}) {
    const eff = muted ? Math.min(level, LEVEL.PREPARE) : level;
    if (eff === this.level) return;
    this.level = eff; clearInterval(this.timer); this.timer = null;
    const P = {
      [LEVEL.PREPARE]:  { every: 0,    fn: () => { this._tone(880, 880, 0.18); setTimeout(() => this._tone(880, 880, 0.18), 300); } },
      [LEVEL.WARN]:     { every: 4000, fn: () => [0, 350, 700].forEach(d => setTimeout(() => this._tone(1000, 1000, 0.22), d)) },
      [LEVEL.CRITICAL]: { every: 1200, fn: () => { this._tone(700, 1400, 0.55); setTimeout(() => this._tone(1400, 700, 0.55), 600); } },
    }[eff];
    if (!P) return;
    P.fn(); if (P.every) this.timer = setInterval(P.fn, P.every);
  }
}

/** Distinct cadences: PREPARE = one soft nudge, WARN = triple pulse /5 s, CRITICAL = long-short continuous. */
export class HapticManager {
  constructor(nav = globalThis.navigator) { this.nav = nav; this.level = LEVEL.NONE; this.timer = null; }
  get supported() { return typeof this.nav?.vibrate === 'function'; } // iOS Safari: false
  set(level) {
    if (!this.supported || level === this.level) return;
    this.level = level; clearInterval(this.timer); this.nav.vibrate(0);
    const P = { [LEVEL.PREPARE]: [[250], 0], [LEVEL.WARN]: [[300, 150, 300, 150, 300], 5000], [LEVEL.CRITICAL]: [[900, 120, 200, 120], 1400] }[level];
    if (!P) return;
    this.nav.vibrate(P[0]); if (P[1]) this.timer = setInterval(() => this.nav.vibrate(P[0]), P[1]);
  }
}

export class Notifier {
  constructor() { this.lastKey = null; this.lastLevel = 0; }
  async notify(r, msg) {
    if (globalThis.Notification?.permission !== 'granted') return;
    const escalated = r.key !== this.lastKey || r.level > this.lastLevel;
    this.lastKey = r.key; this.lastLevel = r.level;
    if (!escalated) return;
    const reg = await globalThis.navigator?.serviceWorker?.getRegistration?.();
    const opts = { body: msg.en, tag: 'railraksha-threat', renotify: true, requireInteraction: r.level >= LEVEL.CRITICAL,
      vibrate: r.level >= LEVEL.CRITICAL ? [900, 120, 200] : [300, 150, 300], silent: false };
    const title = `${LEVEL_NAME[r.level]} · ${r.no} · ${r.line === 'UP' ? 'UP (BZA)' : 'DOWN (GDR)'}`;
    reg ? reg.showNotification(title, opts) : new Notification(title, opts);
  }
}

/**
 * Orchestrator: turns engine output into exactly one siren pattern, one
 * haptic pattern, one voice stream and one notification slot.
 */
export class AlertOrchestrator {
  constructor({ voice, siren, haptics, notifier, now = () => Date.now() }) {
    Object.assign(this, { voice, siren, haptics, notifier, now });
    this.lastSpoken = new Map(); // `${key}:${level}` → ms
    this.primaryKey = null; this.primaryLevel = LEVEL.NONE;
    this.ack = null; // { key, level, until }
    this.REPEAT_MS = { [LEVEL.CRITICAL]: 20000, [LEVEL.WARN]: 60000, [LEVEL.PREPARE]: Infinity };
  }
  acknowledge() {
    if (!this.primaryKey) return;
    const holdMs = this.primaryLevel >= LEVEL.CRITICAL ? 20000 : 45000;
    this.ack = { key: this.primaryKey, level: this.primaryLevel, until: this.now() + holdMs };
  }
  process(result) {
    const now = this.now();
    const p = result.primary;
    // events first (one-shots)
    for (const e of result.events) {
      if (e.type === 'ADJACENT') this.voice.speak({ priority: LEVEL.PREPARE, ...buildMessage('ADJACENT', e.ts), key: `${e.ts.key}:ADJ` });
      if (e.type === 'CLEARED' && (!p || p.level < LEVEL.WARN)) this.voice.speak({ priority: LEVEL.AMBIENT, ...buildMessage('CLEARED', e.ts), key: `${e.ts.key}:CLR` });
    }
    if (!p) { this.siren.set(LEVEL.NONE); this.haptics.set(LEVEL.NONE); this.primaryKey = null; this.primaryLevel = LEVEL.NONE; return; }

    const escalated = p.key !== this.primaryKey || p.level > this.primaryLevel;
    if (escalated || (this.ack && now > this.ack.until)) this.ack = null; // escalation always voids an ACK
    this.primaryKey = p.key; this.primaryLevel = p.level;
    const acked = !!this.ack && this.ack.key === p.key && this.ack.level >= p.level;

    this.siren.set(p.level, { muted: acked });
    this.haptics.set(acked ? Math.min(p.level, LEVEL.PREPARE) : p.level);

    const k = `${p.key}:${p.level}`;
    const last = this.lastSpoken.get(k) ?? 0;
    const repeat = this.REPEAT_MS[p.level] ?? Infinity;
    const voiceAllowed = !acked || p.level >= LEVEL.CRITICAL; // CRITICAL voice can't be acked away
    if (voiceAllowed && (escalated || now - last >= repeat)) {
      const extra = result.threats.filter(t => t.key !== p.key && t.level >= LEVEL.WARN).length;
      const msg = buildMessage(LEVEL_NAME[p.level], p, extra);
      this.voice.speak({ priority: p.level, ...msg, key: k });
      this.lastSpoken.set(k, now);
      if (escalated) this.notifier?.notify(p, msg);
    }
  }
}
