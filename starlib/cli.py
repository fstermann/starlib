"""Starlib CLI."""

import argparse
import logging
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
TRACKS_CACHE = Path(__file__).parent.parent / ".cache/screenshot-tracks.json"


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

    subparsers.add_parser("screenshot", help="Capture documentation screenshots")

    args = parser.parse_args()

    if args.command == "screenshot":
        sys.exit(cmd_screenshot(args))
    else:
        parser.print_help()
        sys.exit(1)
