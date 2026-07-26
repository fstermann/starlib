"""HTTP layer: one aggregated router over every feature's routes.

``main.py`` mounts this single router instead of importing thirteen of them,
so adding a feature means editing one list here rather than the app factory.
"""

from fastapi import APIRouter

from backend.api.ai import router as ai_router
from backend.api.app_settings import router as app_settings_router
from backend.api.bpm import router as bpm_router
from backend.api.folder_config import router as folder_config_router
from backend.api.metadata import router as metadata_router
from backend.api.profile_groups import router as profile_groups_router
from backend.api.rekordbox import router as rekordbox_router
from backend.api.rulesets import router as rulesets_router
from backend.api.setup import router as setup_router
from backend.api.soundcloud.auth import router as auth_router
from backend.api.soundcloud.system_playlists import router as system_playlists_router
from backend.api.soundcloud.tracks import router as soundcloud_router
from backend.api.suggestions import router as suggestions_router

router = APIRouter()

# Registration order is the route-matching order — keep the more specific
# SoundCloud system-playlist routes ahead of the general ones.
for _r in (
    setup_router,
    auth_router,
    metadata_router,
    rulesets_router,
    profile_groups_router,
    folder_config_router,
    app_settings_router,
    ai_router,
    soundcloud_router,
    system_playlists_router,
    bpm_router,
    suggestions_router,
    rekordbox_router,
):
    router.include_router(_r)
