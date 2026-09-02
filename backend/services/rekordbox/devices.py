"""Discovery of mounted Rekordbox USB/SD exports.

Scans the platform's mount points for a Device Library Plus export
(``PIONEER/rekordbox/exportLibrary.db``). Only devices we can actually read
show up — a stick with just the legacy ``export.pdb`` is skipped.
"""

from __future__ import annotations

import glob
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .usb import _EXPORT_DB_REL


class EjectError(RuntimeError):
    """Raised when a device cannot be unmounted/ejected."""


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


def _eject_command(mount_path: str) -> list[str]:
    """Return the platform command to safely eject a mounted device."""
    if sys.platform == "darwin":
        diskutil = "/usr/sbin/diskutil" if Path("/usr/sbin/diskutil").exists() else "diskutil"
        return [diskutil, "eject", mount_path]
    return ["umount", mount_path]


def eject_device(mount_path: str) -> None:
    """Safely unmount/eject a device by its mount path.

    Args:
        mount_path: The device's mount point (its discovery id).

    Raises:
        EjectError: If the unmount command is missing, times out, or fails
            (e.g. the volume is busy).
    """
    try:
        proc = subprocess.run(
            _eject_command(mount_path),
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise EjectError(str(exc)) from exc
    if proc.returncode != 0:
        raise EjectError(proc.stderr.strip() or f"eject failed (exit {proc.returncode})")
