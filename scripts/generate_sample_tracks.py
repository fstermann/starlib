"""Generate sample audio files with realistic ID3 metadata for dev / demo.

Synthesises silent audio via ffmpeg, then writes title/artist/genre/key/bpm/
release_date/artwork tags through ``TrackHandler`` so the resulting files
exercise the same code path the prepare → collection workflow uses.

The defaults are deliberately *messy*: they cycle through six realism profiles
(complete, no-genre, no-artwork, no-release, filename-only, title-plus-artist
only) so the editor's "not ready" badge, the SoundCloud auto-fill path, and
the filename-parsing heuristics all get exercised.  Artist/title pairs are
pulled from a list of real electronic tracks that reliably return hits on
SoundCloud search.

Usage:
    uv run python scripts/generate_sample_tracks.py ~/Music/tracks/prepare
    uv run python scripts/generate_sample_tracks.py ~/Music/tracks/prepare --count 30 --format aiff --remix
    uv run python scripts/generate_sample_tracks.py ~/Music/tracks/prepare --all-complete
"""

from __future__ import annotations

import argparse
import logging
import shutil
import struct
import subprocess
import sys
import zlib
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from soundcloud_tools.handler.track import StarlibMeta, TrackHandler, TrackInfo

logger = logging.getLogger(__name__)

# Real artist/title pairs — pulled from well-known electronic releases that
# reliably surface SoundCloud results when searched, so the single-editor's
# "Search SoundCloud" flow actually finds matches.
_REAL_TRACKS: tuple[tuple[str, str], ...] = (
    ("Daft Punk", "Around the World"),
    ("deadmau5", "Strobe"),
    ("Aphex Twin", "Windowlicker"),
    ("Four Tet", "Angel Echoes"),
    ("Burial", "Archangel"),
    ("Bonobo", "Cirrus"),
    ("Fred again..", "Delilah"),
    ("Jamie xx", "Gosh"),
    ("Caribou", "Odessa"),
    ("Floating Points", "Silhouettes"),
    ("Moderat", "A New Error"),
    ("Jon Hopkins", "Open Eye Signal"),
    ("Nicolas Jaar", "Mi Mujer"),
    ("Tale Of Us", "Nova Lume"),
    ("Maceo Plex", "Conjure Superstar"),
    ("Dixon", "Trichome"),
    ("DJ Koze", "Pick Up"),
    ("Âme", "Rej"),
    ("Recondite", "Riant"),
    ("Stephan Bodzin", "Powers of Ten"),
)

_GENRES = ("Deep House", "Techno", "Drum & Bass", "Garage", "Ambient", "Trance", "Melodic House")
_KEYS = ("8A", "5A", "11A", "4B", "7B", "12B", "1A", "9B")
_REMIXERS = ("Nyx", "Helix", "Vox", "Pell", "Stratus")
_MIX_TYPES = ("Remix", "VIP Mix", "Extended Mix", "Club Mix", "Dub Mix")


# ---------------------------------------------------------------------------
# Realism profiles
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Profile:
    """Describes which fields a sample should intentionally leave blank."""

    name: str
    has_title: bool = True
    has_artist: bool = True
    has_genre: bool = True
    has_key: bool = True
    has_bpm: bool = True
    has_release_date: bool = True
    has_artwork: bool = True
    # ``filename_from_tags`` = write an "artist - title.mp3" style filename
    # (what Starlib produces after save). When False the filename mimics a
    # messy download (underscores, "free dl" suffix, etc.).
    filename_from_tags: bool = True


_PROFILES: tuple[Profile, ...] = (
    Profile("complete"),  # fully tagged — the happy path
    Profile("missing_genre", has_genre=False, has_key=False, has_bpm=False),
    Profile("missing_artwork", has_artwork=False),
    Profile("missing_release_date", has_release_date=False),
    # Only the filename carries hints — like a freshly scraped SC download.
    Profile(
        "filename_only",
        has_title=False,
        has_artist=False,
        has_genre=False,
        has_key=False,
        has_bpm=False,
        has_release_date=False,
        has_artwork=False,
        filename_from_tags=False,
    ),
    # Title + artist but everything else blank — common for DJ edits.
    Profile(
        "title_plus_artist",
        has_genre=False,
        has_key=False,
        has_bpm=False,
        has_release_date=False,
        has_artwork=False,
        filename_from_tags=False,
    ),
)


# ---------------------------------------------------------------------------
# Audio + artwork helpers
# ---------------------------------------------------------------------------


def _make_silent_audio(path: Path, fmt: str, ffmpeg: str, seconds: float = 1.0) -> None:
    """Write *seconds* of silent audio at *path* using *ffmpeg*."""
    codec = {"mp3": ("libmp3lame", "-b:a", "192k"), "aiff": ("pcm_s16be",), "wav": ("pcm_s16le",)}[fmt]
    cmd = [
        ffmpeg,
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        str(seconds),
        "-c:a",
        *codec,
        str(path),
    ]
    subprocess.run(cmd, check=True)


