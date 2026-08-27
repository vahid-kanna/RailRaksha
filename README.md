# RailRaksha — Railway Track Safety & Field Documentation PWA

<div align="center">

[![Status](https://img.shields.io/badge/Status-Live%20on%20Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://railraksha.vercel.app)
[![PWA](https://img.shields.io/badge/PWA-100%25%20Offline--First-FF6F00?style=for-the-badge&logo=pwa&logoColor=white)](https://railraksha.vercel.app)
[![Vision AI](https://img.shields.io/badge/AI%20Engine-Bynara%20Vision-8A2BE2?style=for-the-badge&logo=openai&logoColor=white)](https://railraksha.vercel.app)
[![Domain](https://img.shields.io/badge/Domain-Indian%20Railways%20Safety-138808?style=for-the-badge&logo=train&logoColor=white)](https://railraksha.vercel.app)
[![Language](https://img.shields.io/badge/Multilingual-Telugu%20%7C%20English-blue?style=for-the-badge)](https://railraksha.vercel.app)

**AI-Powered Safety, Train Proximity Alerts & Field Documentation Platform for Indian Railways Track Workers.**

[🚀 Open Live App (`railraksha.vercel.app`)](https://railraksha.vercel.app) • [📱 Installable PWA](https://railraksha.vercel.app) • [📖 Documentation](#-core-modules--features)

</div>

---

## 🚂 Origin & Real-World Motivation

Indian Railways operates one of the largest rail networks in the world, maintained around the clock by track maintainers (Gang Mates and Keymen) working under extreme environmental and safety conditions. Field teams often work in remote block sections with intermittent cellular connectivity, manual paperwork, and high collision risk during active maintenance.

**RailRaksha** was conceptualized and developed from first-hand observations of field operations on the **Singarayakonda–Ulavapadu (SKM–UPD)** section of South Central Railway (SCR), where the creator's father serves as a Gang Mate. It provides track maintainers with a resilient, offline-first digital assistant to protect lives, automate manual logs, and detect track defects using AI.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            RAILRAKSHA ECOSYSTEM                             │
├──────────────────────┬──────────────────────┬───────────────────────────────┤
│    RADAR HUD &       │   AI VISION DEFECT   │    MULTILINGUAL GANG DIARY    │
│  PROXIMITY ALERTS    │      CLASSIFIER      │       (VOICE IN TELUGU)       │
│  Live Train Alerts   │  IRPWM Code & Action │ Attendance, Materials & Tasks │
├──────────────────────┴──────────────────────┴───────────────────────────────┤
│                     100% OFFLINE-FIRST SERVICE WORKER                       │
│             IndexedDB Storage • Local Timetables • Zero Bloat               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Core Modules & Features

### 1. 🚨 Track Radar HUD & Train Proximity Alert
- **Dual Monitoring Modes:**
  - **📡 Station Block Mode:** Tracks train passage across neighboring stations (e.g., SKM ↔ UPD section) for guaranteed alerts even in cellular dead zones.
  - **📍 GPS Distance Mode:** Real-time distance calculation to oncoming trains with dynamic speed/time estimation.
- **Visual & Audio Siren Alarms:** Unambiguous full-screen warning banners and acoustic alerts instructing gang crews to clear the track immediately.
- **Schedule Fallback & Freight Caution:** Blends live NTES/RailRadar feeds with cached offline timetables and explicit visual cautions for unscheduled freight traffic.

### 2. 🔍 AI Vision Track Defect Classifier
- **On-Device & Cloud Triage:** Photograph or upload track defects (rail fractures, weld cracks, missing ERC clips, ballast voids, sunken joints).
- **IRPWM Mapping:** Automatically matches visual damage to Indian Railways Permanent Way Manual (**IRPWM**) standard maintenance codes.
- **Speed Restrictions & Action Plans:** Recommends mandatory speed limits (e.g., Stop Dead, 20 km/h, 30 km/h caution) and instant one-click report sharing with the Section PWI / SSE via WhatsApp.

### 3. 🎙️ Voice-Powered Gang Diary (Telugu & English)
- **Field Speech Recognition:** Speak daily accomplishments, track kilometers inspected, materials used, and safety precautions in native **Telugu (తెలుగు)** or English.
- **Automatic Diary Structuring:** Transforms spoken field logs into a standardized, official Indian Railways Gang Diary with automatic attendance calculations.
- **Offline Journaling:** Saves entries locally with instant export and PWI dispatch upon reconnecting to the network.

### 4. 🌦️ Track Vulnerability & Weather Stress Monitor
- **Live Thermal & Weather Telemetry:** Live temperature, wind velocity, and precipitation monitoring via OpenWeatherMap.
- **Rail Buckling Hazard Prediction:** Real-time track stress estimation for high-temperature rail expansion and extreme monsoon washaway vulnerability.

### 5. 📖 PW Manual AI Assistant & Emergency Directory
- **Interactive Rulebook:** Natural language search for track safety codes, maintenance tolerances, and gauge criteria in Telugu or English.
- **One-Tap Emergency Contacts:** Direct dialers for Station Master (SKM), Section PWI/SSE, Railway Emergency Helpline (139), and Railway Protection Force (1800-111-322).

---

## 🏗️ Technical Architecture & Design Principles

```
                  ┌─────────────────────────────────────┐
                  │       PWA Browser Environment       │
                  │   (Low-end Android Field Devices)   │
                  └──────────────────┬──────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│   SERVICE WORKER   │    │    INDEXEDDB &     │    │  AUDIO / SPEECH    │
│  Offline Asset &   │    │   LOCAL STORAGE    │    │ Web Speech API &   │
│ Timetable Caching  │    │  Field Logs Cache  │    │ Multi-Tone Siren   │
└────────────────────┘    └────────────────────┘    └────────────────────┘
                                     │
                                     ▼ (When Online)
                          ┌────────────────────┐
                          │  VERCEL SERVERLESS │
                          │     /api/chat      │
                          └──────────┬─────────┘
                                     ▼
                          ┌────────────────────┐
                          │  BYNARA ROUTER AI  │
                          │ Agnes Vision/LLM   │
                          └────────────────────┘
```

- **Offline-First PWA:** Built with high-efficiency Service Workers, precaching all core scripts, styles, SVGs, and timetable databases for 100% functionality without internet access.
- **Zero Framework Runtime Overhead:** Engineered with lightweight modern vanilla JavaScript (ES modules) and native CSS custom properties. Sub-50ms execution speed on budget Android smartphones used in the field.
- **Secure Serverless Proxy:** Edge API routes (`/api/chat`) keep upstream AI provider keys protected on the server without client-side exposure.

---

## 📂 Repository Structure

```bash
RailRaksha/
├── index.html              # App shell, SVG sprite system & 5 core screens
├── manifest.json           # PWA progressive web app manifest
├── sw.js                   # Offline caching Service Worker
├── vercel.json             # Vercel deployment routing & header rules
├── netlify.toml            # Netlify deployment fallback configuration
├── build-keys.sh           # Deploy-time environment variable injector
├── api/
│   └── chat.js             # Vercel serverless proxy for Bynara Vision AI
├── css/
│   └── style.css           # High-contrast, dark-mode railway design system
├── js/
│   ├── app.js              # State manager & screen router
│   ├── config.js           # Central configuration & local overrides
│   ├── train-alert.js      # Train proximity calculation & audio siren
│   ├── defect-report.js    # AI camera capture & IRPWM defect classifier
│   ├── gang-diary.js       # Voice-to-text recording & diary generator
│   ├── weather-alert.js    # Rail thermal stress & weather monitoring
│   ├── pw-manual.js        # Rulebook query engine & emergency hotline
│   ├── live-trains.js      # NTES/RailRadar live feed parser
│   ├── timetable-data.js   # Offline station timetable database (SKM/UPD)
│   └── db.js               # Offline storage manager
└── icons/                  # High-DPI maskable PWA icons & branding
```

---

## 🚀 Local Setup & Development

### 1. Clone the Repository
```bash
git clone https://github.com/vahid-kanna/RailRaksha.git
cd RailRaksha
```

### 2. Configure Environment Keys (Optional for local testing)
Copy or generate `js/config-keys.js` with your API keys:
```javascript
export const API_KEYS = {
  bynara:    "YOUR_BYNARA_API_KEY",
  groq:      "YOUR_GROQ_API_KEY",
  railradar: "YOUR_RAILRADAR_KEY",
  owm:       "YOUR_OPENWEATHERMAP_KEY",
};
```
*(Note: Users can also enter their own keys directly within the app's in-browser **⚙️ Settings** modal).*

### 3. Run Locally
Serve the directory with any static file server:
```bash
# Using Python
python -m http.server 8080

# Using Node / npx
npx serve .
```
Open `http://localhost:8080` in your browser.

---

## 🌐 Production Deployment

RailRaksha is configured for **Vercel** and **Netlify** with automatic build-time key injection:

1. In your Vercel/Netlify dashboard, define the following Environment Variables:
   - `BYNARA_API_KEY`
   - `GROQ_API_KEY`
   - `RAILRADAR_KEY`
   - `OWM_API_KEY`
2. The `build-keys.sh` script generates `js/config-keys.js` dynamically during build time.
3. Deployed live with zero downtime at **[railraksha.vercel.app](https://railraksha.vercel.app)**.

---

## 👨‍💻 Creator & Attribution

- **Developer:** [Shaik Vahid Basha](https://github.com/vahid-kanna) (B.Tech Civil Engineering, IIT Madras)
- **Field Inspiration:** Dedicated to Indian Railways Gang Mates and Track Maintainers on the SKM–UPD Section.

---

## 📄 License

MIT License — free for non-commercial and safety-enhancement use across Indian Railways.
