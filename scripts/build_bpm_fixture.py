"""Build the BPM accuracy fixture manifest.

Pipeline:
  1. `fetch`  Download a configured set of Beatport genre top-100 chart pages
              and cache the HTML under `scripts/.cache/beatport/`.
  2. `parse`  Extract the embedded `__NEXT_DATA__` JSON from each cached page
              and write a flat list of Beatport rows to
              `scripts/.cache/beatport_rows.json`.
  3. `match`  For each Beatport row, query SoundCloud search (via the
              existing `soundcloud_tools` client) and keep the top track
              whose artist+title fuzzy match >= a threshold and whose
              duration is within ~10 s of Beatport's reported length.
              Emit the final committed manifest at
              `fixtures/bpm/manifest.json`.
  4. `build`  Run fetch -> parse -> match end to end.

The Beatport `bpm` field is the ground truth label; SoundCloud provides the
streamable audio our Rust detector analyses.

Volume is intentionally tiny: one request per chart page, cached locally,
no republishing of Beatport content beyond the BPM scalar and our internal
ids. This script is for offline research / regression measurement and is
not part of the shipped product.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests

from soundcloud_tools.oauth import OAuthManager
from soundcloud_tools.settings import get_settings

logger = logging.getLogger("build_bpm_fixture")

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = REPO_ROOT / "scripts" / ".cache" / "beatport"
ROWS_JSON = REPO_ROOT / "scripts" / ".cache" / "beatport_rows.json"
MANIFEST_PATH = REPO_ROOT / "fixtures" / "bpm" / "manifest.json"

# Genres chosen for stylistic spread across electronic music. Each Beatport
# top-100 page yields up to 100 rows; we don't need all of them after SC
# matching attrition.
DEFAULT_GENRES: list[tuple[str, int]] = [
    ("techno-peak-time-driving", 6),
    ("house", 5),
    ("melodic-house-techno", 90),
    ("drum-and-bass", 1),
    ("trance-main-floor", 7),
    ("minimal-deep-tech", 14),
]

BEATPORT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)

# Matching thresholds.
TITLE_FUZZ_MIN = 0.78
ARTIST_FUZZ_MIN = 0.70
DURATION_TOLERANCE_S = 10
SC_SEARCH_LIMIT = 10


@dataclass
class BeatportRow:
    beatport_id: int
    artist: str
    title: str
    mix_name: str
    bpm: int
    genre: str
    length_ms: int
    key: str | None


@dataclass
class ManifestEntry:
    sc_track_id: int
    truth_bpm: int
    source_bpm: int
    halftime_normalized: bool
    artist: str
    title: str
    genre: str
    duration_s: int
    source: str = "beatport"


def _normalize_truth(genre: str, source_bpm: int) -> tuple[int, bool]:
    """Fold half-time labels onto the physical tempo.

    Some Beatport D&B labels tag tracks at half-time (e.g. 87 BPM for a
    track that audibly pulses at 174). The detector finds the physical
    tempo; we normalise the truth label to match so the measurement is
    not artificially penalised by labelling convention.
    """
    if genre == "Drum & Bass" and source_bpm < 100:
        return source_bpm * 2, True
    return source_bpm, False


# ---------- fetch ----------


def fetch_chart(slug: str, genre_id: int, *, force: bool = False) -> Path:
    """Download one Beatport top-100 chart page; return the cached path."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / f"{slug}-{genre_id}.html"
    if path.exists() and not force:
        logger.info("cache hit: %s", path.name)
        return path
    url = f"https://www.beatport.com/genre/{slug}/{genre_id}/top-100"
    logger.info("GET %s", url)
    resp = requests.get(
        url,
        headers={
            "User-Agent": BEATPORT_UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=30,
    )
    resp.raise_for_status()
    path.write_text(resp.text)
    # Be friendly to Beatport: brief pause between chart fetches.
    time.sleep(1.5)
    return path


def cmd_fetch(genres: list[tuple[str, int]], force: bool) -> None:
    for slug, gid in genres:
        fetch_chart(slug, gid, force=force)


# ---------- parse ----------

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.S,
)


def _find_track_lists(node: Any) -> list[list[dict]]:
    """Walk the Next.js page payload, return every list of track dicts."""
    out: list[list[dict]] = []

    def visit(n: Any) -> None:
        if isinstance(n, dict):
            for v in n.values():
                visit(v)
        elif isinstance(n, list):
            if n and isinstance(n[0], dict) and "bpm" in n[0] and "name" in n[0]:
                out.append(n)
            for v in n:
                visit(v)

    visit(node)
    return out


