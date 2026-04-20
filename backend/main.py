"""
FastAPI application - Main entry point.

Configures FastAPI app with CORS, routes, and middleware.
"""

import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_pagination import add_pagination

from backend.api.ai import router as ai_router
from backend.api.app_settings import router as app_settings_router
from backend.api.auth import router as auth_router
from backend.api.bpm import router as bpm_router
from backend.api.folder_config import router as folder_config_router
from backend.api.metadata import router as metadata_router
from backend.api.rulesets import router as rulesets_router
from backend.api.setup import router as setup_router
from backend.api.soundcloud import router as soundcloud_router
from backend.config import get_backend_settings
from backend.core.services import app_settings as app_settings_service
from backend.core.services import cache_db, watcher
from backend.core.services import folder_config as folder_config_service
from backend.core.services import ollama as ollama_service
from backend.core.services.collection import ensure_folder_indexed

# Log to stdout so the Tauri sidecar captures and writes everything to backend.log.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_backend_settings()
    root = Path(app_settings_service.get_root_music_folder()).expanduser()

    # Initialise SQLite cache (creates tables if first run)
    cache_db.init_db(settings.cache_dir / "metadata.db")
    cache_db.prune_missing_files()

    # Start watchdog observer for real-time file change detection
    watcher.start_watcher(root)

    # Kick off initial mtime-comparison scan for each configured folder
    folders_config = folder_config_service.load_folders()
    for fc in folders_config.folders:
        folder = Path(fc.path) if fc.path else root / fc.name
        if folder.is_dir():
            logger.info("Starting index scan for %s", folder)
            ensure_folder_indexed(folder)

    yield

    ollama_service.shutdown()
    watcher.stop_watcher()


def create_app() -> FastAPI:
    """
    Create and configure FastAPI application.

    Returns
    -------
    FastAPI
        Configured application instance
    """
    settings = get_backend_settings()

    app = FastAPI(
        title=settings.api_title,
        version=settings.api_version,
        description=settings.api_description,
        lifespan=lifespan,
    )

    # Configure CORS. Explicitly allow only the Tauri webview origins (across
    # platforms) and the Next.js dev server. Without this, any site the user
    # visits could issue requests to the loopback backend.
    # allow_credentials is False — we use Bearer tokens, never cookies.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(tauri://localhost|https?://tauri\.localhost|http://localhost:\d+)$",
        allow_credentials=False,
        allow_methods=settings.cors_methods,
        allow_headers=settings.cors_headers,
        expose_headers=["X-Cache-Loading"],
    )

    # Register routers
    app.include_router(setup_router)
    app.include_router(auth_router)
    app.include_router(metadata_router)
    app.include_router(rulesets_router)
    app.include_router(folder_config_router)
    app.include_router(app_settings_router)
    app.include_router(ai_router)
    app.include_router(soundcloud_router)
    app.include_router(bpm_router)

    add_pagination(app)

    return app


# Create app instance
app = create_app()


@app.get("/health")
def health_check() -> dict[str, str]:
    """
    Health check endpoint.

    Returns
    -------
    dict
        Status message
    """
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn

    settings = get_backend_settings()
    uvicorn.run(
        "backend.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,  # Always False in production builds
    )
