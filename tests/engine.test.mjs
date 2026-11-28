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


test('v8.0 live-data-first corridor state & clock-skew safety', async () => {
  const { buildLiveCorridorState } = await import('../js/live-trains.js');
  const { inferDirectionFromEndpoints, resolveAIProvider } = await import('../worker/handlers.js');

  assert.equal(inferDirectionFromEndpoints('MAS', 'BZA'), 'UP');
  assert.equal(inferDirectionFromEndpoints('VSKP', 'TPTY'), 'DN');
  assert.equal(inferDirectionFromEndpoints('NDLS', 'MAS'), 'DN');
  assert.equal(inferDirectionFromEndpoints('ALLP', 'DHN'), 'UP');

  // Anchor to RailRadar server timestamp regardless of client clock drift
  const serverNow = Date.parse('2026-11-26T01:00:00+05:30');
  const st = buildLiveCorridorState({
    no: '17210',
    name: 'Seshadri Express',
    dir: 'DN',
    isLive: true,
    delayMin: 18,
    boards: {
      OGL: { type: 'upcoming', expectedArrival: '2026-11-26T01:06:00+05:30', delayMinutes: 18 },
    },
    detail: null,
  }, serverNow);

  assert.ok(st, 'Expected live corridor state');
  assert.equal(st.source, 'LIVE');
  assert.equal(st.confirmed, true);
  assert.equal(st.delayMin, 18);
  assert.equal(st.dir, 'DN');
  // 6 minutes upstream (north) of OGL (km 315) at ~85 km/h -> ~323.5 km
  assert.ok(st.kmNominal > 316 && st.kmNominal < 330, `Unexpected kmNominal=${st.kmNominal}`);

  // Verify Gemini 3 model failover chain
  const ai = resolveAIProvider({ GEMINI_API_KEY: 'test-key' });
  assert.equal(ai.name, 'gemini');
  assert.equal(ai.defaultModel, 'gemini-3-flash-preview');
  assert.ok(ai.fallbackModels.includes('gemini-3.5-flash'));
});

/* ── v8.1 Regression & Quota-Resilience Suite ─────────────────────────────── */
import {
  CORS_HEADERS,
  handleCorridorLive,
  inferDirectionFromEndpoints,
} from '../worker/handlers.js';
import { LiveTrainService } from '../js/live-trains.js';

function createMemoryCache() {
  const store = new Map();
  return {
    async match(req) {
      const key = typeof req === 'string' ? req : req.url;
      const hit = store.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) {
      const key = typeof req === 'string' ? req : req.url;
      store.set(key, res.clone());
    },
    _store: store,
  };
}

test('v8.1 offline fallback: LiveTrainService.getTrainStates(293, nowMs) returns scheduled trains at 02:58 AM and all IST hours', async () => {
  // Catches the old candidateRuns(nowMs) bug where nowMs was passed as workerKm and nowMs became undefined (NaN)
  const svc = new LiveTrainService();
  svc.preferLive = false;

  for (const [hh, mm] of [[2, 58], [0, 15], [8, 30], [14, 15], [21, 45]]) {
    const t = ist(hh, mm);
    const states = svc.getTrainStates(293, t);
    assert.ok(states.length > 0, `Expected scheduled trains at ${hh}:${String(mm).padStart(2, '0')} IST`);
    for (const s of states) {
      assert.equal(s.source, 'SCHEDULE');
      assert.equal(s.confirmed, false);
      assert.ok(Number.isFinite(s.kmNominal), `Expected finite kmNominal for ${s.no}`);
    }
  }

  // Also works when workerKm is omitted/nullish (defaults to SKM 293) and when preferLive=true hits quota 429 empty fallback
  const at0258 = ist(2, 58);
  assert.ok(svc.getTrainStates(undefined, at0258).length > 0);

  const quotaSvc = new LiveTrainService({
    fetchCorridorLive: async () => ({
      ok: false,
      quotaExceeded: true,
      stale: false,
      source: 'schedule-fallback',
      trains: [],
    }),
  });
  await quotaSvc.poll(293, at0258, true);
  const fs = quotaSvc.feedStatus(at0258);
  assert.equal(fs.state, 'QUOTA');
  assert.equal(fs.quotaExceeded, true);
  assert.equal(fs.liveCount, 0);
  const fallbackStates = quotaSvc.getTrainStates(293, at0258);
  assert.ok(fallbackStates.length > 0, 'Quota empty fallback must return scheduled trains at 02:58 AM IST');
  assert.ok(fallbackStates.every(t => t.source === 'SCHEDULE'));

  // Stale quota snapshot (< 15 min) is kept for QUOTA status and falls back to schedule once aged > 15 min
  const staleSnapTime = at0258 - 5 * 60000;
  const staleSvc = new LiveTrainService({
    fetchCorridorLive: async () => ({
      ok: false,
      quotaExceeded: true,
      stale: true,
      updatedAt: new Date(staleSnapTime).toISOString(),
      trains: [{
        no: '17210',
        name: 'Seshadri Express',
        dir: 'DN',
        isLive: true,
        delayMin: 5,
        boards: { OGL: { type: 'upcoming', expectedArrival: new Date(at0258 + 6 * 60000).toISOString(), delayMinutes: 5 } },
        detail: null,
      }],
    }),
  });
  await staleSvc.poll(293, at0258, true);
  assert.equal(staleSvc.feedStatus(at0258).state, 'QUOTA');
  assert.equal(staleSvc.feedStatus(at0258).stale, true);
  assert.equal(staleSvc.getTrainStates(293, at0258)[0].source, 'LIVE');
  // Once stale snapshot is > 15 min old, falls back cleanly to schedule
  assert.ok(staleSvc.getTrainStates(293, at0258 + 20 * 60000).every(t => t.source === 'SCHEDULE'));
});