def parse_chart(html_path: Path) -> list[BeatportRow]:
    text = html_path.read_text()
    m = _NEXT_DATA_RE.search(text)
    if not m:
        logger.warning("no __NEXT_DATA__ in %s", html_path.name)
        return []
    data = json.loads(m.group(1))
    rows: list[BeatportRow] = []
    seen_ids: set[int] = set()
    for track_list in _find_track_lists(data):
        for t in track_list:
            tid = t.get("id")
            if not isinstance(tid, int) or tid in seen_ids:
                continue
            artists = t.get("artists") or []
            artist_name = ", ".join(a.get("name", "") for a in artists if a.get("name"))
            genre = (t.get("genre") or {}).get("name") or html_path.stem
            key = (t.get("key") or {}).get("name")
            length_ms = t.get("length_ms")
            bpm = t.get("bpm")
            title = t.get("name")
            mix = t.get("mix_name") or ""
            if not (artist_name and title and isinstance(bpm, int) and isinstance(length_ms, int)):
                continue
            seen_ids.add(tid)
            rows.append(
                BeatportRow(
                    beatport_id=tid,
                    artist=artist_name,
                    title=title,
                    mix_name=mix,
                    bpm=bpm,
                    genre=genre,
                    length_ms=length_ms,
                    key=key,
                )
            )
    return rows


def cmd_parse() -> list[BeatportRow]:
    all_rows: list[BeatportRow] = []
    seen: set[int] = set()
    for html in sorted(CACHE_DIR.glob("*.html")):
        rows = parse_chart(html)
        for r in rows:
            if r.beatport_id in seen:
                continue
            seen.add(r.beatport_id)
            all_rows.append(r)
        logger.info("%s -> %d rows", html.name, len(rows))
    ROWS_JSON.parent.mkdir(parents=True, exist_ok=True)
    ROWS_JSON.write_text(json.dumps([asdict(r) for r in all_rows], indent=2))
    logger.info("wrote %d unique rows to %s", len(all_rows), ROWS_JSON)
    return all_rows


