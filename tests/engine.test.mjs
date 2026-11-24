import test from 'node:test';
import assert from 'node:assert/strict';
import { projectToTrack, kmToLatLon, STATION_BY_CODE } from '../js/corridor.js';
import { AlongTrackKalman, GpsTracker, GPS_STATE } from '../js/gps-tracker.js';
import { TRAINS, istMidnight, timeAtKm, IST_OFFSET_MS } from '../js/timetable-data.js';
import { estimatePosition } from '../js/live-trains.js';
import { evaluateTrain, ThreatEngine, AlertOrchestrator, VoiceManager, LEVEL } from '../js/train-alert.js';

const T = no => TRAINS.find(t => t.no === no);
const ist = (hh, mm, day = Date.UTC(2026, 8, 24)) => day - IST_OFFSET_MS + (hh * 60 + mm) * 60000;
const RUN = istMidnight(ist(12, 0));

test('projection: station coordinates map to their chainage', () => {
  for (const c of ['BZA', 'SKM', 'UPD', 'KVZ', 'GDR']) {
    const s = STATION_BY_CODE[c]; const p = projectToTrack(s.lat, s.lon);
    assert.ok(Math.abs(p.km - s.km) < 0.05, `${c}: ${p.km}`); assert.ok(p.offsetM < 5);
  }
});
test('projection: km→latlon→km round-trip at km 284.2, and cross-track offset', () => {
  const ll = kmToLatLon(284.2); const p = projectToTrack(ll.lat, ll.lon);
  assert.ok(Math.abs(p.km - 284.2) < 0.02);
  const off = projectToTrack(ll.lat, ll.lon + 0.001); // ~107 m east
  assert.ok(off.offsetM > 60 && off.offsetM < 130, String(off.offsetM));
});

test('kalman: converges on noisy fixes and rejects a 2 km jump', () => {
  const kf = new AlongTrackKalman(); let t = 0;
  for (let i = 0; i < 30; i++) kf.update(284200 + (Math.random() - .5) * 30, 15, (t += 1000));
  assert.ok(Math.abs(kf.s - 284200) < 15);
  assert.equal(kf.update(286200, 15, (t += 1000)), false);
  assert.ok(Math.abs(kf.s - 284200) < 20);
});

test('gps: error callback does NOT drop position; state degrades over time', () => {
  let now = 1e12; const geo = { watchPosition(ok, err) { this.ok = ok; this.err = err; return 1; } };
  const g = new GpsTracker({ storage: null, geolocation: geo, now: () => now }); g.start();
  const ll = kmToLatLon(284.2);
  geo.ok({ coords: { latitude: ll.lat, longitude: ll.lon, accuracy: 8 }, timestamp: now });
  assert.equal(g.getPosition().state, GPS_STATE.LOCKED);
  now += 20000; geo.err({ code: 3, message: 'timeout' });
  const p = g.getPosition();
  assert.equal(p.state, GPS_STATE.DEGRADED); assert.ok(Math.abs(p.km - 284.2) < 0.05); assert.match(p.badge, /CACHED 20s/);
  now += 200000; assert.equal(g.getPosition().state, GPS_STATE.FALLBACK);
  g.setManualBeat('KVZ'); assert.equal(g.getPosition().source, 'MANUAL');
});

test('FLAW 1: pass time is computed at the WORKER km, not SKM', () => {
  const dn = T('12711'), up = T('12712');
  const skm = STATION_BY_CODE.SKM.km, kvz = STATION_BY_CODE.KVZ.km;
  assert.ok(timeAtKm(dn, RUN, kvz) > timeAtKm(dn, RUN, skm), 'DN reaches KVZ after SKM');
  assert.ok(timeAtKm(up, RUN, kvz) < timeAtKm(up, RUN, skm), 'UP reaches KVZ before SKM');
  const mid = timeAtKm(dn, RUN, 284.2); // between SKM dep 08:21 and KVZ arr 08:48
  assert.ok(mid > ist(8, 21) && mid < ist(8, 48));
});

