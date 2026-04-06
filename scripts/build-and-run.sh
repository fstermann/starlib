#!/usr/bin/env bash
# Build the full desktop app (sidecar + frontend + Tauri) and launch it.
# Equivalent to what CI produces; use this to test release builds locally.
#
# Usage: bash scripts/build-and-run.sh
set -euo pipefail

REPO_ROOT="$(pwd)"
echo $REPO_ROOT
ARCH=$(rustc -vV | grep 'host:' | awk '{print $2}')

echo "==> Building backend sidecar (PyInstaller)..."
cd "$REPO_ROOT"
uv run --group desktop pyinstaller desktop/sidecar.spec \
    --distpath desktop/src-tauri/binaries \
    --noconfirm
mv desktop/src-tauri/binaries/starlib-backend \
   "desktop/src-tauri/binaries/starlib-backend-${ARCH}"

echo "==> Building frontend (Next.js static export)..."
cd "$REPO_ROOT/frontend"
npm install --silent
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build

echo "==> Building Tauri app..."
cd "$REPO_ROOT/desktop"
npm install --silent
npx @tauri-apps/cli build

APP_PATH="$REPO_ROOT/desktop/src-tauri/target/release/bundle/macos/Starlib.app"
echo "==> Launching $APP_PATH"
open "$APP_PATH"
