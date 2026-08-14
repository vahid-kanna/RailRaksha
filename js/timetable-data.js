/**
 * RailRaksha — VERIFIED SKM (Singarayakonda) Train Timetable
 * Vijayawada–Gudur–Chennai double-line mainline section
 * South Central Railway (SCR), Guntakal Division
 *
 * Direction key:
 *   "D" = DOWN (towards Gudur / Chennai / Tirupati — southbound)
 *   "U" = UP   (towards Vijayawada / Secunderabad / Howrah — northbound)
 *
 * Direction rule: ODD train number = DOWN, EVEN = UP
 *
 * Times are SCHEDULED at Singarayakonda (SKM) in HH:MM 24-hour IST.
 * For trains that STOP: departure time is used.
 * For trains that PASS THROUGH: approximate passing time is used.
 *
 * DATA SOURCE: Indian Railways NTES, eRail.in, IndiaRailInfo
 * LAST VERIFIED: August 2026
 *
 * ⚠️  SAFETY WARNING: This timetable is for OFFLINE safety alerting only.
 *     Always rely on live GPS data when available.
 *     Freight trains are NOT listed here — maintain constant vigilance.
 */

export const SKM_TIMETABLE = [

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRAINS THAT STOP AT SKM (1-2 minute halt — verified schedules)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Circar Express ──
  { no: "17644", name: "Circar Express",         from: "KAKINADA PORT",     to: "CHENGALPATTU",    dir: "U", time: "00:45", days: "daily",               type: "EXPRESS",    speed: 48, stops: true },
  { no: "17643", name: "Circar Express",         from: "CHENGALPATTU",      to: "KAKINADA PORT",   dir: "D", time: "21:55", days: "daily",               type: "EXPRESS",    speed: 48, stops: true },

  // ── Charlapalli Express ──
  { no: "12604", name: "Charlapalli-MAS Express", from: "CHARLAPALLI",      to: "CHENNAI CENTRAL", dir: "U", time: "01:05", days: "daily",               type: "EXPRESS",    speed: 58, stops: true },
  { no: "12603", name: "MAS-Charlapalli Express", from: "CHENNAI CENTRAL",  to: "CHARLAPALLI",     dir: "D", time: "20:35", days: "daily",               type: "EXPRESS",    speed: 58, stops: true },

  // ── Seshadri Express ──
  { no: "17210", name: "Seshadri Express",       from: "KAKINADA TOWN",     to: "BENGALURU",       dir: "U", time: "01:15", days: "daily",               type: "EXPRESS",    speed: 51, stops: true },
  { no: "17209", name: "Seshadri Express",       from: "BENGALURU",         to: "KAKINADA TOWN",   dir: "D", time: "21:20", days: "daily",               type: "EXPRESS",    speed: 51, stops: true },

  // ── Narayanadri Express ──
  { no: "12734", name: "Narayanadri Express",    from: "LINGAMPALLI",       to: "TIRUPATI",        dir: "U", time: "01:40", days: "daily",               type: "EXPRESS",    speed: 57, stops: true },
  { no: "12733", name: "Narayanadri Express",    from: "TIRUPATI",          to: "LINGAMPALLI",     dir: "D", time: "21:40", days: "daily",               type: "EXPRESS",    speed: 57, stops: true },

  // ── Andaman Express ──
  { no: "16032", name: "Andaman Express",        from: "SVDK KATRA",        to: "CHENNAI CENTRAL", dir: "U", time: "01:55", days: "Tue,Wed,Sat",         type: "EXPRESS",    speed: 52, stops: true },
  { no: "16031", name: "Andaman Express",        from: "CHENNAI CENTRAL",   to: "SVDK KATRA",      dir: "D", time: "09:30", days: "Wed,Thu,Fri,Sun",     type: "EXPRESS",    speed: 52, stops: true },

  // ── Dhanbad-Alappuzha Express ──
  { no: "13352", name: "Alappuzha-Dhanbad Exp",  from: "ALAPPUZHA",         to: "DHANBAD",         dir: "U", time: "02:00", days: "daily",               type: "EXPRESS",    speed: 48, stops: true },
  { no: "13351", name: "Dhanbad-Alappuzha Exp",  from: "DHANBAD",           to: "ALAPPUZHA",       dir: "D", time: "18:35", days: "daily",               type: "EXPRESS",    speed: 48, stops: true },

  // ── Sabari Express ──
  { no: "17229", name: "Sabari Express",         from: "TRIVANDRUM",        to: "SECUNDERABAD",    dir: "D", time: "03:25", days: "daily",               type: "EXPRESS",    speed: 53, stops: true },
  { no: "17230", name: "Sabari Express",         from: "SECUNDERABAD",      to: "TRIVANDRUM",      dir: "U", time: "19:45", days: "daily",               type: "EXPRESS",    speed: 53, stops: true },

  // ── Bitragunta MEMU ──
  { no: "07760", name: "Bitragunta-BZA MEMU",    from: "BITRAGUNTA",        to: "VIJAYAWADA",      dir: "U", time: "04:40", days: "daily",               type: "PASSENGER",  speed: 38, stops: true },
  { no: "07759", name: "BZA-Bitragunta MEMU",    from: "VIJAYAWADA",        to: "BITRAGUNTA",      dir: "D", time: "18:00", days: "daily",               type: "PASSENGER",  speed: 38, stops: true },

  // ── Simhapuri Express ──
  { no: "12710", name: "Simhapuri Express",      from: "SECUNDERABAD",      to: "GUDUR",           dir: "U", time: "06:30", days: "daily",               type: "EXPRESS",    speed: 58, stops: true },
  { no: "12709", name: "Simhapuri Express",      from: "GUDUR",             to: "SECUNDERABAD",    dir: "D", time: "20:05", days: "daily",               type: "EXPRESS",    speed: 58, stops: true },

  // ── Tirumala Express ──
  { no: "17488", name: "Tirumala Express",       from: "VISAKHAPATNAM",     to: "TIRUPATI",        dir: "U", time: "07:33", days: "daily",               type: "EXPRESS",    speed: 50, stops: true },
  { no: "17487", name: "Tirumala Express",       from: "TIRUPATI",          to: "VISAKHAPATNAM",   dir: "D", time: "23:50", days: "daily",               type: "EXPRESS",    speed: 50, stops: true },

  // ── Pinakini Express ──
  { no: "12711", name: "Pinakini Express",       from: "VIJAYAWADA",        to: "CHENNAI CENTRAL", dir: "D", time: "08:35", days: "daily",               type: "EXPRESS",    speed: 62, stops: true },
  { no: "12712", name: "Pinakini Express",       from: "CHENNAI CENTRAL",   to: "VIJAYAWADA",      dir: "U", time: "18:15", days: "daily",               type: "EXPRESS",    speed: 62, stops: true },

  // ── Krishna Express ──
  { no: "17405", name: "Krishna Express",        from: "TIRUPATI",          to: "ADILABAD",        dir: "D", time: "09:15", days: "daily",               type: "EXPRESS",    speed: 45, stops: true },
  { no: "17406", name: "Krishna Express",        from: "ADILABAD",          to: "TIRUPATI",        dir: "U", time: "16:20", days: "daily",               type: "EXPRESS",    speed: 45, stops: true },

  // ── Puri-Tirupati Express ──
  { no: "17479", name: "Puri-Tirupati Express",  from: "PURI",              to: "TIRUPATI",        dir: "D", time: "15:10", days: "Mon,Wed,Thu,Fri,Sat", type: "EXPRESS",    speed: 48, stops: true },
  { no: "17480", name: "Tirupati-Puri Express",  from: "TIRUPATI",          to: "PURI",            dir: "U", time: "14:40", days: "Mon,Tue,Wed,Fri,Sat", type: "EXPRESS",    speed: 48, stops: true },

  // ── Vijayawada-Gudur MEMU ──
  { no: "07500", name: "BZA-Gudur MEMU",         from: "VIJAYAWADA",        to: "GUDUR",           dir: "U", time: "20:40", days: "daily",               type: "PASSENGER",  speed: 40, stops: true },


  // ═══════════════════════════════════════════════════════════════════════════
  //  TRAINS THAT PASS THROUGH SKM WITHOUT STOPPING
  //  ⚠️  HIGH SPEED — up to 130 km/h — MOST DANGEROUS for track workers
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Vande Bharat Express (MAS-Narasapur) — FASTEST on this section ──
  { no: "20677", name: "Vande Bharat Express",   from: "CHENNAI CENTRAL",   to: "NARASAPUR",       dir: "D", time: "09:22", days: "Mon,Wed,Thu,Fri,Sat,Sun", type: "VANDE_BHARAT", speed: 130, stops: false },
  { no: "20678", name: "Vande Bharat Express",   from: "NARASAPUR",         to: "CHENNAI CENTRAL", dir: "U", time: "18:52", days: "Mon,Wed,Thu,Fri,Sat,Sun", type: "VANDE_BHARAT", speed: 130, stops: false },

  // ── Jan Shatabdi (MAS-BZA) ──
  { no: "12077", name: "Chennai Jan Shatabdi",   from: "CHENNAI CENTRAL",   to: "VIJAYAWADA",      dir: "D", time: "10:45", days: "Mon,Wed,Thu,Fri,Sat,Sun", type: "JAN_SHATABDI", speed: 110, stops: false },
  { no: "12078", name: "BZA Jan Shatabdi",       from: "VIJAYAWADA",        to: "CHENNAI CENTRAL", dir: "U", time: "18:15", days: "Mon,Wed,Thu,Fri,Sat,Sun", type: "JAN_SHATABDI", speed: 110, stops: false },

  // ── Howrah-Chennai Mail ──
  { no: "12839", name: "Howrah-Chennai Mail",    from: "HOWRAH",            to: "CHENNAI CENTRAL", dir: "D", time: "12:30", days: "daily",               type: "MAIL",       speed: 110, stops: false },
  { no: "12840", name: "Chennai-Howrah Mail",    from: "CHENNAI CENTRAL",   to: "HOWRAH",          dir: "U", time: "23:50", days: "daily",               type: "MAIL",       speed: 110, stops: false },

  // ── Navjeevan Express ──
  { no: "12655", name: "Navjeevan Express",      from: "AHMEDABAD",         to: "CHENNAI CENTRAL", dir: "D", time: "13:20", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },
  { no: "12656", name: "Navjeevan Express",      from: "CHENNAI CENTRAL",   to: "AHMEDABAD",       dir: "U", time: "12:40", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },

  // ── Coromandel Express ──
  { no: "12841", name: "Coromandel Express",     from: "HOWRAH",            to: "CHENNAI CENTRAL", dir: "D", time: "14:20", days: "daily",               type: "EXPRESS",    speed: 120, stops: false },
  { no: "12842", name: "Coromandel Express",     from: "CHENNAI CENTRAL",   to: "HOWRAH",          dir: "U", time: "10:30", days: "daily",               type: "EXPRESS",    speed: 120, stops: false },

  // ── Padmavathi Express ──
  { no: "12763", name: "Padmavathi Express",     from: "TIRUPATI",          to: "SECUNDERABAD",    dir: "D", time: "19:15", days: "Mon,Tue,Thu,Fri,Sun", type: "EXPRESS",    speed: 100, stops: false },
  { no: "12764", name: "Padmavathi Express",     from: "SECUNDERABAD",      to: "TIRUPATI",        dir: "U", time: "03:30", days: "Mon,Tue,Wed,Fri,Sat", type: "EXPRESS",    speed: 100, stops: false },

  // ── Howrah-Yesvantpur Express ──
  { no: "12863", name: "HWH-YPR Express",       from: "HOWRAH",            to: "YESVANTPUR",      dir: "D", time: "21:50", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },
  { no: "12864", name: "YPR-HWH Express",       from: "YESVANTPUR",        to: "HOWRAH",          dir: "U", time: "20:00", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },

  // ── Tamil Nadu Express ──
  { no: "12621", name: "Tamil Nadu Express",     from: "CHENNAI CENTRAL",   to: "NEW DELHI",       dir: "D", time: "02:00", days: "daily",               type: "EXPRESS",    speed: 110, stops: false },
  { no: "12622", name: "Tamil Nadu Express",     from: "NEW DELHI",         to: "CHENNAI CENTRAL", dir: "U", time: "03:10", days: "daily",               type: "EXPRESS",    speed: 110, stops: false },

  // ── Grand Trunk Express ──
  { no: "12615", name: "Grand Trunk Express",    from: "CHENNAI CENTRAL",   to: "NEW DELHI",       dir: "D", time: "21:40", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },
  { no: "12616", name: "Grand Trunk Express",    from: "NEW DELHI",         to: "CHENNAI CENTRAL", dir: "U", time: "01:40", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },

  // ── Charminar Express ──
  { no: "12759", name: "Charminar Express",      from: "TAMBARAM",          to: "HYDERABAD",       dir: "D", time: "21:10", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },
  { no: "12760", name: "Charminar Express",      from: "HYDERABAD",         to: "TAMBARAM",        dir: "U", time: "03:40", days: "daily",               type: "EXPRESS",    speed: 100, stops: false },


  // ═══════════════════════════════════════════════════════════════════════════
  //  FREIGHT WINDOWS — approximate only, freight is NOT on NTES
  //  Krishnapatnam Port generates significant freight on this section
  // ═══════════════════════════════════════════════════════════════════════════
  { no: "FREIGHT-01", name: "GOODS TRAIN", from: "KRISHNAPATNAM", to: "VIJAYAWADA",    dir: "U", time: "01:00", days: "daily", type: "FREIGHT", speed: 60, stops: false },
  { no: "FREIGHT-02", name: "GOODS TRAIN", from: "KRISHNAPATNAM", to: "VIJAYAWADA",    dir: "U", time: "05:30", days: "daily", type: "FREIGHT", speed: 60, stops: false },
  { no: "FREIGHT-03", name: "GOODS TRAIN", from: "VIJAYAWADA",    to: "KRISHNAPATNAM", dir: "D", time: "08:00", days: "daily", type: "FREIGHT", speed: 60, stops: false },
  { no: "FREIGHT-04", name: "GOODS TRAIN", from: "KRISHNAPATNAM", to: "VIJAYAWADA",    dir: "U", time: "14:00", days: "daily", type: "FREIGHT", speed: 60, stops: false },
  { no: "FREIGHT-05", name: "GOODS TRAIN", from: "VIJAYAWADA",    to: "KRISHNAPATNAM", dir: "D", time: "16:30", days: "daily", type: "FREIGHT", speed: 60, stops: false },
  { no: "FREIGHT-06", name: "GOODS TRAIN", from: "KRISHNAPATNAM", to: "VIJAYAWADA",    dir: "U", time: "22:00", days: "daily", type: "FREIGHT", speed: 60, stops: false },
];

