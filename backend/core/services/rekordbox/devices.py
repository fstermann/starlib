"""Discovery of mounted Rekordbox USB/SD exports.

Scans the platform's mount points for a Device Library Plus export
(``PIONEER/rekordbox/exportLibrary.db``). Only devices we can actually read
show up — a stick with just the legacy ``export.pdb`` is skipped.
"""

from __future__ import annotations

import glob
import sys
from dataclasses import dataclass
from pathlib import Path

from .usb import _EXPORT_DB_REL


@dataclass(frozen=True)
class UsbDevice:
    id: str
    label: str
    mount_path: str


def _candidate_mounts() -> list[Path]:
    """Return mount points to probe, per platform."""
    if sys.platform == "darwin":
        return list(Path("/Volumes").glob("*"))
    patterns = ("/media/*", "/media/*/*", "/run/media/*/*", "/mnt/*")
    return [Path(p) for pat in patterns for p in glob.glob(pat)]


def discover_usb_devices() -> list[UsbDevice]:
    """Return every mounted device that carries a readable export.

    Returns:
        Discovered devices, keyed by their mount path (used as the id), sorted
        by label.
    """
    out: list[UsbDevice] = []
    for mount in _candidate_mounts():
        try:
            if (mount / _EXPORT_DB_REL).is_file():
                out.append(UsbDevice(id=str(mount), label=mount.name, mount_path=str(mount)))
        except OSError:
            continue
    return sorted(out, key=lambda d: d.label.lower())