def _tiny_png(rgb: tuple[int, int, int]) -> bytes:
    """Build a 4x4 solid-colour PNG so each track gets distinct embedded artwork."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return len(data).to_bytes(4, "big") + tag + data + zlib.crc32(tag + data).to_bytes(4, "big")

    width = height = 4
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes(rgb) * width  # filter byte 0 + scanline
    idat = zlib.compress(raw, 9)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


# ---------------------------------------------------------------------------
# Track construction
# ---------------------------------------------------------------------------


_FILENAME_STYLES = ("underscore", "freedl", "numbered", "plain", "noisy_brackets")


def _messy_filename(i: int, artist: str, title: str) -> str:
    """Produce a scraped-download-style filename that doesn't match tags perfectly."""
    style = _FILENAME_STYLES[i % len(_FILENAME_STYLES)]
    base = f"{artist} - {title}"
    if style == "underscore":
        return base.replace(" ", "_")
    if style == "freedl":
        return f"{base} (Free DL)"
    if style == "numbered":
        return f"{i + 1:02d}. {base}"
    if style == "noisy_brackets":
        return f"{base} [{_GENRES[i % len(_GENRES)]}]"
    return base  # plain


def _build_info(i: int, profile: Profile, *, with_remix: bool) -> TrackInfo:
    artist, title = _REAL_TRACKS[i % len(_REAL_TRACKS)]
    release = date(2024, 1, 1) + timedelta(days=i * 13)
    bpm = 110 + (i * 7) % 60  # 110..169
    genre = _GENRES[i % len(_GENRES)]
    key = _KEYS[i % len(_KEYS)]

    info = TrackInfo(
        title=title if profile.has_title else None,
        artist=artist if profile.has_artist else None,
        genre=genre if profile.has_genre else None,
        bpm=bpm if profile.has_bpm else None,
        key=key if profile.has_key else None,
        release_date=release if profile.has_release_date else None,
        release_year=release.year if profile.has_release_date else None,
        user_comment=f"Generated sample #{i + 1} [{profile.name}]",
        starlib_meta=StarlibMeta(version="dev-sample"),
    )
    if with_remix and i % 3 == 0 and profile.has_title:
        alt_artist = _REAL_TRACKS[(i + 1) % len(_REAL_TRACKS)][0]
        info.original_artist = alt_artist
        info.remixer = _REMIXERS[i % len(_REMIXERS)]
        info.mix_name = _MIX_TYPES[i % len(_MIX_TYPES)]
    if profile.has_artwork:
        rgb = ((i * 53) % 256, (i * 91) % 256, (i * 137) % 256)
        info.artwork = _tiny_png(rgb)
    return info


def _filename_stem(i: int, profile: Profile, info: TrackInfo, prefix: str) -> str:
    """Pick the on-disk filename for this sample.

    ``filename_from_tags=True`` produces the clean ``artist - title`` form so
    the file is "ready" as-is; False produces a messy download-style name so
    the editor's filename parser and SC search have something to chew on.
    """
    artist, title = _REAL_TRACKS[i % len(_REAL_TRACKS)]
    if profile.filename_from_tags and info.title and info.artist_str:
        body = f"{info.artist_str} - {info.title}"
    else:
        body = _messy_filename(i, artist, title)
    return f"{prefix}-{i + 1:03d}-{body}".replace("/", "-")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="Target folder; created if it doesn't exist")
    parser.add_argument("--count", type=int, default=10, help="Number of files to generate (default: 10)")
    parser.add_argument(
        "--format",
        choices=("mp3", "aiff", "wav"),
        default="mp3",
        help="Audio container/codec (default: mp3)",
    )
    parser.add_argument("--seconds", type=float, default=1.0, help="Audio length in seconds (default: 1.0)")
    parser.add_argument("--remix", action="store_true", help="Tag every 3rd track as a remix")
    parser.add_argument(
        "--all-complete",
        action="store_true",
        help="Skip the messy profiles and tag every track fully (demo-ready state)",
    )
    parser.add_argument("--prefix", default="sample", help="Filename prefix (default: 'sample')")
    args = parser.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        print("ffmpeg not found on PATH", file=sys.stderr)
        return 2

    args.folder.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    profiles = (_PROFILES[0],) if args.all_complete else _PROFILES

    written: list[Path] = []
    for i in range(args.count):
        profile = profiles[i % len(profiles)]
        info = _build_info(i, profile, with_remix=args.remix)
        stem = _filename_stem(i, profile, info, args.prefix)
        path = args.folder / f"{stem}.{args.format}"
        _make_silent_audio(path, args.format, ffmpeg, seconds=args.seconds)
        TrackHandler(root_folder=args.folder, file=path).add_info(info, artwork=info.artwork)
        written.append(path)
        print(f"  + [{profile.name:>18}] {path.name}")

    print(f"\nGenerated {len(written)} files in {args.folder}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
