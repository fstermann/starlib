# Authentication

Starlib uses **OAuth 2.1 + PKCE** (Authorization Code Flow) to authenticate with SoundCloud. The flow is split between frontend and backend — the backend holds the `client_secret` and is the only party that exchanges or refreshes tokens with SoundCloud.

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

```
Browser                  Frontend               Backend                  SoundCloud
  │                          │                      │                         │
  │  Click "Connect"         │                      │                         │
  │─────────────────────────>│                      │                         │
  │                          │  GET /auth/soundcloud/authorize                │
  │                          │─────────────────────>│                         │
  │                          │  { url, state,        │                         │
  │                          │    code_verifier }   │                         │
  │                          │<─────────────────────│                         │
  │                          │  store state +        │                         │
  │                          │  code_verifier in     │                         │
  │                          │  sessionStorage       │                         │
  │  redirect to SC          │                      │                         │
  │<─────────────────────────│                      │                         │
  │─────────────────────────────────────────────────────────────────────────>│
  │  authorize + redirect back with ?code=…&state=… │                         │
  │<─────────────────────────────────────────────────────────────────────────│
  │  /auth/soundcloud/callback?code=…&state=…        │                         │
  │─────────────────────────>│                      │                         │
  │                          │  verify state        │                         │
  │                          │  POST /auth/soundcloud/callback                │
  │                          │  { code, state,       │                         │
  │                          │    code_verifier }   │                         │
  │                          │─────────────────────>│                         │
  │                          │                      │  POST /oauth/token      │
  │                          │                      │  (client_secret + PKCE) │
  │                          │                      │────────────────────────>│
  │                          │                      │  { access_token,        │
  │                          │                      │    refresh_token,        │
  │                          │                      │    expires_in }         │
  │                          │                      │<────────────────────────│
  │                          │  { access_token,      │                         │
  │                          │    refresh_token,     │                         │
  │                          │    expires_in, user } │                         │
  │                          │<─────────────────────│                         │
  │                          │  store tokens in      │                         │
  │                          │  localStorage         │                         │
```

**Why the backend handles token exchange:** SoundCloud treats all clients as confidential — a `client_secret` is required for every token exchange and refresh. Keeping this in the backend ensures the secret is never exposed to the browser.

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
| `POST` | `/auth/soundcloud/callback` | Exchange authorization code for tokens |
| `POST` | `/auth/soundcloud/refresh` | Refresh an expired access token |
