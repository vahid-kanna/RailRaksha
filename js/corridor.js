/**
 * corridor.js — Vijayawada (BZA) ↔ Gudur (GDR) mainline geometry + chainage.
 *
 * CONVENTION
 *   km  = chainage measured from Chennai Central (MAS). Increases northwards.
 *   UP  trains (towards BZA) move with ds/dt > 0   → dir = +1
 *   DN  trains (towards GDR) move with ds/dt < 0   → dir = -1
 *
 * ⚠️  DATA CALIBRATION REQUIRED BEFORE FIELD USE
 *   The km values below are anchored to the SKM=293 / UPD=265 figures used in
 *   the current codebase. Lat/lon are approximate station locations.
 *   Replace BOTH with official values from the SCR Working Time Table / LWR
 *   track diagrams, and densify TRACK_SHAPE from OSM (railway=rail) at
 *   <=200 m vertex spacing. The engine only needs chainage to be monotonic
 *   and consistent between the timetable and this file.
 */

export const STATIONS = [
  { code: 'BZA',  name: 'Vijayawada Jn',  te: 'విజయవాడ',      km: 445.0, lat: 16.5176, lon: 80.6190 },
  { code: 'TEL',  name: 'Tenali Jn',      te: 'తెనాలి',        km: 414.0, lat: 16.2395, lon: 80.6420 },
  { code: 'BPP',  name: 'Bapatla',        te: 'బాపట్ల',        km: 371.0, lat: 15.9046, lon: 80.4670 },
  { code: 'CL',   name: 'Chirala',        te: 'చీరాల',         km: 356.0, lat: 15.8237, lon: 80.3522 },
  { code: 'ANB',  name: 'Ammanabrolu',    te: 'అమ్మనబ్రోలు',    km: 338.0, lat: 15.6420, lon: 80.1560 },
  { code: 'OGL',  name: 'Ongole',         te: 'ఒంగోలు',        km: 321.0, lat: 15.5057, lon: 80.0499 },
  { code: 'TGU',  name: 'Tangutur',       te: 'టంగుటూరు',      km: 305.0, lat: 15.3406, lon: 79.9990 },
  { code: 'SKM',  name: 'Singarayakonda', te: 'సింగరాయకొండ',   km: 293.0, lat: 15.2380, lon: 80.0270 },
  { code: 'INGR', name: 'Inagallu',       te: 'ఇనగల్లు',        km: 282.0, lat: 15.1540, lon: 80.0180 },
  { code: 'UPD',  name: 'Ulavapadu',      te: 'ఉలవపాడు',       km: 265.0, lat: 15.0480, lon: 80.0090 },
  { code: 'KVZ',  name: 'Kavali',         te: 'కావలి',          km: 250.0, lat: 14.9130, lon: 79.9930 },
  { code: 'BVRT', name: 'Bitragunta',     te: 'బిట్రగుంట',      km: 232.0, lat: 14.7700, lon: 79.9800 },
  { code: 'NLR',  name: 'Nellore',        te: 'నెల్లూరు',       km: 200.0, lat: 14.4526, lon: 79.9865 },
  { code: 'GDR',  name: 'Gudur Jn',       te: 'గూడూరు',        km: 162.0, lat: 14.1467, lon: 79.8513 },
];

export const STATION_BY_CODE = Object.freeze(Object.fromEntries(STATIONS.map(s => [s.code, s])));

/** Optional intermediate shape points (no km: km is interpolated between station anchors). */
export const TRACK_SHAPE = [
  // { lat, lon }  ← paste densified OSM polyline vertices here, ordered N→S
];

const R_EARTH = 6371008.8; // m
const DEG = Math.PI / 180;

