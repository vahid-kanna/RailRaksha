#!/bin/bash
# RailRaksha — deploy-time key injection
# Runs on Vercel/Netlify during build. Generates js/config-keys.js from
# environment variables so real API keys never live in the git repo.
#
# Required env vars (set in hosting dashboard, not here):
#   GROQ_API_KEY, RAILRADAR_KEY, OWM_API_KEY

set -e

cat > js/config-keys.js <<EOF
export const API_KEYS = {
  groq:      "${GROQ_API_KEY}",
  railradar: "${RAILRADAR_KEY}",
  owm:       "${OWM_API_KEY}",
};
EOF

echo "[build-keys] js/config-keys.js generated from env vars"