test('v8.1 CORRIDOR_KM alignment with STATION_BY_CODE (OGL=321, NLR=200, GDR=162, CL=356, BVRT=232)', () => {
  assert.equal(STATION_BY_CODE.OGL.km, 321);
  assert.equal(STATION_BY_CODE.NLR.km, 200);
  assert.equal(STATION_BY_CODE.GDR.km, 162);
  assert.equal(STATION_BY_CODE.CL.km, 356);
  assert.equal(STATION_BY_CODE.BVRT.km, 232);

  // Verify worker CORRIDOR_KM via normalizeRailRadarPayload corridor_stops & inferDirectionFromEndpoints
  const norm = normalizeRailRadarPayload({
    data: {
      trainNumber: '12711',
      status: 'running',
      currentLocation: { stationCode: 'OGL', speed: 100, hasDeparted: true },
      route: [
        { stationCode: 'GDR' },
        { stationCode: 'NLR' },
        { stationCode: 'BVRT' },
        { stationCode: 'SKM' },
        { stationCode: 'OGL' },
        { stationCode: 'CL' },
        { stationCode: 'BZA' },
      ],
    },
  });
  const kmMap = Object.fromEntries(norm.corridor_stops.map(s => [s.code, s.km]));
  assert.deepEqual(kmMap, {
    GDR: STATION_BY_CODE.GDR.km,
    NLR: STATION_BY_CODE.NLR.km,
    BVRT: STATION_BY_CODE.BVRT.km,
    SKM: STATION_BY_CODE.SKM.km,
    OGL: STATION_BY_CODE.OGL.km,
    CL: STATION_BY_CODE.CL.km,
    BZA: STATION_BY_CODE.BZA.km,
  });

  assert.equal(inferDirectionFromEndpoints('GDR', 'NLR'), 'UP');
  assert.equal(inferDirectionFromEndpoints('NLR', 'BVRT'), 'UP');
  assert.equal(inferDirectionFromEndpoints('BVRT', 'OGL'), 'UP');
  assert.equal(inferDirectionFromEndpoints('OGL', 'CL'), 'UP');
  assert.equal(inferDirectionFromEndpoints('CL', 'OGL'), 'DN');
  assert.equal(inferDirectionFromEndpoints('OGL', 'GDR'), 'DN');
  assert.equal(inferDirectionFromEndpoints('NLR', 'BTTR'), 'UP');
  assert.equal(inferDirectionFromEndpoints('OGL', 'CLX'), 'UP');
});

