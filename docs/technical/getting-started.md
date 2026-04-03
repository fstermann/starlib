# Getting Started

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Python | 3.13+ | [python.org](https://www.python.org/) |
| uv | latest | `pip install uv` |
| Node.js | ≥ 22 | `brew install node` |

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/fstermann/starlib.git
cd starlib
```

### Backend

```bash
uv sync
```

### Frontend

```bash
cd frontend
npm install
```

## Configuration

Create a `.env` file in the project root with your SoundCloud credentials:

```env
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

**How to get credentials:**

1. Register your app at the [SoundCloud Developer Portal](https://soundcloud.com/you/apps)
2. Copy `CLIENT_ID` and `CLIENT_SECRET` from your app settings
3. Add them to the `.env` file

## Running the application

Start both services:

```bash
# Terminal 1 – Backend
uv run python -m backend.main
```

```bash
# Terminal 2 – Frontend
cd frontend && npm run dev
```

The backend API is available at `http://localhost:8000` and the frontend at `http://localhost:3000`.

### API documentation

Once the backend is running, interactive API docs are available at:

- **Swagger UI:** [localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc:** [localhost:8000/redoc](http://localhost:8000/redoc)

## CLI

Starlib ships a `starlib` command for common dev tasks.

### Installation

Install it once as a global uv tool so it's available in every shell:

```bash
uv tool install --editable .
uv tool update-shell   # adds ~/.local/bin to PATH (restart shell after)
```

After restarting your shell, `starlib` is available globally.

### Commands

| Command | Description |
|---------|-------------|
| `starlib screenshot` | Capture all documentation screenshots |

#### `starlib screenshot`

Fetches fresh track metadata from the iTunes Search API, then runs the Playwright screenshot suite (`screenshots.spec.ts`) and writes PNGs to `docs/assets/images/screenshots/`. The track cache is stored in `.cache/screenshot-tracks.json`.

```bash
starlib screenshot
```

Make sure the frontend dev server is running (`cd frontend && npm run dev`) before capturing screenshots, or let Playwright start it automatically via `reuseExistingServer`.

## Running tests

```bash
uv run python -m pytest tests/ -v
```
