"""Rekordbox library sources.

Exposes the :class:`RekordboxSource` contract and its implementations. The API
layer resolves a source via :func:`get_source` and never talks to a concrete
implementation directly, so adding a new backing store (e.g. a USB export) is a
matter of adding a source class and teaching :func:`get_source` to return it.
"""

from __future__ import annotations

from .base import (
    RekordboxPlaylist,
    RekordboxSource,
    RekordboxTrack,
    RekordboxUnavailable,
)
from .devices import UsbDevice, discover_usb_devices
from .local import LocalMasterDbSource
from .usb import UsbExportSource

__all__ = [
    "LocalMasterDbSource",
    "RekordboxPlaylist",
    "RekordboxSource",
    "RekordboxTrack",
    "RekordboxUnavailable",
    "UsbDevice",
    "UsbExportSource",
    "discover_usb_devices",
    "get_source",
]

_local_source: LocalMasterDbSource | None = None
_usb_sources: dict[str, UsbExportSource] = {}


def get_source(device: str | None = None) -> RekordboxSource:
    """Return the Rekordbox source for a device id, or the local install.

    Args:
        device: A discovered USB device id (its mount path), or ``None`` for the
            local ``master.db`` install.

    Returns:
        The matching source. USB sources are cached per device.

    Raises:
        RekordboxUnavailable: If ``device`` is not a currently-mounted export.
    """
    global _local_source
    if not device:
        if _local_source is None:
            _local_source = LocalMasterDbSource()
        return _local_source

    if device not in {d.id for d in discover_usb_devices()}:
        raise RekordboxUnavailable(f"Rekordbox USB device not found: {device}")
    source = _usb_sources.get(device)
    if source is None:
        source = UsbExportSource(device)
        _usb_sources[device] = source
    return source
