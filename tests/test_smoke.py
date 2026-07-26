def test_import_backend():
    import backend  # noqa: F401


def test_import_audio():
    import backend.core.audio.folders
    import backend.core.audio.tags
    import backend.core.audio.titles

    assert backend.core.audio.tags.SIMPLE_TAG_FIELDS
    assert backend.core.audio.folders.FILETYPE_MAP
    assert backend.core.audio.titles.rank_artists([], title="", role="artist") == []