/** Local equirectangular metres between two points (accurate to <0.1% over a few km). */
export function haversineM(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * DEG, dLon = (bLon - aLon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/**
 * Build the calibrated polyline: every vertex gets a km value.
 * Between two station anchors A,B the geometric arc length is mapped linearly
 * onto [kmA, kmB], so GPS geometry errors never accumulate across stations.
 */
function buildPolyline() {
  const anchors = STATIONS.map(s => ({ lat: s.lat, lon: s.lon, km: s.km, code: s.code }));
  // merge shape points between anchors by nearest-anchor-pair ordering (N→S)
  const verts = [];
  let shapeIdx = 0;
  for (let i = 0; i < anchors.length; i++) {
    verts.push({ ...anchors[i] });
    if (i === anchors.length - 1) break;
    const a = anchors[i], b = anchors[i + 1];
    const latHi = Math.max(a.lat, b.lat), latLo = Math.min(a.lat, b.lat);
    while (shapeIdx < TRACK_SHAPE.length && TRACK_SHAPE[shapeIdx].lat <= latHi && TRACK_SHAPE[shapeIdx].lat >= latLo) {
      verts.push({ ...TRACK_SHAPE[shapeIdx++], km: null });
    }
  }
  // assign km to shape points
  let lastAnchor = 0;
  for (let i = 1; i < verts.length; i++) {
    if (verts[i].km == null) continue;
    let arc = 0; const cum = [0];
    for (let j = lastAnchor + 1; j <= i; j++) {
      arc += haversineM(verts[j - 1].lat, verts[j - 1].lon, verts[j].lat, verts[j].lon);
      cum.push(arc);
    }
    const kA = verts[lastAnchor].km, kB = verts[i].km;
    for (let j = lastAnchor + 1; j < i; j++) verts[j].km = kA + (kB - kA) * (cum[j - lastAnchor] / arc);
    lastAnchor = i;
  }
  return verts;
}

export const POLYLINE = buildPolyline();
export const CORRIDOR_KM_MIN = Math.min(...STATIONS.map(s => s.km));
export const CORRIDOR_KM_MAX = Math.max(...STATIONS.map(s => s.km));

/**
 * Project a GPS fix onto the track.
 *
 *   For segment A→B in a local tangent plane centred on the segment midpoint:
 *     x = R·Δλ·cos φ₀ ,  y = R·Δφ
 *     t  = clamp( (P−A)·(B−A) / |B−A|² , 0, 1 )
 *     Q  = A + t(B−A)                       (foot of perpendicular)
 *     d⊥ = |P − Q|                           (cross-track offset, metres)
 *     km = kmA + t·(kmB − kmA)               (calibrated chainage)
 *   Choose argmin d⊥. With a hint (previous km), any segment whose d⊥ is within
 *   HYSTERESIS_M of the best is eligible and the one closest to the hint wins,
 *   preventing chainage jumps where the line doubles back or runs parallel.
 *
 * @returns {{km:number, offsetM:number, seg:number, t:number}}
 */
export function projectToTrack(lat, lon, hintKm = null, HYSTERESIS_M = 40) {
  const cands = [];
  for (let i = 0; i < POLYLINE.length - 1; i++) {
    const A = POLYLINE[i], B = POLYLINE[i + 1];
    const phi0 = ((A.lat + B.lat) / 2) * DEG;
    const kx = R_EARTH * DEG * Math.cos(phi0), ky = R_EARTH * DEG;
    const bx = (B.lon - A.lon) * kx, by = (B.lat - A.lat) * ky;
    const px = (lon - A.lon) * kx,  py = (lat - A.lat) * ky;
    const L2 = bx * bx + by * by;
    const t = L2 > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / L2)) : 0;
    const dx = px - t * bx, dy = py - t * by;
    cands.push({ km: A.km + t * (B.km - A.km), offsetM: Math.hypot(dx, dy), seg: i, t });
  }
  cands.sort((a, b) => a.offsetM - b.offsetM);
  if (hintKm == null) return cands[0];
  const eligible = cands.filter(c => c.offsetM <= cands[0].offsetM + HYSTERESIS_M);
  eligible.sort((a, b) => Math.abs(a.km - hintKm) - Math.abs(b.km - hintKm));
  return eligible[0];
}

/** Inverse: chainage → lat/lon (for map pins, tests). */
export function kmToLatLon(km) {
  for (let i = 0; i < POLYLINE.length - 1; i++) {
    const A = POLYLINE[i], B = POLYLINE[i + 1];
    const lo = Math.min(A.km, B.km), hi = Math.max(A.km, B.km);
    if (km >= lo && km <= hi) {
      const t = (km - A.km) / (B.km - A.km || 1);
      return { lat: A.lat + t * (B.lat - A.lat), lon: A.lon + t * (B.lon - A.lon) };
    }
  }
  return null;
}

/** Stations immediately north (higher km) and south (lower km) of a chainage. */
export function bracketStations(km) {
  let north = null, south = null;
  for (const s of STATIONS) {
    if (s.km >= km && (!north || s.km < north.km)) north = s;
    if (s.km <= km && (!south || s.km > south.km)) south = s;
  }
  return { north, south };
}

export function nearestStation(km) {
  return STATIONS.reduce((best, s) => (Math.abs(s.km - km) < Math.abs(best.km - km) ? s : best));
}

/** Human label: "km 284.2 · SKM↔INGR" */
export function describeKm(km) {
  const { north, south } = bracketStations(km);
  if (north && south && north !== south) return `km ${km.toFixed(1)} · ${north.code}↔${south.code}`;
  return `km ${km.toFixed(1)} · ${(north || south).code}`;
}