test('FLAW 4: delay is ADDED to departure (30 min late train is NOT 55 km ahead)', () => {
  const run = { key: 'x', train: T('12711'), runStartMs: RUN };
  const now = ist(8, 45); // sched OGL dep 08:00, +30 late ⇒ actual 08:30 ⇒ 15 min out of 22 min booked to SKM (08:20+30=08:50)
  const live = { trainNo: '12711', lastStationCode: 'OGL', event: 'DEPARTED', actualEventMs: null, delayMin: 30, speedKmh: null, reportedAtMs: now - 60000 };
  const st = estimatePosition(run, live, now);
  const expected = 321 - (15 / 20) * (321 - 293);   // 300.0
  assert.ok(Math.abs(st.kmNominal - expected) < 0.5, `nominal ${st.kmNominal}`);
  assert.ok(st.kmLead <= st.kmNominal + 1e-9 && st.kmLead >= 293, 'lead ahead of nominal (DN = lower km), capped at SKM');
  assert.ok(st.kmLag >= st.kmNominal, 'lag behind nominal');
  // old buggy formula would have placed it: elapsed = 45+30 = 75 min → far past SKM
});

test('track filter: DOWN train is not primary when working UP line, but raises ADJACENT cue', () => {
  const eng = new ThreatEngine(); eng.setMode('UP');
  const worker = { km: 284.2, sigmaM: 10 };
  const dnTrain = { key: 'd', no: '20678', dir: 'DN', line: 'DN', confirmed: true, kmNominal: 287, kmLead: 286.8, kmLag: 287.3, vmaxKmh: 130, speedKmh: 120, lengthKm: .4 };
  const r = eng.update(worker, [dnTrain], 0);
  assert.equal(r.primary, null); assert.equal(r.ambient[0].level, LEVEL.CRITICAL);
  assert.equal(r.events[0].type, 'ADJACENT');
  eng.setMode('BOTH'); assert.equal(eng.update(worker, [dnTrain], 1000).primary.key, 'd');
});

test('levels: live 130 km/h train 5 km out is CRITICAL; schedule-only capped at WARN; passed = CLEARED', () => {
  const w = { km: 284.2, sigmaM: 0 };
  const base = { dir: 'UP', line: 'UP', vmaxKmh: 130, speedKmh: 125, lengthKm: .4 };
  assert.equal(evaluateTrain(w, { ...base, confirmed: true, kmNominal: 279.2, kmLead: 279.2, kmLag: 279 }).level, LEVEL.CRITICAL);
  assert.equal(evaluateTrain(w, { ...base, confirmed: false, kmNominal: 279.2, kmLead: 279.2, kmLag: 200 }).level, LEVEL.WARN);
  assert.equal(evaluateTrain(w, { ...base, confirmed: true, kmNominal: 286, kmLead: 286.1, kmLag: 285.5 }).level, LEVEL.CLEARED);
  assert.equal(evaluateTrain(w, { ...base, confirmed: true, kmNominal: 284.1, kmLead: 284.4, kmLag: 283.9 }).atSite, true);
});

test('hysteresis: no flapping on de-escalation for 15 s', () => {
  const eng = new ThreatEngine(); const w = { km: 284.2, sigmaM: 0 };
  const mk = lead => ({ key: 'u', no: '12712', dir: 'UP', line: 'UP', confirmed: true, kmNominal: lead, kmLead: lead, kmLag: lead - .3, vmaxKmh: 110, speedKmh: 100, lengthKm: .5 });
  assert.equal(eng.update(w, [mk(281)], 0).primary.level, LEVEL.CRITICAL);
  assert.equal(eng.update(w, [mk(276)], 5000).primary.level, LEVEL.CRITICAL);   // jitter: held
  assert.equal(eng.update(w, [mk(276)], 21000).primary.level, LEVEL.WARN);      // held 16 s → drop
});

