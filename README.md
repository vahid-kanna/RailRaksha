# RailRaksha (రైల్ రక్ష) — Offline-First Railway Track Safety & Field PWA

[![Live on Cloudflare](https://img.shields.io/badge/Live-railraksha.tech-F59E0B?style=flat-square&logo=cloudflare&logoColor=white)](https://railraksha.tech)
[![Architecture](https://img.shields.io/badge/Stack-Vanilla%20ES%20Modules%20%2B%20IndexedDB-131822?style=flat-square)](#architecture)
[![PWA](https://img.shields.io/badge/PWA-Offline--First%20Service%20Worker-22C55E?style=flat-square)](#offline-first-guarantees)
[![Bilingual](https://img.shields.io/badge/UI-English%20%7C%20Telugu-0284C7?style=flat-square)](#core-modules)

**Live App:** [https://railraksha.tech](https://railraksha.tech)

Offline-first field safety and documentation Progressive Web App built for Indian Railways Gang Mates and Track Maintainers on the **Vijayawada (BZA) ↔ Gudur (GDR)** corridor (**Singarayakonda–Ulavapadu / SKM–UPD** section, South Central Railway).

> **Safety Boundary Notice:** RailRaksha is an independent personal software prototype inspired by real field maintenance work. It is **not** an Indian Railways certified or officially deployed safety instrument. Consumer GPS drift, parallel-track ambiguity, and unscheduled goods/freight trains mean software can never substitute for visual lookout, dedicated flagmen, or official IRPWM / General Rules protection procedures.

---

## Core Modules

1. **Corridor Radar & Train Alert Engine (`Alerts`)**
   - Direction-aware track filtering (`UP · BZA`, `DOWN · GDR`, `BOTH`) with adjacent-line safety cues.
   - 2-state Along-Track Kalman Filter (`js/gps-tracker.js`) projecting GPS fixes onto continuous corridor chainage, with 14-station manual beat fallback and `±0.5 km` fine nudge.
   - Delay-corrected position envelope (`kmLead` / `kmNominal` / `kmLag`) across 53 corridor train entries (47 passenger + 6 typical freight paths) (`js/timetable-data.js`) and live RailRadar v1 overlay via Cloudflare Worker (`/api/live-status`).
   - Built-in **Safety Drill Simulator** (explicitly badged `SIMULATION DRILL — NOT LIVE TRAFFIC`) for crew training and demonstrations.
   - Persistent IndexedDB **Shift Alert Audit Log** and 1-tap **SOS Line Protection Sheet** (Broad Gauge 600 m / 1200 m detonator diagram, emergency coordinates SMS copy, and quick-dial helplines).

2. **Track Defect Reporter (`Defect`)**
   - Camera capture & upload with client-side JPEG compression (`<= 1280px`).
   - Multimodal AI Vision classification via Cloudflare Worker (`/api/chat`) mapped to IRPWM codes and speed restrictions.
   - **100% Offline IRPWM Quick Classifier** with 8 standard railway defect presets so track defects can always be logged, GPS-tagged, filtered, exported, and shared in dead zones.

3. **Bilingual Voice & Text Gang Diary (`Diary`)**
   - Telugu (`te-IN`) & English (`en-IN`) speech recognition with non-duplicating result accumulation, always-editable field notes, and 1-tap railway phrase chips.
   - Attendance stepper synced to configured gang strength and IST (`Asia/Kolkata`) date stamps.
   - Cloud AI diary formatting with **deterministic Offline Structured Formatter fallback**, persistent IndexedDB log, and `.txt` shift export.

4. **Weather & LWR Rail Thermal Stress (`Weather`)**
   - Free, keyless live telemetry via Open-Meteo (with optional OpenWeatherMap override and IndexedDB offline cache).
   - Estimates steel **Long Welded Rail (LWR) temperature** against the **IRPWM Para 2.9 65°C (`Td+20°C`) Hot Weather Patrolling** limit, plus monsoon scour and coastal cyclone wind checks.

5. **IRPWM & GR Field Manual (`Manual`)**
   - **14 built-in offline IRPWM / General Rules** cards with category filtering (`Emergency`, `Gauge`, `Track`, `Weather`, `Protection`), instant live search, voice lookup, and online AI fallback for custom queries.

6. **Outdoor Daylight High-Contrast Mode**
   - 1-tap toggle between **Industrial Field Dark** and **Outdoor Daylight High-Contrast** designed for harsh midday sunlight on open track.

---

## Architecture

- **Frontend:** Zero-framework Vanilla ES Modules (`index.html`, `css/style.css`, `js/*.js`) — fast cold boots on budget Android phones, zero npm runtime dependencies.
- **Offline Layer:** Service Worker (`sw.js` v7.0, query-resilient Stale-While-Revalidate + `/api/*` network pass-through) + IndexedDB (`js/db.js`).
- **Edge Hosting & APIs:** Hosted 100% on **Cloudflare Workers with Static Assets** (`wrangler.jsonc`, `worker/index.js`, `worker/handlers.js`, `_headers`, `.assetsignore`).
  - `GET /api/health` — Edge health & configured service diagnostics
  - `POST /api/chat` — Server-side OpenAI-compatible AI proxy (`AI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, or `BYNARA_API_KEY`)
  - `GET /api/live-status?train=<no>&date=<YYYY-MM-DD>` — RailRadar v1 proxy (`RAILRADAR_API_KEY`) with 20 s edge cache

---

## Local Development & Testing

```bash
# 1. Run unit & handler tests (Node 20+)
node --test tests/engine.test.mjs

# 2. Serve locally
python3 -m http.server 8080
# Open http://localhost:8080
```

## Cloudflare Deployment

Push to `main` on GitHub (`vahid-kanna/RailRaksha`) to trigger automatic Cloudflare Workers deployment (`npx wrangler deploy` via `wrangler.jsonc`).

Configure optional server-side secrets in **Cloudflare Dashboard → Workers & Pages → `railraksha` → Settings → Variables and Secrets**:
- `GEMINI_API_KEY` (or `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `BYNARA_API_KEY` / `AI_API_KEY`) — enables Cloud AI vision & diary formatting
- `RAILRADAR_API_KEY` — enables live NTES/RailRadar v1 train status overlay (schedule mode works automatically without it)

---

**Author:** Shaik Vahid Basha · IIT Madras  
**License:** See `LICENSE`
