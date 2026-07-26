# Backend

The backend is a **FastAPI** application that handles SoundCloud authentication, metadata management, and audio file operations.

## Setup

### Environment variables

Configure the backend via a `.env` file in the project root:

```env
# SoundCloud Authentication (OAuth 2.1)
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

Additional settings can be customized with the `BACKEND_` prefix:

```env
BACKEND_HOST=127.0.0.1
BACKEND_PORT=8000
BACKEND_RELOAD=True
```

### Running

```bash
uv run python -m backend.main
```

The API is available at `http://localhost:8000`.

## API documentation

Interactive API documentation is auto-generated:

- **Swagger UI:** [localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc:** [localhost:8000/redoc](http://localhost:8000/redoc)

## Project structure

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

## Key features

### OAuth 2.1 authentication

- Token exchange and refresh handled server-side (keeps `client_secret` secure)
- Automatic token refresh before expiry
- Token caching via `.oauth_cache.json`

### SoundCloud integration

- Track search and collection browsing
- Metadata retrieval and updates
- Artwork management
- Audio file proxying

### Ollama integration

- Connects to a local [Ollama](https://ollama.com) instance for LLM-powered features
- Health check, model listing, and chat completion via `httpx`
- Configurable server URL and model selection, persisted in `settings.json`
- See the [Ollama user guide](../guide/ollama.md) for setup instructions

## Development

### Adding new endpoints

1. **Define schema** in `schemas/` (request/response models)
2. **Put pure logic** in `domain/` (no I/O) and orchestration in `services/`
3. **Put anything that talks to the outside world** in `infra/`
4. **Create route** in `api/` and register it in `api/__init__.py`

### Testing

```bash
uv run python -m pytest tests/ -v
```
