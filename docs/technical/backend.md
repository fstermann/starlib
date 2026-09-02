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

!!! note "Where settings come from"
    In development the backend reads `.env` at the repo root, then `config.env` in the platform user-config directory (`com.starlib.Starlib`). In the packaged desktop app there is no `.env` — the Tauri shell passes the environment to the sidecar, and user config lives in that same directory.

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
├── main.py               # App factory
├── lifespan.py           # Startup/shutdown wiring (cache DB, watcher, initial scan)
├── config.py             # BackendSettings (process/env config)
│
├── api/                  # HTTP layer — routers only; __init__.py aggregates them
│   ├── ai.py             # AI provider config (Ollama / Claude Code / Anthropic)
│   ├── app_settings.py   # Application-level user settings
│   ├── bpm.py            # BPM persistence (analysis runs in the Tauri layer)
│   ├── deps.py           # Dependency injection
│   ├── folder_config.py  # Folder display + per-folder ruleset config
│   ├── profile_groups.py # Profile groups
│   ├── rekordbox.py      # Rekordbox browse source (local DB or USB export)
│   ├── rulesets.py       # Finalization rulesets
│   ├── setup.py          # First-launch setup/config
│   ├── suggestions.py    # Ranked metadata suggestions
│   ├── metadata/         # Metadata editing endpoints
│   │   ├── folders.py    # Library layout, fetch-from-downloads
│   │   ├── browse.py     # Folder tree, paged browsing, filter values
│   │   ├── files.py      # Per-file read/update/batch/readiness/rules/delete
│   │   └── artwork.py · audio.py · collection.py · proxy.py
│   └── soundcloud/       # SoundCloud-facing routes
│       ├── auth.py       # OAuth 2.1 endpoints
│       ├── tracks.py     # Signed HLS stream URLs, likes, playlists
│       └── system_playlists.py  # SoundCloud generated mixes
│
├── domain/               # Pure logic — no I/O, no frameworks
│   ├── tags.py           # ID3 tag registry, StarlibMeta, TrackInfo
│   ├── titles.py         # Title/artist parsing and ranking heuristics
│   ├── filenames.py      # "Artist - Title (Mix)" stem decomposition
│   ├── formatting.py     # List normalisation/aggregation helpers
│   └── suggestions/      # types · engine · registry · suggesters/
│
├── services/             # Use cases — orchestrate domain + infra
│   ├── collection/       # indexing · folders · query
│   ├── metadata.py       # Read/write audio tags
│   ├── rules.py          # Ruleset execution
│   ├── ruleset.py        # Ruleset definition/persistence
│   ├── profile_group.py · folder_config.py · app_settings.py
│   └── rekordbox/        # Rekordbox database + USB export access
│
├── infra/                # Adapters to the outside world
│   ├── db/               # SQLite engine, models, migration runner, alembic/
│   ├── cache.py          # Track/peaks/SC-BPM cache on top of the SQLite layer
│   ├── audio/            # track_handler (mutagen + ffmpeg) · folders
│   ├── soundcloud/       # client · oauth · token_cache · settings
│   ├── ai/               # ollama · anthropic · claude_code
│   ├── settings_store.py # settings.json load/save/migrate
│   ├── keychain.py       # OS keychain access for secrets
│   └── watcher.py        # Filesystem watcher
│
└── schemas/              # Pydantic request/response models (layer-neutral)
```

The package is layered: **`api` → `services` → `domain`**, with **`infra`**
holding the adapters. Dependencies point inward only — `domain/` imports no
framework and no other layer, and `infra/` never reaches back into `services/`
or `api/`. `scripts/check_layering.py` runs in pre-commit and fails the commit
if an import points the wrong way.

`tests/` mirrors the same four directories.

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

### AI providers

- One set of `/api/ai/*` endpoints backed by three interchangeable providers: local [Ollama](https://ollama.com), the Claude Code CLI, and the Anthropic API
- Per-provider settings live under a single `AiSettings` block persisted in `settings.json`; the Anthropic API key goes to the OS credential store via `infra/keychain.py`
- Health check, model listing, and completion per provider
- See the [AI providers user guide](../guide/ai.md) for setup instructions

### Persistence

State that isn't a user-editable config file lives in a SQLite cache database:

- **Engine** (`infra/db/engine.py`) — one module-level SQLAlchemy engine, WAL mode with `synchronous=NORMAL`, pragmas reapplied on every pooled connection
- **Models** (`infra/db/models.py`) — SQLModel tables: `tracks`, `peaks`, `soundcloud_track_bpm`
- **Migrations** (`infra/db/migrations.py` + `infra/db/alembic/`) — Alembic runs `upgrade head` at startup. A DB with tables but no `alembic_version` (pre-#286) is caught up by the legacy bootstrap, backed up, stamped at `0001`, then upgraded.

Adding a schema change means editing the models and generating a revision under `backend/infra/db/alembic/versions/` — never hand-editing the DB.

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
