# Desktop app

This directory contains the **Tauri v2** shell that packages Starlib as a native macOS (and optionally Windows) desktop application.

## Architecture

```
Tauri shell  (Rust / native webview)
  │
  ├─ webview  →  frontend/out/  (Next.js static export)
  │
  └─ sidecar  →  desktop/binaries/starlib-backend  (PyInstaller-frozen FastAPI backend)
```

The backend sidecar is started automatically when the app opens and killed when it closes. It binds to `127.0.0.1:8000` (localhost only). The Tauri webview loads the static frontend which talks to the sidecar over HTTP.

## Prerequisites

| Tool | Install |
|------|---------|
| Rust stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Node.js ≥ 22 | `brew install node` |
| Python 3.13+ | `brew install python@3.13` |
| uv | `pip install uv` |
| PyInstaller | `pip install pyinstaller` |
| ImageMagick (icon gen) | `brew install imagemagick` |

## 1. Build the backend sidecar

```bash
# From repo root:
uv pip install -e "."
pyinstaller desktop/sidecar.spec --distpath desktop/src-tauri/binaries --noconfirm

# Tauri needs the binary named with the target triple:
mv desktop/src-tauri/binaries/starlib-backend \
   desktop/src-tauri/binaries/starlib-backend-$(rustc -vV | grep host | cut -d' ' -f2)
```

## 2. Build the frontend

```bash
cd frontend
npm install
NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build
# Produces: frontend/out/
```

## 3. Generate app icons

Place a 512×512 `icon.png` in `desktop/src-tauri/icons/`, then:

```bash
cd desktop
npm install            # installs @tauri-apps/cli
npx @tauri-apps/cli icon src-tauri/icons/icon.png
```

## 4. Development mode

```bash
cd desktop
npm install
npm run desktop:dev
# Generates a dev sidecar stub, then opens a native window loading http://localhost:3000
# (Next.js dev server must also be running: cd frontend && npm run dev)
```

The `desktop:dev` command automatically creates a lightweight shell-script stub at
`desktop/binaries/starlib-backend-<arch>` that starts the Python backend via `uv`.
No PyInstaller build is required for local development.

## 5. Production build (local)

```bash
cd desktop
npx @tauri-apps/cli build
# Output: desktop/src-tauri/target/release/bundle/
```

## 6. Set up the updater signing key

Tauri's updater requires a signing key pair. Generate one and add the private key to your GitHub repo secrets:

```bash
cd desktop && npx @tauri-apps/cli signer generate -w ~/.tauri/starlib.key
# → prints public key  —  paste into tauri.conf.json "plugins.updater.pubkey"
# → private key file   —  add as TAURI_SIGNING_PRIVATE_KEY secret (base64-encode first)
```

## CI releases

Push a version tag to trigger the release workflow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow:
1. Builds the PyInstaller sidecar for macOS arm64 + x86_64
2. Builds the Next.js static frontend
3. Builds Tauri `.dmg` bundles for both architectures
4. Creates a GitHub Release with all artifacts

See [`.github/workflows/release.yml`](../.github/workflows/release.yml) for details.