test('v8.1 handleCorridorLive: 429 quota fallback returns HTTP 200, caches stale copy, and queries <=2 boards by default', async () => {
  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  const memCache = createMemoryCache();
  globalThis.caches = { default: memCache };

  try {
    const calledUrls = [];
    globalThis.fetch = async (url) => {
      calledUrls.push(String(url));
      return new Response(
        JSON.stringify({ error: { code: 'quota_exceeded', message: 'Monthly limit reached' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res429 = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live'),
      { RAILRADAR_API_KEY: 'test-env-key' }
    );
    assert.equal(res429.status, 200);
    assert.match(res429.headers.get('Cache-Control') || '', /s-maxage=180/);
    const body429 = await res429.json();
    assert.equal(body429.ok, false);
    assert.equal(body429.quotaExceeded, true);
    assert.equal(body429.stale, false);
    assert.equal(body429.source, 'schedule-fallback');
    assert.deepEqual(body429.trains, []);
    assert.equal(calledUrls.length, 2);
    assert.ok(calledUrls.some(u => u.includes('/stations/OGL/live')));
    assert.ok(calledUrls.some(u => u.includes('/stations/NLR/live')));
    assert.equal(calledUrls.some(u => u.includes('/v1/trains/')), false, 'No automatic train detail enrichment on routine polls');

    // Now seed cache via successful OGL + NLR poll, then simulate 429 on ?fresh=1 and verify stale fallback
    calledUrls.length = 0;
    memCache._store.clear();
    globalThis.fetch = async (url) => {
      calledUrls.push(String(url));
      const u = String(url);
      if (u.includes('/stations/NLR/live')) {
        return new Response(JSON.stringify({
          success: true,
          meta: { timestamp: '2026-11-26T02:55:00+05:30' },
          data: {
            trains: [{
              train: { number: '12711', name: 'Pinakini Express', type: 'SF', source: 'BZA', destination: 'MAS' },
              live: { type: 'upcoming', expectedArrivalTime: '2026-11-26T03:00:00+05:30', delayMinutes: 4 },
            }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        meta: { timestamp: '2026-11-26T02:55:00+05:30' },
        data: {
          trains: [{
            train: { number: '12711', name: 'Pinakini Express', type: 'SF', source: 'BZA', destination: 'MAS' },
            live: { type: 'upcoming', expectedArrivalTime: '2026-11-26T02:10:00+05:30', delayMinutes: 4 },
          }],
        },
      }), { status: 200 });
    };

    const okRes = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live'),
      { RAILRADAR_API_KEY: 'test-env-key' }
    );
    assert.equal(okRes.status, 200);
    assert.match(okRes.headers.get('Cache-Control') || '', /s-maxage=300/);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.liveEnriched, 0);
    assert.equal(okBody.trains.length, 1);
    assert.equal(okBody.trains[0].dir, 'DN'); // OGL (321) 02:10 -> NLR (200) 03:00 => DN

    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { code: 'quota_exceeded' } }),
      { status: 429 }
    );
    const staleRes = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live?fresh=1'),
      { RAILRADAR_API_KEY: 'test-env-key' }
    );
    assert.equal(staleRes.status, 200);
    const staleBody = await staleRes.json();
    assert.equal(staleBody.ok, false);
    assert.equal(staleBody.quotaExceeded, true);
    assert.equal(staleBody.stale, true);
    assert.equal(staleBody.source, 'schedule-fallback');
    assert.equal(staleBody.trains.length, 1);
    assert.equal(staleBody.trains[0].no, '12711');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});

test('v8.1 X-RailRadar-Key CORS header & personal key override in handleCorridorLive and handleLiveStatus', async () => {
  assert.match(CORS_HEADERS['Access-Control-Allow-Headers'], /\bX-RailRadar-Key\b/);

  const preflightCorridor = await handleCorridorLive(new Request('https://railraksha.tech/api/corridor-live', { method: 'OPTIONS' }), {});
  assert.equal(preflightCorridor.status, 204);
  assert.match(preflightCorridor.headers.get('Access-Control-Allow-Headers') || '', /\bX-RailRadar-Key\b/);

  const preflightLive = await handleLiveStatus(new Request('https://railraksha.tech/api/live-status?train=12711', { method: 'OPTIONS' }), {});
  assert.equal(preflightLive.status, 204);
  assert.match(preflightLive.headers.get('Access-Control-Allow-Headers') || '', /\bX-RailRadar-Key\b/);

  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  globalThis.caches = { default: createMemoryCache() };

  try {
    const authSeen = [];
    globalThis.fetch = async (url, init) => {
      authSeen.push({ url: String(url), auth: init?.headers?.Authorization || init?.headers?.authorization });
      if (String(url).includes('/stations/')) {
        return new Response(JSON.stringify({ success: true, data: { trains: [] } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        data: { trainNumber: '12711', status: 'running', currentLocation: { stationCode: 'SKM', hasDeparted: true } },
      }), { status: 200 });
    };

    // Personal key works even with empty env, and overrides env.RAILRADAR_API_KEY
    const cResp = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live?scope=skm', {
        headers: { 'X-RailRadar-Key': 'personal-rr-key-999' },
      }),
      { RAILRADAR_API_KEY: 'server-env-key-111' }
    );
    assert.equal(cResp.status, 200);
    assert.equal(authSeen.length, 1);
    assert.ok(authSeen[0].url.includes('/stations/SKM/live'));
    assert.equal(authSeen[0].auth, 'Bearer personal-rr-key-999');

    const lResp = await handleLiveStatus(
      new Request('https://railraksha.tech/api/live-status?train=12711', {
        headers: { 'X-RailRadar-Key': 'personal-rr-key-999' },
      }),
      {}
    );
    assert.equal(lResp.status, 200);
    assert.equal(authSeen[1].auth, 'Bearer personal-rr-key-999');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});

/* ── v8.2 Dual-Provider (RailRadar + RailCore), departedAt & Interpolation ── */
import { normalizeRailCorePayload } from '../worker/handlers.js';
import { buildLiveCorridorState } from '../js/live-trains.js';

test('v8.2 RailRadar 429 automatically fails over to RailCore v1 in handleCorridorLive and handleLiveStatus', async () => {
  assert.match(CORS_HEADERS['Access-Control-Allow-Headers'], /\bX-RailCore-Key\b/);

  const healthResp = await handleHealth(
    new Request('https://railraksha.tech/api/health'),
    { RAILRADAR_API_KEY: 'rr-key', RAILCORE_API_KEY: 'rc-key' }
  );
  const health = await healthResp.json();
  assert.equal(health.services.liveTrains.provider, 'railradar+railcore');
  assert.equal(health.services.liveTrains.railcoreConfigured, true);

  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  globalThis.caches = { default: createMemoryCache() };

  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, headers: init?.headers || {} });
      if (u.startsWith('https://api.railradar.in/')) {
        return new Response(
          JSON.stringify({ success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Monthly quota exceeded' } }),
          { status: 429 }
        );
      }
      if (u.includes('ir.railcore.tech/v1/stations/OGL/live')) {
        return new Response(JSON.stringify({
          success: true,
          meta: { timestamp: '2026-11-26T04:00:00+05:30' },
          data: {
            station_code: 'OGL',
            trains: [
              {
                train_number: '12760',
                train_name: 'Charminar SF Express',
                source_station_code: 'HYB',
                destination_station_code: 'TBM',
                train_type: 'SUPERFAST',
                estimated_departure: '2026-11-26T03:50:00+05:30',
                actual_departure: '2026-11-26T03:52:00+05:30',
                departure_delay_minutes: 31,
                timing_basis: 'live',
                status: 'DEPARTED',
              },
              {
                train_number: '99999',
                train_name: 'Cancelled Special',
                source_station_code: 'BZA',
                destination_station_code: 'GDR',
                status: 'CANCELLED',
              },
            ],
          },
        }), { status: 200 });
      }
      if (u.includes('ir.railcore.tech/v1/stations/NLR/live')) {
        return new Response(JSON.stringify({
          success: true,
          meta: { timestamp: '2026-11-26T04:00:00+05:30' },
          data: {
            station_code: 'NLR',
            trains: [{
              train_number: '12760',
              train_name: 'Charminar SF Express',
              source_station_code: 'HYB',
              destination_station_code: 'TBM',
              estimated_arrival: '2026-11-26T05:10:00+05:30',
              arrival_delay_minutes: 31,
              timing_basis: 'live',
              status: 'RUNNING',
            }],
          },
        }), { status: 200 });
      }
      if (u.includes('ir.railcore.tech/v1/trains/12760/live')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            train_number: '12760',
            train_name: 'Charminar SF Express',
            status: 'RUNNING',
            delay_minutes: 31,
            current_station_code: 'SKM',
            stations: [
              { station_code: 'OGL', status: 'departed', actual_departure: '2026-11-26T03:52:00+05:30' },
              { station_code: 'SKM', status: 'at-station', delay_arrival_minutes: 31 },
              { station_code: 'NLR', status: 'upcoming', eta: '2026-11-26T05:10:00+05:30' },
            ],
          },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const corrRes = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live'),
      { RAILRADAR_API_KEY: 'rr-exhausted', RAILCORE_API_KEY: 'rc-valid' }
    );
    assert.equal(corrRes.status, 200);
    assert.match(corrRes.headers.get('Cache-Control') || '', /no-cache.*s-maxage=300/);
    const corrBody = await corrRes.json();
    assert.equal(corrBody.ok, true);
    assert.equal(corrBody.source, 'railcore-v1');
    assert.equal(corrBody.trains.length, 1, 'Cancelled trains must be filtered out');
    assert.equal(corrBody.trains[0].no, '12760');
    assert.equal(corrBody.trains[0].dir, 'DN');
    assert.equal(corrBody.trains[0].delayMin, 31);
    assert.equal(corrBody.trains[0].boards.OGL.departedAt, '2026-11-26T03:52:00+05:30');
    assert.ok(calls.some(c => c.url.includes('ir.railcore.tech/v1/stations/OGL/live?window_hours=6') && c.headers['X-RailCore-Key'] === 'rc-valid'));

    const liveRes = await handleLiveStatus(
      new Request('https://railraksha.tech/api/live-status?train=12760', {
        headers: { 'X-RailCore-Key': 'rc-personal' },
      }),
      { RAILRADAR_API_KEY: 'rr-exhausted' }
    );
    assert.equal(liveRes.status, 200);
    const liveBody = await liveRes.json();
    assert.equal(liveBody.provider, 'railcore-v1');
    assert.equal(liveBody.dir, 'DN');
    assert.equal(liveBody.delay_min, 31);
    assert.equal(liveBody.last_station_code, 'SKM');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});

