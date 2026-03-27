# Icons

Place the following icon files in this directory before building:

| File | Size | Purpose |
|------|------|---------|
| `32x32.png` | 32×32 px | Windows taskbar / tray |
| `128x128.png` | 128×128 px | macOS Finder |
| `128x128@2x.png` | 256×256 px | macOS Retina |
| `icon.icns` | Multi-size | macOS app bundle (required for `.dmg`) |
| `icon.ico` | Multi-size | Windows installer |
| `icon.png` | 512×512 px | Source — used to generate all of the above |

## Generating icons from a single source PNG

With `tauri-cli` installed, run from the repo root:

```bash
cd desktop && npx @tauri-apps/cli icon icon.png
```

This will produce all required sizes automatically from a 512×512 (minimum) source image.

## Quick placeholder (CI)

If no icon is provided the build will fail. For CI purposes, a 512×512 placeholder can be generated with ImageMagick:

```bash
convert -size 512x512 xc:#f97316 \
  -fill white -font Helvetica -pointsize 120 \
  -gravity center -annotate 0 "Starlib" \
  icon.png
```
