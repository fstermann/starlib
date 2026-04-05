# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Starlib backend sidecar.

Build with:
    pyinstaller desktop/sidecar.spec

Output: dist/starlib-backend  (or dist/starlib-backend.exe on Windows)
The resulting binary is placed alongside the Tauri app bundle as a sidecar.

Notes
-----
- reload=False is enforced via the BACKEND_RELOAD=false env var baked in.
- The binary binds to 127.0.0.1:8000 (localhost only).
- All data files (soundcloud_tools, backend) are included via collect_all.
"""

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

# ── Paths ──────────────────────────────────────────────────────────────────
root = Path(SPECPATH).parent  # repo root

# ── Collect packages that have data files / dynamic imports ───────────────
datas = []
binaries = []
hiddenimports = []

for pkg in [
    "soundcloud_tools",
    "backend",
    "fastapi",
    "uvicorn",
    "starlette",
    "pydantic",
    "pydantic_settings",
    "httpx",
    "anyio",
    "mutagen",
]:
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# ── Entry-point analysis ───────────────────────────────────────────────────
a = Analysis(
    [str(root / "desktop" / "sidecar_entry.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + [
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi_pagination",
        "fastapi_pagination.ext.sqlalchemy",
        "multipart",
        "mutagen",
        "mutagen.aiff",
        "mutagen.easyid3",
        "mutagen.id3",
        "mutagen.mp3",
        "mutagen.wave",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["essentia", "scipy", "numpy", "tensorflow"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="starlib-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # keep console for server logs
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,  # None = native arch; set to "universal2" for fat binary
    codesign_identity="-",  # ad-hoc sign so Team ID matches Tauri's ad-hoc signature
    entitlements_file=str(root / "desktop" / "src-tauri" / "Entitlements.plist"),
)
