#!/usr/bin/env bash
# Builds the standalone Python backend (stox_bridge.py + stoxlib) with
# PyInstaller and drops it where macapp/package.json's electron-builder
# config expects it (extraResources "from": "backend/stox-backend"), so
# `npm run package:mac` can bundle it into the .app without a system
# Python or this repo's .venv on the machine that runs the packaged app.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

if [ ! -x .venv/bin/pyinstaller ]; then
  echo "error: .venv/bin/pyinstaller not found -- run:" >&2
  echo "  .venv/bin/pip install pyinstaller==6.22.3" >&2
  exit 1
fi

rm -rf build dist macapp/backend
.venv/bin/pyinstaller --noconfirm packaging/stox-backend.spec
mkdir -p macapp/backend
mv dist/stox-backend macapp/backend/stox-backend
rm -rf build dist

echo "backend bundled at macapp/backend/stox-backend ($(du -sh macapp/backend/stox-backend | cut -f1))"
