# Backend API

FastAPI backend for Starlib music management application.

## Setup

### 1. Environment Configuration

The backend uses OAuth 2.1 for SoundCloud API authentication. Configure in the root `.env` file:

```env
# SoundCloud Authentication (OAuth 2.1)
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

**How to get credentials:**
1. Register your app at [SoundCloud Developer Portal](https://soundcloud.com/you/apps)
2. Copy `CLIENT_ID` and `CLIENT_SECRET` from your app settings
3. Add to `.env` file

**Authentication features:**
- ✅ Automatic OAuth token management
- ✅ Auto-refresh before expiry
- ✅ Token caching (`.oauth_cache.json`)
- ✅ No manual token extraction needed

### 2. Start the Backend

```bash
# From project root
uv run python -m backend.main
```

The API will be available at `http://localhost:8000`

### 3. API Documentation

Once running, visit:
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Architecture

```
backend/
├── main.py        # app factory
├── lifespan.py    # startup/shutdown wiring
├── config.py      # BackendSettings (process/env config)
│
├── api/           # HTTP layer — routers only, one aggregated router in __init__.py
│   ├── deps.py
│   ├── metadata/  # folders, browse, files, artwork, audio, collection, proxy
│   └── soundcloud/# auth, tracks, system_playlists
│
├── domain/        # pure logic — no I/O, no frameworks (enforced in pre-commit)
│   ├── tags.py    # tag registry + TrackInfo
│   ├── titles.py  filenames.py  formatting.py
│   └── suggestions/  # types, engine, registry, suggesters/
│
├── services/      # use cases — orchestrate domain + infra
│   ├── collection/# indexing, folders, query
│   ├── metadata.py  rules.py  ruleset.py  profile_group.py
│   ├── folder_config.py  app_settings.py
│   └── rekordbox/
│
├── infra/         # adapters to the outside world
│   ├── db/        # engine, models, migrations, alembic/
│   ├── cache.py   # SQLite derived-data cache
│   ├── audio/     # track_handler (mutagen + ffmpeg), folders
│   ├── soundcloud/# client, oauth, token_cache, settings
│   ├── ai/        # anthropic, claude_code, ollama
│   ├── settings_store.py  keychain.py  watcher.py
│
└── schemas/       # Pydantic contracts, layer-neutral
```

Dependencies point inward: `api -> services -> domain`, with `infra` holding the
adapters. `scripts/check_layering.py` fails the commit if an import points the
other way.

## Key Features

### OAuth 2.1 Authentication
- Automatically handled by `backend.infra.soundcloud.oauth.OAuthManager`
- Token refresh managed transparently
- Falls back to manual `OAUTH_TOKEN` if OAuth credentials not available

### SoundCloud Integration
- Track search
- Metadata retrieval and update
- Artwork management
- Track finalization and export

## Development

### Adding New Endpoints

1. **Define schema** in `schemas/` (request/response models)
2. **Put pure logic** in `domain/` (no I/O) and orchestration in `services/`
3. **Put anything that talks to the outside world** in `infra/`
4. **Create route** in `api/` and register it in `api/__init__.py`

### Testing

```bash
# Test OAuth authentication
uv run python test_oauth.py

# Run backend
uv run python -m backend.main
```

## Configuration

Backend settings can be customized via environment variables with `BACKEND_` prefix:

```env
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000
BACKEND_RELOAD=True
```

See `backend/config.py` for all available options.
