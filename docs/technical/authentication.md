# Authentication

Starlib uses **OAuth 2.1 + PKCE** (Authorization Code Flow) to authenticate with SoundCloud. The flow is split between frontend and backend; the backend holds the `client_secret` and is the only party that exchanges or refreshes tokens with SoundCloud.

## Setup

1. Register your app at the [SoundCloud Developer Portal](https://soundcloud.com/you/apps)
2. Copy `CLIENT_ID` and `CLIENT_SECRET` from your app settings
3. Add them to a `.env` file in the project root:

```env
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
USER_ID=your_soundcloud_user_id
```

The application will automatically obtain, cache, and refresh OAuth tokens.

## Login flow

The OAuth flow supports two modes depending on the environment:

- **Backend-redirect flow** (desktop app): SoundCloud redirects to the backend (`/auth/soundcloud/redirect`), which exchanges the code server-side and redirects the browser to the frontend callback with only the `state` parameter. The frontend then fetches the result via `GET /auth/soundcloud/result?state=…`.
- **Direct callback flow** (dev/web): SoundCloud redirects directly to the frontend with `code` and `state`. The frontend sends both to `POST /auth/soundcloud/callback`, which exchanges the code server-side.

The `return_to` query parameter on `/authorize` controls which flow is used:

- Web dev: `window.location.origin + "/auth/soundcloud/callback"` (e.g. `http://localhost:3000/...`).
- Desktop (Tauri): `starlib://localhost/auth/soundcloud/callback`. The app registers `starlib://` as a custom URL scheme and opens the SoundCloud authorization URL in the **system browser** via `@tauri-apps/plugin-shell`. This is what makes "Log in with Google" (and similar popup-based providers) work — popups fail inside the Tauri webview but work fine in a real browser. After the backend exchanges the code, it redirects the browser to `starlib://…`; the OS hands the URL back to the app, `tauri-plugin-deep-link` emits it, and a global listener routes to the frontend callback page.

### Backend-redirect flow (default)

```
Browser                  Frontend               Backend                  SoundCloud
  │                          │                      │                         │
  │  Click "Connect"         │                      │                         │
  │─────────────────────────>│                      │                         │
  │                          │  GET /authorize       │                         │
  │                          │  ?return_to=…/callback│                         │
  │                          │─────────────────────>│                         │
  │                          │  { url, state }      │  (stores code_verifier  │
  │                          │<─────────────────────│   + return_to by state) │
  │                          │  store state in       │                         │
  │                          │  sessionStorage       │                         │
  │  redirect to SC          │                      │                         │
  │<─────────────────────────│                      │                         │
  │─────────────────────────────────────────────────────────────────────────>│
  │  authorize               │                      │                         │
  │<─────────────────────────────────────────────────────────────────────────│
  │  redirect to /auth/soundcloud/redirect?code=…&state=…                    │
  │──────────────────────────────────────────────>│                         │
  │                          │                      │  POST /oauth/token      │
  │                          │                      │  (client_secret + PKCE) │
  │                          │                      │────────────────────────>│
  │                          │                      │  { access_token, … }   │
  │                          │                      │<────────────────────────│
  │  redirect to return_to?state=…                 │                         │
  │<─────────────────────────────────────────────────│                         │
  │  /callback?state=…       │                      │                         │
  │─────────────────────────>│                      │                         │
  │                          │  GET /result?state=…  │                         │
  │                          │─────────────────────>│                         │
  │                          │  { access_token,      │                         │
  │                          │    refresh_token,     │                         │
  │                          │    expires_in, user } │                         │
  │                          │<─────────────────────│                         │
  │                          │  store tokens in      │                         │
  │                          │  localStorage         │                         │
```

**Why the backend handles token exchange:** SoundCloud treats all clients as confidential: a `client_secret` is required for every token exchange and refresh. Keeping this in the backend ensures the secret is never exposed to the browser.

**Why the backend-redirect flow exists:** In the desktop app (Tauri), SoundCloud cannot redirect to `tauri://` or `starlib://` URLs directly (its dashboard only accepts `http(s)://` redirect URIs). Instead, the registered `redirect_uri` points to the backend, which exchanges the code and then redirects the browser to `return_to` — which for the desktop app is the `starlib://` deep link that re-enters the app.

## Token storage

Tokens are stored in the frontend's `localStorage`:

| Key | Value |
|---|---|
| `access_token` | Bearer token for direct SoundCloud API calls |
| `refresh_token` | Used to obtain a new access token when expired |
| `token_expires_at` | Unix timestamp (ms) when the access token expires |
| `sc_user` | Cached `{ id, username, permalink, avatar_url }` |

## Token refresh

`ensureValidToken()` in `frontend/src/lib/auth.ts` is called before every SoundCloud API request. If the token is within 60 seconds of expiring (or already expired), it calls `POST /auth/soundcloud/refresh` on the backend, which exchanges it via SoundCloud's `/oauth/token` with `grant_type=refresh_token` + `client_secret`.

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/soundcloud/authorize` | Generate PKCE params + SoundCloud authorization URL |
| `GET` | `/auth/soundcloud/redirect` | Handle SoundCloud OAuth redirect, exchange code, redirect to frontend |
| `GET` | `/auth/soundcloud/result` | Retrieve completed OAuth result by state (one-time) |
| `POST` | `/auth/soundcloud/callback` | Exchange authorization code for tokens (direct flow) |
| `POST` | `/auth/soundcloud/refresh` | Refresh an expired access token |
