"""
FastAPI application - Main entry point.

Configures FastAPI app with CORS, routes, and middleware.
"""

import logging
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi_pagination import add_pagination

from backend.api import router as api_router
from backend.config import get_backend_settings
from backend.lifespan import lifespan

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)

logger = logging.getLogger(__name__)


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

    app.include_router(api_router)

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
