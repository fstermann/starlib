#!/usr/bin/env bash
# Creates a lightweight dev-only sidecar stub that starts the Python backend via uv.
# In production this file is replaced by the PyInstaller binary built by CI.
#
# Usage: bash scripts/setup-dev-sidecar.sh
#        Or automatically via: npm run desktop:dev
set -e

ARCH=$(rustc -vV | grep 'host:' | awk '{print $2}')
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARIES_DIR="${SCRIPT_DIR}/../src-tauri/binaries"
OUT="${BINARIES_DIR}/sct-backend-${ARCH}"

mkdir -p "$BINARIES_DIR"

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
