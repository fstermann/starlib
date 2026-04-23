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

- **Embedded-webview flow** (desktop app): The Tauri shell opens SoundCloud's authorize URL inside an in-app `WebviewWindow`. The backend's `/auth/soundcloud/redirect` handler completes the code exchange server-side, serves a terminal `/done` page inside the webview, and the frontend fetches the result via `GET /auth/soundcloud/result?state=…`. **On the way out**, the same webview is navigated to `https://soundcloud.com/` so SoundCloud promotes the identity-provider session (on `api-auth.soundcloud.com`) into a main-site session (sets the `oauth_token` cookie on `.soundcloud.com`). The Rust command harvests that cookie and the frontend posts it to `/auth/soundcloud/session-cookie` for persistence. See [Why the cookie is harvested](#why-the-cookie-is-harvested) below.
- **Direct callback flow** (dev/web): SoundCloud redirects directly to the frontend with `code` and `state`. The frontend sends both to `POST /auth/soundcloud/callback`, which exchanges the code server-side. No cookie harvest happens in this mode — the `oauth_token` cookie is scoped to the user's real browser and isn't reachable from our app.

The `return_to` query parameter on `/authorize` controls which flow is used:

- Web dev: `window.location.origin + "/auth/soundcloud/callback"` (e.g. `http://localhost:3000/...`).
- Desktop (Tauri): `http://127.0.0.1:8000/auth/soundcloud/done` — a static "you can close this tab" page served by the backend. The webview lands on it after the code exchange so the Rust command can detect completion and harvest cookies.

### Why the webview rather than the system browser?

An earlier version of this flow used `@tauri-apps/plugin-shell`'s `open()` to launch the authorize URL in the user's real browser, relying on `starlib://` as a deep link back into the app. That worked for OAuth2 tokens but made it **impossible to reach SoundCloud's api-v2 endpoints** (personalized mixes / system playlists) — those require a web-session cookie that is physically in the user's Safari/Chrome cookie jar, which a local backend cannot see.

The embedded webview solves that: it owns its own cookie jar, so the `oauth_token` cookie set by soundcloud.com's web login lands somewhere we can read. A persistent `data_store_identifier` means the user only logs in once — subsequent reconnects reuse the stored session.

### Popups (Google / Apple / Facebook SSO)

Tauri v2 blocks `window.open` by default (upstream change since 2.3; tracked in `tauri-apps/tauri#14263`). SSO providers rely on popups, so without a handler, clicking "Continue with Google" fails silently. The fix is the Rust-side `WebviewWindowBuilder::on_new_window` hook, which returns `NewWindowResponse::Allow` to let the native popup open and inherit the parent's `WKWebsiteDataStore` — so the SSO cookies flow back to the main webview.

```rust
builder.on_new_window(|url, _| {
    log::info!("[sc-login] allow popup: {url}");
    NewWindowResponse::Allow
})
```

### Embedded-webview flow (desktop)

```
Tauri shell      Frontend      Login WebView       Backend             SoundCloud
      │              │                │                 │                    │
      │  Click "Connect"               │                 │                    │
      │              │                                  │                    │
      │              │  GET /authorize?return_to=…/done │                    │
      │              │─────────────────────────────────>│                    │
      │              │  { url, state }                  │                    │
      │              │<─────────────────────────────────│                    │
      │  invoke("open_soundcloud_login", { authUrl })   │                    │
      │<─────────────│                                                       │
      │  open WebviewWindow @ secure.soundcloud.com/authorize?…              │
      │─────────────────────────────────>│                                   │
      │                                  │  user logs in (+SSO popups ok)    │
      │                                  │──────────────────────────────────>│
      │                                  │  consent, redirect to /redirect?code=…
      │                                  │<──────────────────────────────────│
      │                                  │   GET /redirect?code=&state=      │
      │                                  │──────────────────>│               │
      │                                  │                   │ POST /oauth/token (secret+PKCE)
      │                                  │                   │──────────────>│
      │                                  │                   │<──────────────│
      │                                  │  HTML redirect → /done            │
      │                                  │<──────────────────│               │
      │  on_page_load("/done") → oneshot done              │                 │
      │                                  │                                   │
      │  webview.navigate(https://soundcloud.com/)          │                │
      │─────────────────────────────────>│  soundcloud.com promotes IdP     │
      │                                  │   session → sets oauth_token      │
      │                                  │   cookie on .soundcloud.com       │
      │  cookies_for_url("…soundcloud.com") → harvest       │                │
      │  return { oauth_token, completed: true }            │                │
      │─────────────>│                                                       │
      │              │  POST /auth/soundcloud/session-cookie  │              │
      │              │───────────────────────────────────────>│ write OAUTH_TOKEN to config.env
      │              │  GET /result?state=…                   │              │
      │              │───────────────────────────────────────>│              │
      │              │  { access_token, refresh_token, user } │              │
      │              │  store in localStorage                 │              │
```

**Why the backend handles token exchange:** SoundCloud treats all clients as confidential: a `client_secret` is required for every token exchange and refresh. Keeping this in the backend ensures the secret is never exposed to the browser.

**Why the redirect targets the backend, not the frontend:** SoundCloud's dashboard only accepts `http(s)://` redirect URIs, so the registered `redirect_uri` points to `http://127.0.0.1:8000/auth/soundcloud/redirect`. The backend exchanges the code and then serves `/done` — the webview lands there and closes out the Rust side.

### Why the cookie is harvested

SoundCloud's OAuth2 authorize endpoint (`secure.soundcloud.com/authorize`) authenticates the user against an **identity-provider session** scoped to `secure.soundcloud.com` and `api-auth.soundcloud.com`. It does **not** set the `oauth_token` cookie on `.soundcloud.com`, which is what SoundCloud's internal `api-v2.soundcloud.com` requires for personalized-playlist endpoints (Weekly Wave, Daily Drops, Your Mix N).

To materialize that cookie, the Rust command navigates the webview to `https://soundcloud.com/` once the OAuth flow completes. The main web app detects the IdP session and issues its own session, including `oauth_token`. The command polls the cookie store for up to 8 seconds until the cookie appears, then harvests it via `WebviewWindow::cookies_for_url()` (which returns HTTP-only cookies on all platforms).

See [Mixes in `features.md`](../guide/features.md) for the user-facing feature this enables.

## Token storage

OAuth2 tokens live in the frontend's `localStorage`; the web-session cookie lives on disk in the backend-owned config file (for use by the Python sidecar when it calls api-v2).

Frontend `localStorage`:

| Key | Value |
|---|---|
| `access_token` | Bearer token for direct SoundCloud API calls |
| `refresh_token` | Used to obtain a new access token when expired |
| `token_expires_at` | Unix timestamp (ms) when the access token expires |
| `sc_user` | Cached `{ id, username, permalink, avatar_url }` |

Backend `~/…/com.starlib.Starlib/config.env` (0600, owner-only):

| Key | Value |
|---|---|
| `CLIENT_ID` / `CLIENT_SECRET` | App credentials from the SoundCloud developer portal |
| `OAUTH_TOKEN` | Web-session token harvested from the login webview; grants access to api-v2 (Mixes) |

Moving `CLIENT_SECRET` and `OAUTH_TOKEN` into the OS keychain is on the roadmap — today they sit in a 0600 file.

## Token refresh

`ensureValidToken()` in `frontend/src/lib/auth.ts` is called before every SoundCloud API request. If the token is within 60 seconds of expiring (or already expired), it calls `POST /auth/soundcloud/refresh` on the backend, which exchanges it via SoundCloud's `/oauth/token` with `grant_type=refresh_token` + `client_secret`.

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/soundcloud/authorize` | Generate PKCE params + SoundCloud authorization URL |
| `GET` | `/auth/soundcloud/redirect` | Handle SoundCloud OAuth redirect, exchange code, redirect to frontend |
| `GET` | `/auth/soundcloud/done` | Static terminal page the embedded webview lands on after redirect |
| `GET` | `/auth/soundcloud/result` | Retrieve completed OAuth result by state (one-time) |
| `POST` | `/auth/soundcloud/callback` | Exchange authorization code for tokens (direct flow) |
| `POST` | `/auth/soundcloud/session-cookie` | Persist the harvested web-session `oauth_token` (desktop only) |
| `POST` | `/auth/soundcloud/refresh` | Refresh an expired access token |
