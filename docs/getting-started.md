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
git clone https://github.com/fstermann/soundcloud-tools.git
cd soundcloud-tools
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

## Running tests

```bash
uv run python -m pytest tests/ -v
```
