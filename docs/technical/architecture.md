# Architecture

Starlib is structured as three independent components: a Python backend, a React frontend, and an optional Tauri desktop shell that bundles both into a native application.

## Overview

```
Development
───────────
┌──────────┐  :3000   ┌───────────────┐  :8000   ┌────────────┐
│  Browser ├─────────►│ Next.js (dev) ├─────────►│  FastAPI   │
│          │◄─────────┤               │◄─────────┤  Backend   ├──► SoundCloud API
└──────────┘          └───────────────┘          └────────────┘
Desktop (Tauri)
───────────────
┌───────────────────────────────────────────────────┐
│  Tauri Shell                                      │
│                                                   │
│  ┌─────────────────────┐  HTTP  ┌───────────────┐ │
│  │  Webview            ├───────►│  Sidecar      │ │
│  │  (frontend/out/)    │◄───────┤  (FastAPI)    ├─┼──► SoundCloud API
│  │                     │ :8000  │  PyInstaller  │ │
│  └─────────────────────┘        └───────────────┘ │
│                                                   │
└───────────────────────────────────────────────────┘
```

## Backend (`backend/`)

The backend is a **FastAPI** application responsible for:

- SoundCloud OAuth 2.1 token exchange and refresh (keeps `client_secret` server-side)
- Proxying SoundCloud API requests
- Metadata editing and track management
- Audio file handling and caching

```
backend/
├── api/           # Route handlers
│   ├── auth.py    # OAuth endpoints
│   ├── deps.py    # Dependency injection
│   └── metadata/  # Metadata editing routes
├── core/          # Business logic
│   └── services/  # Domain services
├── schemas/       # Pydantic request/response models
├── config.py      # Settings (env vars)
└── main.py        # Application entry point
```

## Frontend (`frontend/`)

The frontend is a **Next.js / React** application built with TypeScript and shadcn/ui components. It communicates with the backend over HTTP.

```
frontend/src/
├── app/           # Next.js app router pages
│   ├── auth/      # OAuth callback handling
│   ├── meta-editor/ # Track metadata editor
│   └── setup/     # Initial setup flow
├── components/    # Reusable UI components
├── generated/     # Auto-generated SoundCloud API types
└── lib/           # Utilities and helpers
```

## Desktop (`desktop/`)

The desktop app uses **Tauri v2** to wrap the frontend and backend into a native application:

- A **webview** loads the statically-exported Next.js frontend
- A **sidecar** binary (PyInstaller-frozen FastAPI) runs the backend
- The sidecar binds to `127.0.0.1:8000` (localhost only) and is managed by the Tauri lifecycle

## Authentication flow

The app uses **OAuth 2.1 + PKCE** (Authorization Code Flow). The backend holds the `client_secret` and is the only party that exchanges or refreshes tokens with SoundCloud.

```
Browser → Frontend → Backend → SoundCloud
                        ↓
                  Token exchange
                  (client_secret + PKCE)
                        ↓
                  Returns tokens to frontend
                  (stored in localStorage)
```

See the [Backend](backend.md) page for details on available endpoints.
