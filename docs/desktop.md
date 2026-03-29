# Desktop

The desktop app uses **Tauri v2** to package Starlib as a native macOS application.

## Architecture

```
Tauri shell  (Rust / native webview)
  │
  ├─ webview  →  frontend/out/  (Next.js static export)
  │
  └─ sidecar  →  desktop/binaries/starlib-backend  (PyInstaller-frozen FastAPI)
```

The backend sidecar starts automatically when the app opens and is killed when it closes. It binds to `127.0.0.1:8000` (localhost only).

## Prerequisites

| Tool | Install |
|------|---------|
| Rust stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js ≥ 22 | `brew install node` |
| Python 3.13+ | `brew install python@3.13` |
| uv | `pip install uv` |
| PyInstaller | `pip install pyinstaller` |
| ImageMagick (icon gen) | `brew install imagemagick` |

## Build steps

### 1. Build the backend sidecar

```bash
# From repo root
uv pip install -e "."
pyinstaller desktop/sidecar.spec --distpath desktop/src-tauri/binaries --noconfirm

# Rename with target triple for Tauri
mv desktop/src-tauri/binaries/starlib-backend \
   desktop/src-tauri/binaries/starlib-backend-$(rustc -vV | grep host | cut -d' ' -f2)
```

### 2. Build the frontend

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build
# Produces: frontend/out/
```

### 3. Generate app icons

Place a 512×512 `icon.png` in `desktop/src-tauri/icons/`, then:

```bash
cd desktop
npm install
npx @tauri-apps/cli icon src-tauri/icons/icon.png
```

### 4. Development mode

Use the dev setup script for a faster iteration loop:

```bash
cd desktop
./scripts/setup-dev-sidecar.sh
```

## Project structure

```
desktop/
├── package.json         # Node deps (@tauri-apps/cli)
├── sidecar_entry.py     # PyInstaller entry point
├── sidecar.spec          # PyInstaller spec
├── scripts/
│   └── setup-dev-sidecar.sh
└── src-tauri/
    ├── Cargo.toml        # Rust dependencies
    ├── tauri.conf.json   # Tauri configuration
    ├── Entitlements.plist # macOS entitlements for ad-hoc signing
    ├── binaries/         # Sidecar binary output
    ├── capabilities/     # Tauri permissions
    ├── icons/            # App icons
    └── src/
        ├── lib.rs        # Tauri plugin setup
        └── main.rs       # App entry point
```

## Debugging the release build

### Running a release build locally

```bash
# 1. Build sidecar
pyinstaller desktop/sidecar.spec --distpath desktop/src-tauri/binaries --noconfirm
mv desktop/src-tauri/binaries/starlib-backend \
   desktop/src-tauri/binaries/starlib-backend-$(rustc -vV | grep host | cut -d' ' -f2)

# 2. Build frontend
cd frontend && npm ci && NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build && cd ..

# 3. Build Tauri app
cd desktop && npm install
npx @tauri-apps/cli build --target aarch64-apple-darwin --config src-tauri/tauri.conf.json
```

The built app is at `target/aarch64-apple-darwin/release/bundle/macos/Starlib.app`.

### Testing the sidecar binary in isolation

```bash
# Run the sidecar directly to check for import errors
/path/to/Starlib.app/Contents/MacOS/starlib-backend

# If port 8000 is in use (e.g. dev server running), use a different port
BACKEND_PORT=8001 /path/to/Starlib.app/Contents/MacOS/starlib-backend
```

### Checking macOS system logs

```bash
# Show all Starlib-related logs from the last 5 minutes
log show --predicate 'processImagePath CONTAINS "Starlib" OR processImagePath CONTAINS "starlib"' --last 5m --style compact

# Filter for errors only
log show --predicate 'processImagePath CONTAINS "Starlib" OR processImagePath CONTAINS "starlib"' --last 5m --style compact 2>&1 | grep -i "error\|fail\|denied\|sandbox"
```

### Verifying code signing and entitlements

```bash
# Check signing identity and flags
codesign -dvvv /path/to/Starlib.app

# Check embedded entitlements
codesign -d --entitlements - /path/to/Starlib.app
```

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Starlib.app is damaged" | macOS quarantine on unsigned app | `xattr -cr /Applications/Starlib.app` |
| "Load failed" in webview | Missing entitlements / no code signing | Ensure `signingIdentity: "-"` and `Entitlements.plist` in `tauri.conf.json` |
| Sidecar `ModuleNotFoundError` | Python module not bundled by PyInstaller | Add to `hiddenimports` in `desktop/sidecar.spec` |
| Health check passes but app broken | Another process on port 8000 (e.g. dev server) | Stop the dev server before testing release build |
