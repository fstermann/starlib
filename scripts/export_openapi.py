"""Export the FastAPI OpenAPI schema to a JSON file.

Usage:
    uv run python scripts/export_openapi.py [output_path]

Writes the OpenAPI JSON spec without starting the server.
"""

import json
import logging
import sys
from pathlib import Path
from unittest.mock import patch

# Patch settings before importing the app so it works without config.env
_defaults = {
    "root_music_folder": "/tmp",
    "cors_origins": '["*"]',
    "api_title": "Starlib",
    "api_version": "0.1.0",
    "api_description": "",
}

with patch.dict("os.environ", _defaults):
    from backend.main import create_app

app = create_app()
schema = app.openapi()

output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("frontend/src/generated/backend-openapi.json")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(schema, indent=2) + "\n")
logging.info("OpenAPI spec written to %s", output)