test('voice: one utterance at a time, CRITICAL pre-empts, CRITICAL repeats every 20 s', () => {
  const spoken = []; let cancels = 0;
  globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  const synth = { getVoices: () => [{ lang: 'te-IN' }, { lang: 'en-IN' }], speak(u) { spoken.push(u); }, cancel() { cancels++; } };
  let now = 0;
  const voice = new VoiceManager({ synth, lang: 'te+en' });
  const noop = { set() {} };
  const orch = new AlertOrchestrator({ voice, siren: noop, haptics: noop, notifier: null, now: () => now });
  const row = (lvl, key = 'a') => ({ key, no: '12711', line: 'UP', level: lvl, confirmed: true, dLeadKm: 5, etaLowerS: 160, atSite: false });
  orch.process({ primary: row(LEVEL.WARN), threats: [row(LEVEL.WARN)], events: [] });
  assert.equal(spoken.length, 2); assert.match(spoken[0].text, /జాగ్రత్త! అప్ లైన్ లో రైలు ఒకటి రెండు ఏడు ఒకటి ఒకటి, 5 కిలోమీటర్ల దూరం/);
  now = 3000; orch.process({ primary: row(LEVEL.WARN), threats: [row(LEVEL.WARN)], events: [] });
  assert.equal(spoken.length, 2, 'no repeat within 60 s');
  now = 4000; orch.process({ primary: row(LEVEL.CRITICAL), threats: [row(LEVEL.CRITICAL)], events: [] });
  assert.equal(cancels, 1, 'CRITICAL cancelled the WARN speech'); assert.match(spoken[2].text, /ప్రమాదం/);
  voice._done();
  now = 10000; orch.process({ primary: row(LEVEL.CRITICAL), threats: [row(LEVEL.CRITICAL)], events: [] });
  assert.equal(spoken.length, 4);
  now = 25000; orch.process({ primary: row(LEVEL.CRITICAL), threats: [row(LEVEL.CRITICAL)], events: [] });
  assert.equal(spoken.length, 6, 'CRITICAL repeat at 20 s');
});


/* ── v7.0 Extended Enterprise Verification Suite ─────────────────────────── */
import { resolveAIProvider, normalizeRailRadarPayload, handleHealth, handleChat, handleLiveStatus } from '../worker/handlers.js';
import { getISTDateISO } from '../js/db.js';
import { buildOfflineDiaryEntry } from '../js/gang-diary.js';
import { estimateRailTempC } from '../js/weather-alert.js';
import { OFFLINE_DEFECT_PRESETS } from '../js/defect-report.js';
import { QUICK_RULES } from '../js/pw-manual.js';

test('IST date helper rolls over at 18:30 UTC (00:00 IST)', () => {
  // 2026-11-23 20:00:00 UTC == 2026-11-24 01:30:00 IST
  const utcLateNight = Date.parse('2026-11-23T20:00:00Z');
  assert.equal(getISTDateISO(utcLateNight), '2026-11-24');
  // 2026-11-23 18:29:00 UTC == 2026-11-23 23:59:00 IST
  const utcBeforeMidnightIST = Date.parse('2026-11-23T18:29:00Z');
  assert.equal(getISTDateISO(utcBeforeMidnightIST), '2026-11-23');
});

test('Offline Gang Diary formatter extracts materials, defects & safety cleanly', () => {
  const entry = buildOfflineDiaryEntry(
    'Packed 18 PSC sleepers between km 292 and 293. Tightened 30 ERC clips and replaced liners. Lookout man posted with red flag. Minor rail weld crack observed.',
    { dateStr: '24 November 2026', present: 24, total: 25, section: 'SKM–UPD' }
  );
  assert.match(entry.workDone, /^• /);
  assert.match(entry.materialsUsed, /ERC clips/i);
  assert.match(entry.materialsUsed, /PSC sleepers/i);
  assert.match(entry.defectsObserved, /crack/i);
  assert.match(entry.safetyMeasures, /Lookout man/i);
  assert.equal(entry.structuredBy, 'Offline Formatter');
});