# ---------- match ----------


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def _fuzz(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _score_candidate(row: BeatportRow, cand: dict) -> tuple[float, dict]:
    """Return (composite_score, diagnostics) for a SC v1-search candidate."""
    sc_title: str = cand.get("title") or ""
    sc_user: str = (cand.get("user") or {}).get("username") or ""
    sc_duration: int = cand.get("duration") or 0
    title_f = _fuzz(row.title, sc_title)
    # SC titles often pack "Artist - Title (Mix)" together; try the right half too.
    if " - " in sc_title:
        title_f = max(title_f, _fuzz(row.title, sc_title.split(" - ", 1)[1]))
    artist_f = _fuzz(row.artist, sc_user)
    if " - " in sc_title:
        artist_f = max(artist_f, _fuzz(row.artist, sc_title.split(" - ", 1)[0]))
    dur_delta = abs(sc_duration // 1000 - row.length_ms // 1000)
    dur_ok = dur_delta <= DURATION_TOLERANCE_S
    score = 0.6 * title_f + 0.3 * artist_f + (0.1 if dur_ok else 0.0)
    return score, {
        "title_f": round(title_f, 3),
        "artist_f": round(artist_f, 3),
        "dur_delta": dur_delta,
        "sc_title": sc_title,
        "sc_user": sc_user,
    }


def _sc_search(query: str, token: str) -> list[dict]:
    """Hit the public v1 search endpoint with a Client-Credentials token.

    The library's `Client.search` targets `api-v2.soundcloud.com`, which
    rejects Client-Credentials tokens (web-client only). v1 accepts them
    and returns the same Track shape we need: id / title / duration / user.
    """
    resp = requests.get(
        "https://api.soundcloud.com/tracks",
        params={"q": query, "limit": SC_SEARCH_LIMIT, "access": "playable"},
        headers={"Authorization": f"OAuth {token}", "Accept": "application/json"},
        timeout=20,
    )
    if resp.status_code != 200:
        logger.warning("v1 search %s -> http %s", query, resp.status_code)
        return []
    data = resp.json()
    return data if isinstance(data, list) else []


def match_row(row: BeatportRow, token: str) -> ManifestEntry | None:
    query = f"{row.artist} {row.title}"
    candidates = _sc_search(query, token)
    if not candidates:
        return None
    best: tuple[float, dict, dict] | None = None
    for c in candidates:
        score, diag = _score_candidate(row, c)
        if best is None or score > best[0]:
            best = (score, c, diag)
    assert best is not None
    _, track, diag = best
    if diag["title_f"] < TITLE_FUZZ_MIN or diag["artist_f"] < ARTIST_FUZZ_MIN:
        logger.debug("reject %r: %s", query, diag)
        return None
    if diag["dur_delta"] > DURATION_TOLERANCE_S:
        logger.debug("reject %r (duration): %s", query, diag)
        return None
    truth_bpm, normalized = _normalize_truth(row.genre, row.bpm)
    return ManifestEntry(
        sc_track_id=int(track["id"]),
        truth_bpm=truth_bpm,
        source_bpm=row.bpm,
        halftime_normalized=normalized,
        artist=row.artist,
        title=row.title,
        genre=row.genre,
        duration_s=int(track["duration"]) // 1000,
    )


def cmd_match(rows: list[BeatportRow], *, sleep_s: float = 0.25) -> list[ManifestEntry]:
    settings = get_settings()
    if not (settings.client_id and settings.client_secret):
        logger.error("CLIENT_ID and CLIENT_SECRET must be configured (run the desktop setup wizard).")
        return []
    oauth = OAuthManager(client_id=settings.client_id, client_secret=settings.client_secret)
    entries: list[ManifestEntry] = []
    for i, row in enumerate(rows, 1):
        token = oauth.get_access_token()
        entry = match_row(row, token)
        if entry is not None:
            entries.append(entry)
            logger.info("[%d/%d] matched: %s - %s -> sc:%d", i, len(rows), row.artist, row.title, entry.sc_track_id)
        else:
            logger.info("[%d/%d] no match: %s - %s", i, len(rows), row.artist, row.title)
        time.sleep(sleep_s)
    entries.sort(key=lambda e: (e.genre, e.sc_track_id))
    write_manifest(entries)
    return entries


def write_manifest(entries: list[ManifestEntry]) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(
            {
                "version": 2,
                "source": "beatport-top-100 + soundcloud-audio",
                "entries": [asdict(e) for e in entries],
            },
            indent=2,
        )
        + "\n"
    )
    logger.info("wrote %d manifest entries to %s", len(entries), MANIFEST_PATH)


def cmd_normalize() -> None:
    """Re-apply truth normalization to an existing manifest without re-matching."""
    data = json.loads(MANIFEST_PATH.read_text())
    entries: list[ManifestEntry] = []
    for raw in data["entries"]:
        # Tolerate both v1 (`beatport_bpm`) and v2 manifests as input.
        source_bpm = int(raw.get("source_bpm", raw.get("beatport_bpm")))
        genre = raw["genre"]
        truth, normalized = _normalize_truth(genre, source_bpm)
        entries.append(
            ManifestEntry(
                sc_track_id=int(raw["sc_track_id"]),
                truth_bpm=truth,
                source_bpm=source_bpm,
                halftime_normalized=normalized,
                artist=raw["artist"],
                title=raw["title"],
                genre=genre,
                duration_s=int(raw["duration_s"]),
            )
        )
    entries.sort(key=lambda e: (e.genre, e.sc_track_id))
    write_manifest(entries)
    n_norm = sum(1 for e in entries if e.halftime_normalized)
    logger.info("normalized %d / %d entries", n_norm, len(entries))


# ---------- cli ----------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["fetch", "parse", "match", "build", "token", "normalize"])
    parser.add_argument("--force", action="store_true", help="ignore HTML cache")
    parser.add_argument("--sleep", type=float, default=0.25, help="seconds between SC requests")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.command == "fetch":
        cmd_fetch(DEFAULT_GENRES, force=args.force)
    elif args.command == "parse":
        cmd_parse()
    elif args.command == "match":
        if not ROWS_JSON.exists():
            logger.error("run `parse` first to produce %s", ROWS_JSON)
            return 2
        rows = [BeatportRow(**r) for r in json.loads(ROWS_JSON.read_text())]
        cmd_match(rows, sleep_s=args.sleep)
    elif args.command == "build":
        cmd_fetch(DEFAULT_GENRES, force=args.force)
        rows = cmd_parse()
        cmd_match(rows, sleep_s=args.sleep)
    elif args.command == "normalize":
        cmd_normalize()
    elif args.command == "token":
        # Print a fresh Client-Credentials OAuth token for the cargo bench.
        # The token is valid for ~1 hour; pipe into the env, e.g.
        #   export SC_OAUTH_TOKEN=$(uv run python scripts/build_bpm_fixture.py token)
        settings = get_settings()
        if not (settings.client_id and settings.client_secret):
            logger.error("CLIENT_ID and CLIENT_SECRET must be configured.")
            return 2
        oauth = OAuthManager(client_id=settings.client_id, client_secret=settings.client_secret)
        print(oauth.get_access_token())
    return 0


if __name__ == "__main__":
    sys.exit(main())
