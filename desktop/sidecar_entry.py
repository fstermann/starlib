"""
Entry point for the PyInstaller-frozen backend sidecar.

This module is used as the Analysis entry point in sidecar.spec.
It forces reload=False before importing uvicorn and starts the server.
"""

import os
import sys
import threading

# Must be set before any settings module is imported.
os.environ.setdefault("BACKEND_RELOAD", "false")
os.environ.setdefault("BACKEND_HOST", "127.0.0.1")
os.environ.setdefault("BACKEND_PORT", "8000")

import uvicorn


def _watch_stdin():
    """Exit when stdin is closed (parent process died)."""
    try:
        sys.stdin.read()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    threading.Thread(target=_watch_stdin, daemon=True).start()
    uvicorn.run(
        "backend.main:app",
        host=os.environ["BACKEND_HOST"],
        port=int(os.environ["BACKEND_PORT"]),
        reload=False,
    )
