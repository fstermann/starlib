"""One-shot migration of starlib metadata from COMM::XXX to TXXX:starlib.

Reads every audio file under ``folder``; the read path detects legacy data in
COMM::XXX and surfaces it on ``TrackInfo`` (either as ``starlib_meta`` if the
blob parses as ``key=value`` pairs, or as ``user_comment`` otherwise).  Writing
back evicts COMM::XXX and persists the data in its proper slot
(``TXXX:starlib`` for app data, ``COMM::eng`` for the user's comment).

Idempotent: files already on the new layout are skipped.

Usage:
    uv run python scripts/migrate_starlib_meta.py <folder> [--dry-run]
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from soundcloud_tools.handler.track import TrackHandler

logger = logging.getLogger(__name__)


def migrate_folder(folder: Path, *, dry_run: bool = False) -> dict[str, int]:
    handlers = TrackHandler.load_all(folder)
    counts = {"migrated": 0, "skipped": 0, "failed": 0, "recovered_user_comment": 0}
    for h in handlers:
        try:
            tags = h.track.tags
            has_new = tags.get("TXXX:starlib") is not None
            legacy = tags.get("COMM::XXX")
            if has_new and not legacy:
                counts["skipped"] += 1
                continue
            info = h.track_info
            recovered = bool(info.user_comment and not has_new)
            if dry_run:
                print(f"[dry-run] would migrate: {h.file}")
            else:
                h.add_info(info, artwork=h.get_single_cover(raise_error=False))
            if recovered:
                counts["recovered_user_comment"] += 1
            counts["migrated"] += 1
        except Exception as e:
            counts["failed"] += 1
            print(f"FAILED {h.file}: {e}", file=sys.stderr)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Folder to scan recursively")
    parser.add_argument("--dry-run", action="store_true", help="Don't write anything")
    args = parser.parse_args()

    if not args.folder.is_dir():
        print(f"Not a directory: {args.folder}", file=sys.stderr)
        return 2

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    counts = migrate_folder(args.folder, dry_run=args.dry_run)
    print(
        "migrated={migrated} skipped={skipped} failed={failed} recovered_user_comment={recovered_user_comment}".format(
            **counts
        )
    )
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
