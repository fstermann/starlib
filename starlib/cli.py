"""Starlib CLI."""

import argparse
import logging
import shutil
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
DESKTOP_DIR = ROOT_DIR / "desktop"
ICONS_DIR = DESKTOP_DIR / "src-tauri" / "icons"
ASSETS_DIR = ROOT_DIR / "assets"
TRACKS_CACHE = ROOT_DIR / ".cache/screenshot-tracks.json"


def cmd_icons(args: argparse.Namespace) -> int:
    """Generate desktop app icons from the source PNG, skipping iOS/Android/AppX."""
    source = Path(args.source) if args.source else ASSETS_DIR / "starlib-dark-grad.png"
    if not source.exists():
        logger.error("Source icon not found: %s", source)
        return 1

    result = subprocess.run(
        ["npx", "@tauri-apps/cli", "icon", str(source.resolve())],
        cwd=DESKTOP_DIR,
    )
    if result.returncode != 0:
        return result.returncode

    # Remove platform-specific outputs we don't need
    for entry in ICONS_DIR.iterdir():
        if entry.is_dir() and entry.name in ("ios", "android"):
            shutil.rmtree(entry)
            logger.info("Removed %s/", entry.name)
        elif entry.is_file() and (entry.name.startswith("Square") or entry.name == "StoreLogo.png"):
            entry.unlink()
            logger.info("Removed %s", entry.name)

    return 0


def cmd_screenshot(args: argparse.Namespace) -> int:
    """Fetch fresh track metadata then capture documentation screenshots."""
    if TRACKS_CACHE.exists():
        TRACKS_CACHE.unlink()
        logger.info("Deleted existing track cache.")

    setup = subprocess.run(
        ["npx", "playwright", "test", "--config", "e2e/screenshots-setup.config.ts", "--pass-with-no-tests"],
        cwd=FRONTEND_DIR,
    )
    if setup.returncode != 0:
        return setup.returncode

    result = subprocess.run(
        [
            "npx",
            "playwright",
            "test",
            "--project=screenshots",
            "screenshots.spec.ts",
            "--reporter=list",
        ],
        cwd=FRONTEND_DIR,
    )
    return result.returncode


def main() -> None:
    parser = argparse.ArgumentParser(prog="starlib", description="Starlib CLI")
    subparsers = parser.add_subparsers(dest="command", metavar="command")

    p_icons = subparsers.add_parser("icons", help="Generate desktop app icons")
    p_icons.add_argument("--source", metavar="PNG", help="Source PNG (default: assets/starlib-dark-grad.png)")

    subparsers.add_parser("screenshot", help="Capture documentation screenshots")

    args = parser.parse_args()

    if args.command == "icons":
        sys.exit(cmd_icons(args))
    elif args.command == "screenshot":
        sys.exit(cmd_screenshot(args))
    else:
        parser.print_help()
        sys.exit(1)