test('LWR rail thermal estimation reflects solar peak vs night', () => {
  const summerNoonIST = new Date('2026-05-15T08:00:00Z'); // 13:30 IST
  const summerNightIST = new Date('2026-05-15T19:00:00Z'); // 00:30 IST
  const noonRail = estimateRailTempC(42, summerNoonIST);
  const nightRail = estimateRailTempC(30, summerNightIST);
  assert.ok(noonRail >= 65, `Expected midday summer rail temp >= 65°C, got ${noonRail}`);
  assert.ok(nightRail < 40, `Expected night rail temp < 40°C, got ${nightRail}`);
});

test('Cloudflare Worker handlers: /api/health, provider resolution, validation & RailRadar v1 normalization', async () => {
  // Provider priority
  assert.equal(resolveAIProvider({}), null);
  assert.equal(resolveAIProvider({ GEMINI_API_KEY: 'test', BYNARA_API_KEY: 'b' }).name, 'gemini');
  assert.equal(resolveAIProvider({ AI_API_KEY: 'x', GEMINI_API_KEY: 'y' }).name, 'custom');

  // Health response
  const hResp = await handleHealth(new Request('https://railraksha.tech/api/health'), { GEMINI_API_KEY: 'dummy' });
  assert.equal(hResp.status, 200);
  const hBody = await hResp.json();
  assert.equal(hBody.status, 'ok');
  assert.equal(hBody.services.ai.configured, true);
  assert.equal(hBody.services.ai.provider, 'gemini');
  assert.equal(hBody.services.liveTrains.configured, false);

  // /api/chat unconfigured returns clean 503 with code
  const cResp = await handleChat(
    new Request('https://railraksha.tech/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    }),
    {}
  );
  assert.equal(cResp.status, 503);
  const cBody = await cResp.json();
  assert.equal(cBody.error.code, 'ai_not_configured');

  // /api/live-status invalid train returns 400; missing key returns 501
  const badTrain = await handleLiveStatus(new Request('https://railraksha.tech/api/live-status?train=abc'), {});
  assert.equal(badTrain.status, 400);
  const noKey = await handleLiveStatus(new Request('https://railraksha.tech/api/live-status?train=12711'), {});
  assert.equal(noKey.status, 501);

  // RailRadar v1 normalization
  const norm = normalizeRailRadarPayload({
    success: true,
    data: {
      trainNumber: '12711',
      status: 'running',
      delayMinutes: 14,
      lastUpdatedAt: '2026-11-24T09:15:00+05:30',
      currentLocation: { stationCode: 'OGL', speed: 108, hasDeparted: true },
    },
  });
  assert.equal(norm.last_station_code, 'OGL');
  assert.equal(norm.delay_min, 14);
  assert.equal(norm.speed_kmh, 108);
  assert.equal(norm.event, 'DEPARTED');
});

test('Offline libraries & 47-train corridor timetable integrity', () => {
  assert.equal(OFFLINE_DEFECT_PRESETS.length, 8);
  assert.equal(QUICK_RULES.length, 14);
  assert.ok(TRAINS.length >= 45, `Expected >=45 trains, got ${TRAINS.length}`);
  for (const tr of TRAINS) {
    assert.ok(/^(\d{5}|FREIGHT-\d{2})$/.test(tr.no), `Invalid train no: ${tr.no}`);
    assert.ok(tr.dir === 'UP' || tr.dir === 'DN', `Invalid dir for ${tr.no}`);
    assert.ok(Array.isArray(tr.stops) && tr.stops.length >= 2, `Missing stops for ${tr.no}`);
    for (const [code] of tr.stops) {
      assert.ok(STATION_BY_CODE[code], `Unknown station code ${code} in train ${tr.no}`);
    }
  }
});
