"""Rank tracks by how many playlists they share with a seed track."""

from collections.abc import Iterable


def rank_by_playlist_occurrence(
    playlists: Iterable[Iterable[int]],
    *,
    exclude: int,
    limit: int,
) -> list[tuple[int, int]]:
    """Rank track ids by the number of playlists that contain them.

    A track counts once per playlist, however often it repeats there. Ties keep
    first-seen order, so earlier playlists (SoundCloud's own ranking) win.

    Args:
        playlists: Track ids of each playlist.
        exclude: Seed track id, left out of the ranking.
        limit: Maximum number of ranked tracks to return.

    Returns:
        ``(track_id, playlist_count)`` pairs, highest count first.
    """
    # dicts keep insertion order, which gives the first-seen tiebreak for free.
    counts: dict[int, int] = {}
    for track_ids in playlists:
        for track_id in dict.fromkeys(track_ids):
            if track_id != exclude:
                counts[track_id] = counts.get(track_id, 0) + 1
    # sorted() is stable, so equal counts stay in first-seen order.
    return sorted(counts.items(), key=lambda item: -item[1])[:limit]
