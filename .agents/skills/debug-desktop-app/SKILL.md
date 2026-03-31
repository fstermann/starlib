---
name: debug-desktop-app
description: "Debug the live Starlib.app desktop application. Use when: diagnosing issues in the installed/bundled Tauri app, viewing sidecar logs, inspecting the webview, checking backend health, or troubleshooting the production build running from /Applications/Starlib.app."
---

# Debug Live Starlib Desktop App

Bundle: Tauri shell (Rust) → webview (`frontend/out/`) + sidecar (PyInstaller FastAPI on `127.0.0.1:8000`).

## Logs

- **Terminal launch**: `/Applications/Starlib.app/Contents/MacOS/Starlib` — shows `[backend]`/`[backend:err]` prefixed sidecar output
- **Console.app**: filter by process `Starlib`
- **Crash reports**: `~/Library/Logs/DiagnosticReports/Starlib-*.ips`

## Webview DevTools

Safari → Settings → Advanced → Show Develop menu, then **Develop → [machine] → Starlib**.

## Backend Health

```bash
curl http://127.0.0.1:8000/health
```

Tauri watchdog retries 3x (2s delay). Look for `[backend] process exited` in terminal output.

## Key Paths

- Config/cache: `~/Library/Application Support/starlib/`
- Sidecar binary: `/Applications/Starlib.app/Contents/MacOS/starlib-backend-aarch64-apple-darwin`
- Run sidecar standalone: execute the binary directly (exits when stdin closes)

## Common Issues

| Symptom                         | Fix                                                                     |
| ------------------------------- | ----------------------------------------------------------------------- |
| Blank/white screen              | Launch from terminal, check `[backend]` logs                            |
| `UnicodeEncodeError: 'latin-1'` | Non-ASCII in HTTP headers — sanitize in `backend/api/metadata/audio.py` |
| Port 8000 in use                | `lsof -i :8000` and kill conflicting process                            |
| Backend crash loop              | Run sidecar binary standalone for full traceback                        |

## Debug Build

```bash
cd desktop && cargo tauri build --debug
```

Output: `target/debug/bundle/`.