test('v8.2 buildLiveCorridorState: uses departedAt + 2-station linear bracketing and filters object hubs cleanly', () => {
  const norm = normalizeRailCorePayload({
    data: {
      train_number: '13352',
      train_name: 'Dhanbad Express',
      status: 'RUNNING',
      delay_minutes: 102,
      current_station_code: 'SKM',
      stations: [
        { station_code: 'NLR', status: 'departed' },
        { station_code: 'SKM', status: 'departed', actual_departure: '2026-11-26T03:42:00+05:30' },
        { station_code: 'OGL', status: 'upcoming', eta: '2026-11-26T04:14:00+05:30' },
      ],
    },
  });
  assert.equal(norm.dir, 'UP');
  assert.equal(norm.delay_min, 102);

  // Midpoint between SKM departedAt (03:42, km 293) and OGL expectedArrival (04:14, km 321) at 03:58 = km 307
  const refNowMs = Date.parse('2026-11-26T03:58:00+05:30');
  const st = buildLiveCorridorState({
    no: '13352',
    name: 'Dhanbad Express',
    dir: 'UP',
    isLive: true,
    delayMin: 102,
    boards: {
      SKM: {
        type: 'departed',
        departedAt: '2026-11-26T03:42:00+05:30',
        expectedDeparture: '2026-11-26T03:31:00+05:30',
        delayMinutes: 102,
      },
      OGL: {
        type: 'upcoming',
        expectedArrival: '2026-11-26T04:14:00+05:30',
        delayMinutes: 102,
      },
    },
    detail: null,
  }, refNowMs);

  assert.ok(st, 'Expected live state');
  assert.ok(Math.abs(st.kmNominal - 307) < 0.2, `Expected ~307 km midpoint between SKM(293) and OGL(321), got ${st.kmNominal}`);
  assert.equal(st.delayMin, 102);
  assert.equal(st.confirmed, true);
});

