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
    ├── binaries/         # Sidecar binary output
    ├── capabilities/     # Tauri permissions
    ├── icons/            # App icons
    └── src/
        ├── lib.rs        # Tauri plugin setup
        └── main.rs       # App entry point
```
