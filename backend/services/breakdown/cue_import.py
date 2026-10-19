"""Replace a Set Breakdown job's tracklist with the tracks of a CUE sheet."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.domain.cue import decode_cue, drop_repeats, parse_cue
from backend.infra.audio.track_handler import read_audio_length, read_starlib_meta
from backend.infra.breakdown import db
from backend.services.breakdown.controller import set_bpm_at
from backend.services.breakdown.soundcloud_links import UNKNOWN_TITLE


@dataclass(frozen=True, slots=True)
class CueImport:
    """How many tracks a CUE import added, and how many repeated entries it skipped."""

    imported: int
    skipped: int


def import_cue(job_id: str, raw: bytes, *, skip_repeats: bool = True) -> CueImport:
    """Replace the job's tracklist with the sheet's tracks, each confirmed.

    The sheet is the DJ's own record of the set, so its tracks are marked
    confirmed: a later Shazam scan skips them. Each track runs until the
    next one starts; the last until the end of the mix. A track whose source
    file (rekordbox writes one per track) carries a SoundCloud id in its
    Starlib tag is linked to that upload, and the file gives the track's
    length. A sheet with no
    timed track raises ``ValueError`` before the tracklist is touched.

    Args:
        job_id: Breakdown job.
        raw: The CUE file's bytes.
        skip_repeats: Drop entries for a track already listed earlier, which
            rekordbox writes when a deck is played again (see :func:`drop_repeats`).

    Returns:
        Counts of imported and skipped entries.
    """
    sheet = parse_cue(decode_cue(raw))
    tracks = drop_repeats(sheet.tracks) if skip_repeats else sheet.tracks
    job = db.get_job(job_id)
    duration_s = job.duration_s if job is not None else None
    ends = [t.start_s for t in tracks[1:]] + [duration_s]
    # Read every source file before touching the tracklist, so a slow or failing read leaves it intact.
    rows = []
    for track, end_s in zip(tracks, ends, strict=True):
        if end_s is not None and end_s <= track.start_s:
            end_s = None
        source = Path(track.file) if track.file else None
        meta = read_starlib_meta(source) if source else None
        length = read_audio_length(source) if source else None
        rows.append((track, end_s, meta, length, set_bpm_at(job_id, track.start_s, end_s)))
    db.delete_tracks_for_job(job_id)
    for track, end_s, meta, length, set_bpm in rows:
        row = db.insert_track(
            job_id=job_id,
            origin="manual",
            start_s=track.start_s,
            end_s=end_s,
            title=track.title or UNKNOWN_TITLE,
            artist=track.performer,
            soundcloud_id=meta.soundcloud_id if meta else None,
            soundcloud_permalink_url=meta.soundcloud_permalink if meta else None,
            user_edited=True,
            duration_s=length,
            set_bpm=set_bpm,
        )
        db.update_track(job_id, row.id, confirmed=True)
    return CueImport(imported=len(tracks), skipped=len(sheet.tracks) - len(tracks))
