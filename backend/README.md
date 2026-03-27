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
├── api/           # FastAPI route handlers
│   ├── deps.py    # Dependency injection (SoundCloud client, etc.)
│   └── metadata.py # Metadata editing endpoints
├── core/          # Business logic (no framework deps)
│   └── services/  # Domain services
│       ├── metadata.py    # Metadata operations
│       └── soundcloud.py  # SoundCloud API wrapper
├── schemas/       # Pydantic models for API
├── config.py      # Backend configuration
└── main.py        # FastAPI application entry point
```

## Key Features

### OAuth 2.1 Authentication
- Automatically handled by `soundcloud_tools.client.Client`
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
2. **Implement service** in `core/services/` (pure business logic)
3. **Create route** in `api/` (HTTP handling)
4. **Register router** in `main.py`

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