/* ── v8.3 irctc.dev, Receding Filter, Defect Classifier, Telugu Diary & LWR ── */
import { normalizeIrctcDevPayload, normalizeBoardItem, resolveAIChain } from '../worker/handlers.js';
import { ALL_OFFLINE_DEFECT_PRESETS, classifyOfflineDefect, buildDefectsCsv } from '../js/defect-report.js';
import { analyzeRisks } from '../js/weather-alert.js';
import { searchManualRules, matchLocalRule } from '../js/pw-manual.js';

test('v8.3 irctc.dev station/train normalization, KV cache, quota_saver & failover', async () => {
  assert.match(CORS_HEADERS['Access-Control-Allow-Headers'], /\bX-IRCTC-Key\b/);

  const normTrain = normalizeIrctcDevPayload({
    success: true,
    queryTime: '2026-11-28T10:15:00+05:30',
    data: {
      trainNumber: '20678',
      trainName: 'Vande Bharat Express',
      trainType: 'VANDE BHARAT',
      locationStatus: 'Departed Singarayakonda',
      currentLocation: 'Singarayakonda',
      currentDelayMin: 6,
      speedKmh: 128,
      updatedAt: '2026-11-28T10:15:00+05:30',
      stops: [
        { stationName: 'Nellore', stationCode: 'NLR', status: 'passed', departs: '09:12', delayMin: 4 },
        { stationName: 'Singarayakonda', stationCode: 'SKM', status: 'current', departs: '10:08', delayMin: 6 },
        { stationName: 'Ongole', stationCode: 'OGL', status: 'upcoming', arrives: '10:28', delayMin: 6 },
      ],
    },
  });
  assert.ok(normTrain);
  assert.equal(normTrain.train_no, '20678');
  assert.equal(normTrain.dir, 'UP');
  assert.equal(normTrain.last_station_code, 'SKM');
  assert.equal(normTrain.next_halt_code, 'OGL');
  assert.equal(normTrain.event, 'DEPARTED');
  assert.equal(normTrain.delay_min, 6);
  assert.equal(normTrain.speed_kmh, 128);
  assert.equal(normTrain.is_live, true);
  assert.equal(normTrain.corridor_stops.length, 3);
  assert.match(normTrain.actual_departure, /2026-11-28T10:08:00\+05:30/);

  assert.equal(normalizeIrctcDevPayload({ success: true, data: { trainNumber: '12711', isCancelled: true } }), null);

  const refNow = Date.parse('2026-11-28T10:15:00+05:30');
  const boardItem = normalizeBoardItem('irctcdev', {
    trainNo: '12711',
    trainName: 'Pinakini SF Express',
    route: 'BZA - MAS',
    status: 'DEPARTED',
    platform: { number: 2 },
    arrival: { actualOrEstimated: '10:03', delayMinutes: 8, status: 'Arrived' },
    departure: { actualOrEstimated: '10:05', delayMinutes: 8, status: 'Departed' },
  }, refNow);
  assert.ok(boardItem);
  assert.equal(boardItem.no, '12711');
  assert.equal(boardItem.source, 'BZA');
  assert.equal(boardItem.destination, 'MAS');
  assert.equal(boardItem.liveType, 'departed');
  assert.equal(boardItem.board.platform, 2);
  assert.match(boardItem.board.departedAt, /2026-11-28T10:05:00\+05:30/);
  assert.equal(normalizeBoardItem('irctcdev', { trainNo: '12711', isCancelled: true }, refNow), null);

  const hResp = await handleHealth(
    new Request('https://railraksha.tech/api/health'),
    { IRCTC_DEV_API_KEY: 'ir-k', RAILCORE_API_KEY: 'rc-k', RAILRADAR_API_KEY: 'rr-k', GEMINI_API_KEY: 'g-k' }
  );
  const hBody = await hResp.json();
  assert.equal(hBody.version, '8.3');
  assert.equal(hBody.services.liveTrains.irctcDevConfigured, true);
  assert.equal(hBody.services.liveTrains.railcoreConfigured, true);
  assert.equal(hBody.services.liveTrains.railradarConfigured, true);
  assert.equal(hBody.services.liveTrains.provider, 'irctc.dev+railcore+railradar');

  // Verify AI provider failover order & multimodal vision filtering
  const aiChain = resolveAIChain({ GEMINI_API_KEY: 'gk', GROQ_API_KEY: 'grk', OPENROUTER_API_KEY: 'ork' });
  assert.deepEqual(aiChain.map(p => p.name), ['gemini', 'groq', 'openrouter']);
  assert.equal(aiChain[1].visionModels.includes('llama-3.3-70b-versatile'), false);

  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  globalThis.caches = { default: createMemoryCache() };
  const kvStore = new Map();
  const mockKV = {
    async get(k) { return kvStore.get(k) || null; },
    async put(k, v) { kvStore.set(k, v); },
  };

  try {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, headers: init?.headers || {} });
      if (u.startsWith('https://api.irctc.dev/api/v1/live/station/')) {
        return new Response(JSON.stringify({ success: false, code: 'RATE_LIMIT', error: 'Quota exhausted' }), { status: 429 });
      }
      if (u.startsWith('https://ir.railcore.tech/v1/stations/OGL/live')) {
        return new Response(JSON.stringify({
          success: true,
          meta: { timestamp: '2026-11-28T10:15:00+05:30' },
          data: {
            trains: [{
              train_number: '20678',
              train_name: 'Vande Bharat Express',
              source_station_code: 'BZA',
              destination_station_code: 'MAS',
              estimated_arrival: '2026-11-28T10:25:00+05:30',
              arrival_delay_minutes: 0,
              timing_basis: 'live',
              status: 'RUNNING',
            }],
          },
        }), { status: 200 });
      }
      if (u.startsWith('https://api.irctc.dev/api/v1/live/20678')) {
        return new Response(JSON.stringify({
          success: true,
          queryTime: '2026-11-28T10:15:00+05:30',
          data: {
            trainNumber: '20678',
            trainName: 'Vande Bharat Express',
            currentStationCode: 'OGL',
            locationStatus: 'Departed Ongole',
            currentDelayMin: 2,
            speedKmh: 130,
            stops: [
              { stationCode: 'OGL', status: 'passed', departs: '10:10' },
              { stationCode: 'SKM', status: 'upcoming', arrives: '10:24' },
            ],
          },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    // irctc.dev 429 fails over cleanly to RailCore, quota_saver=1 hits 1 anchor (OGL), caches in KV
    const corrRes = await handleCorridorLive(
      new Request('https://railraksha.tech/api/corridor-live?quota_saver=1'),
      { IRCTC_DEV_API_KEY: 'ir-exhausted', RAILCORE_API_KEY: 'rc-active', CORRIDOR_KV: mockKV }
    );
    assert.equal(corrRes.status, 200);
    assert.match(corrRes.headers.get('Cache-Control') || '', /s-maxage=600/);
    const corrBody = await corrRes.json();
    assert.equal(corrBody.ok, true);
    assert.equal(corrBody.source, 'railcore-v1');
    assert.equal(corrBody.trains.length, 1);
    assert.equal(corrBody.trains[0].no, '20678');
    assert.ok(calls.some(c => c.url.includes('api.irctc.dev/api/v1/live/station/OGL?hours=8') && c.headers['x-api-key'] === 'ir-exhausted'));
    assert.ok(!calls.some(c => c.url.includes('/stations/NLR/')), 'quota_saver=1 must query only 1 anchor');
    assert.ok(kvStore.size >= 1, 'Expected shared CORRIDOR_KV cache population');

    // Personal X-IRCTC-Key works on /api/live-status even without server IRCTC_DEV_API_KEY
    const liveRes = await handleLiveStatus(
      new Request('https://railraksha.tech/api/live-status?train=20678', {
        headers: { 'X-IRCTC-Key': 'personal-irctc-key' },
      }),
      { RAILCORE_API_KEY: 'rc-env' }
    );
    assert.equal(liveRes.status, 200);
    const liveBody = await liveRes.json();
    assert.equal(liveBody.provider, 'irctcdev-v1');
    assert.equal(liveBody.dir, 'DN');
    assert.equal(liveBody.speed_kmh, 130);
    assert.ok(calls.some(c => c.url.includes('api.irctc.dev/api/v1/live/20678') && c.headers['x-api-key'] === 'personal-irctc-key'));
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});

test('v8.3 130 km/h 3-tier alerts + directional receding-train vector zero-false-alarm guarantee', () => {
  const worker = { km: 293.0, sigmaM: 10 };
  const mkTrain = (kmNom, confirmed = true) => ({
    key: 'VB-20678',
    no: '20678',
    dir: 'UP',
    line: 'UP',
    confirmed,
    kmNominal: kmNom,
    kmLead: kmNom + 0.25,
    kmLag: kmNom - 0.30,
    vmaxKmh: 130,
    speedKmh: 130,
    lengthKm: 0.45,
  });

  // 3-tier escalating envelope for 130 km/h express train
  const prep = evaluateTrain(worker, mkTrain(278.5)); // dLead = 14.25 km, etaLower = 394.6s -> PREPARE
  assert.equal(prep.level, LEVEL.PREPARE);
  assert.equal(prep.vector, 'APPROACHING');

  const warn = evaluateTrain(worker, mkTrain(283.5)); // dLead = 9.25 km, etaLower = 256s <= 300s -> WARN
  assert.equal(warn.level, LEVEL.WARN);

  const crit = evaluateTrain(worker, mkTrain(287.8)); // dLead = 4.95 km, etaLower = 137s <= 180s -> CRITICAL
  assert.equal(crit.level, LEVEL.CRITICAL);

  const atSite = evaluateTrain(worker, mkTrain(293.0));
  assert.equal(atSite.level, LEVEL.CRITICAL);
  assert.equal(atSite.atSite, true);
  assert.equal(atSite.vector, 'AT_SITE');

  // Receding train vector: once past (dLag < -(0.45 + 0.2)), CLEARED and zero false alarms
  const receded = evaluateTrain(worker, mkTrain(294.2));
  assert.equal(receded.level, LEVEL.CLEARED);
  assert.equal(receded.passed, true);
  assert.equal(receded.receding, true);
  assert.equal(receded.atSite, false);
  assert.equal(receded.vector, 'RECEDING');

  // ThreatEngine under heavy GPS noise spike after CLEARED must NEVER re-alarm on receding train
  const eng = new ThreatEngine();
  assert.equal(eng.update(worker, [mkTrain(288.0)], 0).primary.level, LEVEL.CRITICAL);
  const clrRes = eng.update(worker, [mkTrain(294.2)], 10000);
  assert.equal(clrRes.primary, null);
  assert.equal(clrRes.events[0]?.type, 'CLEARED');

  // Sudden GPS noise spike (sigmaM jumps 10 m -> 350 m, worker km jitters +60 m) while train is receding
  const noisyWorker = { km: 293.06, sigmaM: 350 };
  const noisyAfterPass = eng.update(noisyWorker, [mkTrain(294.0)], 11000);
  assert.equal(noisyAfterPass.primary, null, 'Receding train must NOT re-trigger CRITICAL/WARN under GPS noise');
  assert.equal(noisyAfterPass.threats.length, 0);
  assert.equal(noisyAfterPass.events.length, 0);

  // Overdue unconfirmed schedule ghost must NOT claim atSite=true or beat real approaching train
  const ghost = { key: 'GHOST', no: '17644', dir: 'UP', line: 'UP', confirmed: false, kmNominal: 315, kmLead: 320, kmLag: 150, vmaxKmh: 80, speedKmh: 50, lengthKm: 0.55 };
  const realApproaching = { key: 'REAL', no: '12711', dir: 'UP', line: 'UP', confirmed: false, kmNominal: 270, kmLead: 272, kmLag: 240, vmaxKmh: 110, speedKmh: 85, lengthKm: 0.55 };
  const ghostEval = evaluateTrain(worker, ghost);
  assert.equal(ghostEval.atSite, false);
  assert.equal(ghostEval.vector, 'OVERDUE');
  const ordered = eng.update(worker, [ghost, realApproaching], 20000);
  assert.equal(ordered.ambient[0].key, 'REAL', 'Approaching train must outrank overdue schedule ghost');

  // GpsTracker tolerates stale legacy manual codes without crashing
  const memStorage = {
    getItem: () => JSON.stringify({ code: 'CLX', km: 356 }),
    setItem() {},
    removeItem() {},
  };
  const g = new GpsTracker({ storage: memStorage, geolocation: null, now: () => 1e12 });
  assert.equal(g.manual, null);
});

test('v8.3 IRPWM offline defect classifier, CSV export, Telugu Gang Diary & LWR/Manual offline checks', () => {
  assert.ok(ALL_OFFLINE_DEFECT_PRESETS.length >= 10);
  const corr = classifyOfflineDefect('rail-corrosion', 'Heavy salt pitting on rail foot at km 293/6', true);
  assert.equal(corr.severity, 'HIGH');
  assert.equal(corr.irpwmCode, 'RC-07');
  assert.match(corr.irpwmReference, /IRPWM Para 2\.7/);
  assert.match(corr.description, /km 293\/6/);

  const noteClassified = classifyOfflineDefect('unknown-id', '2 missing pandrol clips near curve');
  assert.equal(noteClassified.irpwmCode, 'FN-03');
  assert.match(noteClassified.defectType, /Pandrol/i);

  const csv = buildDefectsCsv([
    {
      date: '2026-11-28',
      timestamp: '2026-11-28T09:30:00Z',
      status: 'REPORTED',
      severity: 'HIGH',
      defectType: 'AT Weld Fracture, LH Rail',
      irpwmCode: 'WC-02',
      speedRestriction: '30 km/h Caution Order',
      gps: 'km 293.4 · SKM↔TGU',
      description: 'Hairline "weld" crack noticed',
      immediateAction: 'Clamp with joggle fishplates',
      irpwmReference: 'IRPWM Para 2.6.1',
      mode: 'Offline IRPWM',
    },
  ]);
  assert.match(csv, /^Date,Timestamp,Status,Severity,Defect Type,IRPWM Code,Speed Restriction,Location,Description,Immediate Action,IRPWM Reference,Mode\r\n/);
  assert.match(csv, /"AT Weld Fracture, LH Rail"/);
  assert.match(csv, /"Hairline ""weld"" crack noticed"/);

  // Colloquial Telugu Unicode + Tenglish Gang Diary parsing
  const teEntry = buildOfflineDiaryEntry(
    'కి.మీ 293/4 అప్ లైన్ లో 40 స్లీపర్లు ప్యాకింగ్ చేసాము, 6 పాండ్రోల్ క్లిప్పులు బిగించాము, వెల్డ్ దగ్గర పగులు కనిపించింది, ఎర్ర జెండాతో లుక్ అవుట్ పెట్టాము',
    { date: '2026-11-28', dateStr: '28 November 2026', present: 24, total: 25, section: 'SKM–UPD, Vijayawada Div.' }
  );
  assert.equal(teEntry.date, '2026-11-28');
  assert.equal(teEntry.section, 'SKM–UPD, Vijayawada Div.');
  assert.match(teEntry.workDone, /PSC sleepers/i);
  assert.match(teEntry.workDone, /km 293\/4/);
  assert.match(teEntry.workDone, /\[Field note\] కి\.మీ 293\/4/);
  assert.equal(/\[Field note\] కి\n/.test(teEntry.workDone), false);
  assert.match(teEntry.materialsUsed, /ERC clips/i);
  assert.match(teEntry.materialsUsed, /PSC sleepers/i);
  assert.match(teEntry.defectsNoted, /weld crack/i);
  assert.equal(teEntry.defectsNoted, teEntry.defectsObserved);
  assert.equal(teEntry.safetyVerified, true);
  assert.match(teEntry.safetyMeasures, /Lookout man/i);

  const tenglishEntry = buildOfflineDiaryEntry(
    '30 sleepers packing chesamu, 4 ERC clips tight chesamu, lookout red flag pettamu',
    { date: '2026-11-28', present: 25, total: 25, section: 'SKM–UPD' }
  );
  assert.equal(tenglishEntry.safetyVerified, true);
  assert.equal(tenglishEntry.defectsNoted, 'Nil reported during shift');
  assert.match(tenglishEntry.materialsUsed, /ERC clips/i);

  // LWR Thermal risk & offline IRPWM manual keyword search
  const hotRisks = analyzeRisks({ temp: 43, railTemp: 66, humidity: 40, rainfall: 0, windSpeed: 14, windGusts: 18, upcomingRainMm: 0, upcomingRainHrs: null });
  assert.ok(hotRisks.some(r => r.level === 'high' && /2\.9/.test(r.irpwm)));
  assert.ok(searchManualRules('pandrol').some(r => r.id === 'erc-fastenings'));
  assert.ok(searchManualRules('వేడి').some(r => r.id === 'hot-weather'));
  assert.equal(matchLocalRule('GR 3.62')?.id, 'obstruction-protection');
});