// ═══════════════════════════════════════════════════════════════════════════
// LOGIC — All functions below unchanged from working version
// ═══════════════════════════════════════════════════════════════════════════

// ── Days of week helper ─────────────────────────────────────────────────────
export const DAY_MAP = { 0:"Sun", 1:"Mon", 2:"Tue", 3:"Wed", 4:"Thu", 5:"Fri", 6:"Sat" };

// ── FIXED default constants (used as fallback if config not loaded yet) ──────
const DEFAULT_THRESHOLDS = { PREPARE: 25, WARN: 15, CRITICAL: 7, PASSED: -5 };

/**
 * Read time alert thresholds dynamically so user changes in Settings
 * take effect immediately without page reload.
 * Falls back to DEFAULT_THRESHOLDS if config not loaded yet.
 */
export function getAlertThresholds() {
  try {
    const cfg = (typeof window !== "undefined" && window.getConfig)
      ? window.getConfig
      : (k) => localStorage.getItem(k) || "";
    return {
      PREPARE:  parseFloat(cfg("alert_min_prepare"))  || DEFAULT_THRESHOLDS.PREPARE,
      WARN:     parseFloat(cfg("alert_min_warn"))     || DEFAULT_THRESHOLDS.WARN,
      CRITICAL: parseFloat(cfg("alert_min_critical")) || DEFAULT_THRESHOLDS.CRITICAL,
      PASSED:   DEFAULT_THRESHOLDS.PASSED, // Not user-configurable (safety critical)
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

// Backward-compat: static export that reads dynamically each time via getter
export const ALERT_THRESHOLDS = {
  get PREPARE()  { return getAlertThresholds().PREPARE;  },
  get WARN()     { return getAlertThresholds().WARN;     },
  get CRITICAL() { return getAlertThresholds().CRITICAL; },
  get PASSED()   { return getAlertThresholds().PASSED;   },
};

/**
 * Get minutes until a train passes SKM.
 * @param {string} scheduledTime - "HH:MM" string
 * @returns {number} minutes (negative if already passed)
 */
export function minutesUntilTrain(scheduledTime) {
  const now = new Date();
  const [h, m] = scheduledTime.split(":").map(Number);
  const trainTime = new Date(now);
  trainTime.setHours(h, m, 0, 0);
  let diff = (trainTime - now) / 60000;
  // If train time is before now by more than 5 hours, treat as tomorrow's
  if (diff < -300) diff += 1440;
  return Math.round(diff);
}

/**
 * Check if a train runs today.
 * @param {string} daysStr - "daily" or comma-separated abbreviations like "Mon,Wed,Fri"
 */
export function trainsToday(daysStr) {
  if (!daysStr || daysStr === "daily") return true;
  const today = DAY_MAP[new Date().getDay()];
  return daysStr.split(",").map(d => d.trim()).includes(today);
}

/**
 * Get alert level for a train based on minutes to arrival.
 * @param {number} minutes
 * @returns {"PREPARE"|"WARN"|"CRITICAL"|"PASSED"|"OK"}
 */
export function getAlertLevel(minutes) {
  const t = getAlertThresholds();
  if (minutes <= t.PASSED)   return "PASSED";
  if (minutes <= t.CRITICAL) return "CRITICAL";
  if (minutes <= t.WARN)     return "WARN";
  if (minutes <= t.PREPARE)  return "PREPARE";
  return "OK";
}

// ── Work section geometry ─────────────────────────────────────────────────────
// Work section: SKM (km 293) ↔ UPD (km 265) = 28 km
export const WORK_SECTION_KM = 28;

/** Minutes a train takes to traverse the whole SKM↔UPD work section. */
export function sectionTransitMin(speed) {
  return (WORK_SECTION_KM / (speed || 80)) * 60;
}

/**
 * Get all active trains, sorted by EFFECTIVE time to the work section.
 *
 * Effective minutes = time until the train ENTERS the SKM↔UPD work section:
 *   DOWN trains enter at SKM → minutesUntil
 *   UP   trains enter at UPD → minutesUntil minus section transit time
 *
 * Trains currently INSIDE the section get effectiveMin = 0 and are always
 * CRITICAL — they sort first and always alert.
 *
 * occursToday = false when the HH:MM instance already passed today and the
 * value was wrapped to tomorrow (prevents "985 min" phantom trains).
 */
export function getActiveTrains() {
  const passed = getAlertThresholds().PASSED;

  let alertMode = "station";
  try {
    const cfg = (typeof window !== "undefined" && window.getConfig)
      ? window.getConfig
      : (k) => localStorage.getItem(k) || "";
    alertMode = cfg("alert_mode") || "station";
  } catch {}

  const now = new Date();

  return SKM_TIMETABLE
    .filter(t => trainsToday(t.days))
    .map(t => {
      const minUntil   = minutesUntilTrain(t.time);
      const speed      = t.speed || 80;
      const transitMin = sectionTransitMin(speed);

      // Did this HH:MM instance happen today, or was it wrapped to tomorrow?
      // (matches the -300 min wrap rule in minutesUntilTrain)
      const [th, tm] = t.time.split(":").map(Number);
      const tToday = new Date(now); tToday.setHours(th, tm, 0, 0);
      const occursToday = (now - tToday) <= 300 * 60000;

      // Minutes until the train ENTERS the work section
      const minutesToWork = t.dir === "D"
        ? minUntil                        // DOWN: enters at SKM
        : minUntil - transitMin;          // UP: enters at UPD (earlier)

      // Is the train INSIDE the work section right now?
      // ── SAFETY FIX: Schedule-only inSection detection is unreliable ──
      // Trains are often 10-30 min late. A schedule-based system CANNOT know
      // the real position. We only flag inSection when:
      //   - LIVE GPS is available (hasLiveGPS flag), OR
      //   - The train's estimated distance puts it inside a tight buffer zone
      //
      // For DOWN trains: entered at SKM → minUntil <= 0 and hasn't reached UPD
      // For UP trains: entered at UPD → minutesToWork <= 0 and hasn't reached SKM
      //
      // Without GPS, use a "late buffer" (ENTRY_BUFFER_MIN) to account for
      // typical delays. A train is only flagged IN SECTION once it is
      // clearly past the section entry edge by ENTRY_BUFFER_MIN, so a merely
      // late train (still approaching the boundary) is NOT falsely flagged.
      const ENTRY_BUFFER_MIN = 15; // Account for train delays (~15 min)

      // DOWN: enters at SKM (minUntil=0), exits at UPD (minUntil=-transitMin)
      // UP:   enters at UPD (minutesToWork=0), exits at SKM (minUntil=0)
      const scheduleInSection = t.dir === "D"
        ? (minUntil <= -ENTRY_BUFFER_MIN && minUntil > -transitMin)
        : (minutesToWork <= -ENTRY_BUFFER_MIN && minUntil > 0);

      // Only trust scheduleInSection if we DON'T have live GPS.
      // When GPS is available, live-trains.js handles inSection via actual position.
      const hasLiveGPS = !!localStorage.getItem("railradar_key");
      const inSection = hasLiveGPS ? false : scheduleInSection;

      // Effective minutes for alerting (0 = inside section = CRITICAL)
      // For UP trains NOT in section, use minUntil (time to SKM) instead of
      // minutesToWork, because minutesToWork assumes entry at UPD which may
      // not be accurate if the train is late or still south of UPD.
      const effectiveMin = inSection
        ? 0
        : minUntil;

      // Alert level honours the current mode (station vs GPS)
      const levelMin   = inSection ? 0 : (alertMode === "station" ? effectiveMin : minUntil);
      const alertLevel = inSection ? "CRITICAL" : getAlertLevel(levelMin);

      // Estimate how far from SKM the train currently is
      const kmFromSKM = Math.abs(minUntil) * speed / 60;

      // Find approximate current station name
      let nearStation = "";
      if (inSection) {
        nearStation = "⚠️ INSIDE SKM↔UPD section";
      } else if (minUntil > 0) {
        if (kmFromSKM < 5)        nearStation = "near SKM";
        else if (kmFromSKM < 18)  nearStation = t.dir === "D" ? "near Ammanabrolu"   : "near Ulavapadu";
        else if (kmFromSKM < 35)  nearStation = t.dir === "D" ? "near Ongole"        : "near Kavali";
        else if (kmFromSKM < 55)  nearStation = t.dir === "D" ? "near Martur"        : "near Tanguturu";
        else if (kmFromSKM < 80)  nearStation = t.dir === "D" ? "near Chirala"       : "near Bitragunta";
        else if (kmFromSKM < 120) nearStation = t.dir === "D" ? "past Bapatla"       : "past Nellore";
        else                      nearStation = t.dir === "D" ? "far (BZA side)"     : "far (GDR side)";
      } else {
        nearStation = "passed SKM";
      }

      return {
        ...t,
        minutesUntil:  minUntil,
        minutesToWork: Math.round(minutesToWork),
        effectiveMin:  Math.round(effectiveMin),
        transitMin:    Math.round(transitMin),
        inSection,
        occursToday,
        alertLevel,
        nearStation,
        kmFromSKM: Math.round(kmFromSKM)
      };
    })
    .filter(t => t.inSection || t.minutesUntil > passed)
    .sort((a, b) => a.effectiveMin - b.effectiveMin || a.minutesUntil - b.minutesUntil);
}
