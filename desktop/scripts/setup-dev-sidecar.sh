#!/usr/bin/env bash
# Creates a lightweight dev-only sidecar stub that starts the Python backend via uv.
# In production this file is replaced by the PyInstaller binary built by CI.
#
# Usage: bash scripts/setup-dev-sidecar.sh
#        Or automatically via: npm run desktop:dev
set -e

ARCH=$(rustc -vV | grep 'host:' | awk '{print $2}')
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${SCRIPT_DIR}/.."
BINARIES_DIR="${DESKTOP_DIR}/src-tauri/binaries"
BIN_DIR="${DESKTOP_DIR}/bin"
OUT="${BINARIES_DIR}/starlib-backend-${ARCH}"

mkdir -p "$BINARIES_DIR" "$BIN_DIR"

# ── Download bundled ffmpeg if not already present ────────────────────────
FFMPEG_BIN="${BIN_DIR}/ffmpeg"
if [[ ! -f "$FFMPEG_BIN" ]]; then
  echo "Downloading static ffmpeg for ${ARCH}..."
  case "$ARCH" in
    aarch64-apple-darwin)
      FFMPEG_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64"
      ;;
    x86_64-apple-darwin)
      FFMPEG_URL="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-x64"
      ;;
    *)
      echo "Warning: no prebuilt ffmpeg for arch ${ARCH}, skipping download"
      FFMPEG_URL=""
      ;;
  esac
  if [[ -n "$FFMPEG_URL" ]]; then
    curl -L -o "$FFMPEG_BIN" "$FFMPEG_URL"
    chmod +x "$FFMPEG_BIN"
    echo "ffmpeg downloaded: $FFMPEG_BIN"
  fi
fi

cat > "$OUT" << 'STUB'
#!/usr/bin/env bash
# Dev sidecar stub — replaced by the PyInstaller binary in production builds.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"
export PYTHONPATH="${REPO_ROOT}:${PYTHONPATH:-}"
exec uv run python -m backend.main "$@"
STUB

chmod +x "$OUT"
echo "Dev sidecar created: $OUT"
