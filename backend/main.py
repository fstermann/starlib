"""
FastAPI application - Main entry point.

Configures FastAPI app with CORS, routes, and middleware.
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_pagination import add_pagination

from backend.api.auth import router as auth_router
from backend.api.metadata import router as metadata_router
from backend.config import get_backend_settings
from backend.core.services import cache_db, watcher
from backend.core.services.collection import ensure_folder_indexed

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s: %(name)s: %(message)s",
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_backend_settings()
    root = Path(settings.root_music_folder).expanduser()

    # Initialise SQLite cache (creates tables if first run)
    cache_db.init_db(settings.cache_dir / "metadata.db")

    # Start watchdog observer for real-time file change detection
    watcher.start_watcher(root)

    # Kick off initial mtime-comparison scan for each folder
    for sub in ("collection", "prepare", "cleaned"):
        folder = root / sub
        if folder.is_dir():
            logger.info("Starting index scan for %s", folder)
            ensure_folder_indexed(folder)

    yield

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

    # Configure CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_credentials,
        allow_methods=settings.cors_methods,
        allow_headers=settings.cors_headers,
        expose_headers=["X-Cache-Loading"],
    )

    # Register routers
    app.include_router(auth_router)
    app.include_router(metadata_router)

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
        reload=settings.reload,
    )
