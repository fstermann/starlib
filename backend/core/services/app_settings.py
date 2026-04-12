"""Application-level settings facade over the consolidated settings file."""

from backend.core.services import settings as settings_service


def load() -> dict:
    """Return application settings as a plain dict."""
    return settings_service.load().app.model_dump()


def save(settings: dict) -> dict:
    """Persist application settings (partial merge over existing values)."""
    current = settings_service.load()
    merged = {**current.app.model_dump(), **settings}
    current.app = current.app.model_copy(update=merged)
    settings_service.save(current)
    return current.app.model_dump()


def get_preferred_output_format() -> str:
    return settings_service.load().app.preferred_output_format


def get_root_music_folder() -> str:
    return settings_service.load().app.root_music_folder


def set_root_music_folder(path: str) -> None:
    def _mutate(s):
        s.app.root_music_folder = path

    settings_service.update(_mutate)
