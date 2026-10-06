#!/bin/zsh
# Double-click to start the BMD Emulator. Close this window to stop it.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "The emulator needs Node.js 18 or newer: https://nodejs.org"
  read -k1 "?Press any key to close."
  exit 1
fi
node emulator.mjs
