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
uv run pyinstaller desktop/sidecar.spec --distpath desktop/src-tauri/binaries --noconfirm
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

## Auto-update

### Architecture

Updates use `tauri-plugin-updater` v2. At startup the app fetches a `latest.json` manifest from the GitHub releases endpoint, compares the version, and — if a newer version is available — shows an in-app banner. The user can also trigger a manual check from **Settings → Updates**.

```
Installed app  →  GET latest.json  →  GitHub Releases
                      │
                 compare versions
                      │
              update available?
              ├─ yes → show UpdateBanner  →  "Update now"
              │                                   │
              │                          download .app.tar.gz
              │                          verify minisign signature
              │                          extract & replace bundle
              │                          relaunch app
              └─ no  → nothing / "You're on the latest version"
```

**Security:** Every update artifact is signed with a [minisign](https://jedisct1.github.io/minisign/) private key at build time (`TAURI_SIGNING_PRIVATE_KEY`). The public key is hardcoded in `tauri.conf.json`. Tauri verifies the signature before extracting — a tampered artifact or a mismatched key causes the update to be rejected.

### Release artifacts

`tauri build` produces three files per platform in `target/<triple>/release/bundle/macos/`:

| File | Purpose |
|------|---------|
| `Starlib_x.y.z_aarch64.app.tar.gz` | The bundled app, compressed |
| `Starlib_x.y.z_aarch64.app.tar.gz.sig` | minisign signature |
| _(generated by CI)_ `latest.json` | Version manifest consumed by the updater |

The CI release workflow ([.github/workflows/release.yml](../.github/workflows/release.yml)) assembles `latest.json` from the per-platform `.sig` files and uploads everything to the GitHub Release.

**`latest.json` schema:**

```json
{
  "version": "0.3.0",
  "pub_date": "2026-03-29T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/fstermann/starlib/releases/download/v0.3.0/Starlib_0.3.0_aarch64.app.tar.gz",
      "signature": "<minisign signature string>"
    },
    "darwin-x86_64": {
      "url": "https://github.com/fstermann/starlib/releases/download/v0.3.0/Starlib_0.3.0_x86_64.app.tar.gz",
      "signature": "<minisign signature string>"
    }
  }
}
```

### Generating a signing key

Run this once and store the private key as a GitHub Actions secret:

```bash
cd desktop
npx @tauri-apps/cli signer generate -w ~/.tauri/starlib.key
# prints the public key — paste it into tauri.conf.json plugins.updater.pubkey
```

GitHub secrets required:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/starlib.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password you set during generation (empty string if none) |

### User settings

The **Settings → Updates** panel (accessible from the sidebar) provides:

- **Auto-update on startup** toggle — persisted via `tauri-plugin-store` to `$APPCONFIG/settings.json`
- **Check for updates** button — manual one-shot check that shows a result inline

Preferences default to auto-update enabled. The toggle takes effect on the next app launch.

---

## Testing updates locally

This procedure lets you verify the full update flow (download → signature verification → install → relaunch) without publishing a real GitHub release.

### Prerequisites

You need a signing key. If you don't have one yet:

```bash
cd desktop
npx @tauri-apps/cli signer generate -w ~/.tauri/starlib.key
# Copy the printed public key into desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey
```

Export the key for your current shell session:

```bash
export TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/starlib.key)
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""   # empty if no password set
```

### Step 1 — Point the updater at localhost

In `desktop/src-tauri/tauri.conf.json`, temporarily change the endpoint:

```json
"plugins": {
  "updater": {
    "endpoints": ["http://127.0.0.1:9999/latest.json"]
  }
}
```

Also add `http://127.0.0.1:9999` to the `app.security.csp` `connect-src` directive.

> Remember to revert these changes after testing.

### Step 2 — Build and install the "old" version (0.2.4)

```bash
# From repo root
uv run pyinstaller desktop/sidecar.spec --distpath desktop/src-tauri/binaries --noconfirm
mv desktop/src-tauri/binaries/starlib-backend \
   desktop/src-tauri/binaries/starlib-backend-aarch64-apple-darwin

cd frontend && NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build && cd ..
cd desktop && npx @tauri-apps/cli build --target aarch64-apple-darwin
```

Open the `.dmg` from `target/aarch64-apple-darwin/release/bundle/dmg/` and drag it to `/Applications`. This is "the app already installed on the user's machine".

### Step 3 — Bump to a higher version and build the update

```bash
# Bump version in both files
sed -i '' 's/version = "0.2.4"/version = "0.2.5"/' desktop/src-tauri/Cargo.toml
jq --indent 4 '.version = "0.2.5"' desktop/src-tauri/tauri.conf.json > tmp.json && mv tmp.json desktop/src-tauri/tauri.conf.json

# Rebuild (sidecar can be skipped if unchanged)
cd frontend && NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run build && cd ..
cd desktop && npx @tauri-apps/cli build --target aarch64-apple-darwin
```

### Step 4 — Generate `latest.json` and serve it

```bash
BUNDLE_DIR="target/aarch64-apple-darwin/release/bundle/macos"
TAR=$(ls "$BUNDLE_DIR"/*.app.tar.gz | head -1 | xargs basename)
SIG=$(cat "$BUNDLE_DIR/$TAR.sig")

mkdir -p /tmp/starlib-update
cp "$BUNDLE_DIR/$TAR" /tmp/starlib-update/
cp "$BUNDLE_DIR/$TAR.sig" /tmp/starlib-update/

cat > /tmp/starlib-update/latest.json <<EOF
{
  "version": "0.2.5",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "url": "http://127.0.0.1:9999/$TAR",
      "signature": "$SIG"
    }
  }
}
EOF

# Start the local update server
cd /tmp/starlib-update && python3 -m http.server 9999
```

### Step 5 — Trigger the update

Open the installed 0.2.4 app from `/Applications`. One of two things will happen:

- **If auto-update is on (default):** an update banner appears at the top of the app within a few seconds of startup.
- **If auto-update is off:** open **Settings → Updates** and click **Check for updates**.

Click **Update now** → the app downloads the `.app.tar.gz`, verifies the signature, extracts it, and relaunches as 0.2.5.

### Step 6 — Clean up

```bash
# Revert version bumps
sed -i '' 's/version = "0.2.5"/version = "0.2.4"/' desktop/src-tauri/Cargo.toml
jq --indent 4 '.version = "0.2.4"' desktop/src-tauri/tauri.conf.json > tmp.json && mv tmp.json desktop/src-tauri/tauri.conf.json

# Restore the real endpoint in tauri.conf.json:
# "endpoints": ["https://github.com/fstermann/starlib/releases/latest/download/latest.json"]
# Remove http://127.0.0.1:9999 from the CSP connect-src
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
