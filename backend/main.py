"""
FastAPI application - Main entry point.

Configures FastAPI app with CORS, routes, and middleware.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.metadata import router as metadata_router
from backend.config import get_backend_settings


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
    )

    # Configure CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=settings.cors_credentials,
        allow_methods=settings.cors_methods,
        allow_headers=settings.cors_headers,
    )

    # Register routers
    app.include_router(metadata_router)

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
