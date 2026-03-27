"""
Entry point for the PyInstaller-frozen backend sidecar.

This module is used as the Analysis entry point in sidecar.spec.
It forces reload=False before importing uvicorn and starts the server.
"""

import os

# Must be set before any settings module is imported.
os.environ.setdefault("BACKEND_RELOAD", "false")
os.environ.setdefault("BACKEND_HOST", "127.0.0.1")
os.environ.setdefault("BACKEND_PORT", "8000")

import uvicorn  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=os.environ["BACKEND_HOST"],
        port=int(os.environ["BACKEND_PORT"]),
        reload=False,
    )
