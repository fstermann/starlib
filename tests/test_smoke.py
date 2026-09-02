def test_import_backend():
    import backend  # noqa: F401


def test_import_audio():
    import backend.domain.tags
    import backend.domain.titles
    import backend.infra.audio.folders

    assert backend.domain.tags.SIMPLE_TAG_FIELDS
    assert backend.infra.audio.folders.FILETYPE_MAP
    assert backend.domain.titles.rank_artists([], title="", role="artist") == []
