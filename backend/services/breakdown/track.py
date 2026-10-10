"""Analyse one local track: stems, measurements, then first-guess sections."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.domain.arrangement import BarLevels, Section, detect_sections
from backend.infra.breakdown import stems as stems_infra
from backend.infra.breakdown import track as track_infra

# Must match `starlib_audio::breakdown::PIPELINE_VERSION`.
PIPELINE_VERSION = 1


@dataclass(frozen=True)
class TrackBreakdown:
    """Measured features and detected sections of one track.

    Attributes:
        digest: Hash of the decoded audio; the cache key.
        features: The ``features.json`` document.
        sections: First-guess sections.
    """

    digest: str
    features: dict[str, Any]
    sections: list[Section]


async def analyse_track(path: Path, on_stage: Callable[[str], None] = lambda _: None) -> TrackBreakdown:
    """Analyse ``path``, reusing cached stems and features when present.

    Args:
        path: Local audio file.
        on_stage: Called with ``"stems"`` and then each measured source name.

    Returns:
        The track's features and sections.
    """
    digest = await track_infra.audio_hash(path)
    cache = track_infra.track_dir(digest)
    features_path = cache / "features.json"
    features = _cached_features(features_path)
    if features is None:
        on_stage("stems")
        stems = await stems_infra.separate(path, cache / "stems")
        features = await track_infra.measure(path, stems, features_path, on_stage)
    return TrackBreakdown(digest=digest, features=features, sections=detect_sections(bar_levels(features)))


def _cached_features(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    features = json.loads(path.read_text())
    return features if features.get("pipeline_version") == PIPELINE_VERSION else None


def bar_levels(features: dict[str, Any]) -> list[BarLevels]:
    """Pick the per-bar levels sectioning needs out of a features document.

    Args:
        features: The ``features.json`` document, with drums and bass stems.

    Returns:
        One entry per bar.
    """
    sources = features["sources"]
    mix, drums, bass = sources["mix"], sources["drums"], sources["bass"]
    return [
        BarLevels(
            kick_db=drums["bands_db"][i][0],
            bass_db=bass["db"][i],
            mix_db=mix["db"][i],
            high_db=mix["bands_db"][i][5],
            width=mix["width"][i],
        )
        for i in range(features["grid"]["n_bars"])
    ]
