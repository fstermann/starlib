import inspect
from datetime import UTC, datetime, timedelta
from enum import IntEnum
from math import ceil
from pathlib import Path
from typing import Any

from fake_useragent import UserAgent

from soundcloud_tools.models import Track


class Weekday(IntEnum):
    MONDAY = 0
    TUESDAY = 1
    WEDNESDAY = 2
    THURSDAY = 3
    FRIDAY = 4
    SATURDAY = 5
    SUNDAY = 6


def get_scheduled_time(day: Weekday = Weekday.SUNDAY, weeks: int = 0):
    now = datetime.now(tz=UTC)
    days_until = (day - now.weekday()) % 7
    last_day = now + timedelta(days=days_until, weeks=weeks)
    return last_day.replace(hour=8, minute=0, second=0, microsecond=0)


def get_week_of_month(date: datetime) -> int:
    """Returns the week of the month for the specified date."""
    first_day = date.replace(day=1)
    dom = date.day
    adjusted_dom = dom + first_day.weekday()
    return ceil(adjusted_dom / 7.0)


def get_default_kwargs(func):
    signature = inspect.signature(func)
    return {k: v.default for k, v in signature.parameters.items() if v.default is not inspect.Parameter.empty}


def generate_random_user_agent() -> str:
    return UserAgent().random


def convert_to_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def load_tracks(folder: Path, file_types: list[str] | None = None):
    files = list(folder.glob("*"))
    files = [
        f
        for f in files
        if f.is_file() and (f.suffix in file_types if file_types else True) and not f.stem.startswith(".")
    ]
    files.sort(key=lambda f: f.name)
    return files


def chunk_list(list_: list, n: int):
    """Yield successive n-sized chunks from lst."""
    for i in range(0, len(list_), n):
        yield list_[i : i + n]


def sort_tracks_by_playcount(tracks: list[Track]) -> list[Track]:
    """Sorts tracks by playcount in descending order."""
    return sorted(set(tracks), key=lambda x: x.playback_count or 0, reverse=True)


def sort_tracks_by_follower_count(tracks: list[Track]) -> list[Track]:
    """Sorts tracks by the follower count of the user who posted them in descending order."""
    return sorted(set(tracks), key=lambda x: x.user.followers_count or 0, reverse=True)


def get_unique_track_ids(tracks: list[Track]) -> list[int]:
    """Returns a list of unique track IDs from the provided tracks."""
    track_ids = []
    for track in tracks:
        if track.id not in track_ids:
            track_ids.append(track.id)
    return track_ids
