# Starlib ⭐

This repository provides a collection of tools to interact with the SoundCloud API.

## 🏗️ Architecture

- **Backend API** (`backend/`) - FastAPI server with OAuth 2.1, metadata management, file handling
- **Frontend** (`frontend/`) - Next.js/React application with modern UI components
- **Legacy Tools** (`soundcloud_tools/`) - Original Python CLI tools (being migrated to backend/frontend)

### Quick Start

**Backend:**
```bash
uv run python -m backend.main
# → http://localhost:8000
```

**Frontend:**
```bash
cd frontend && npm run dev
# → http://localhost:3000
```

See [Backend README](backend/README.md) for detailed setup.

## Authentication

The app uses **OAuth 2.1 + PKCE** (Authorization Code Flow) to authenticate with SoundCloud. The flow is split between frontend and backend — the backend holds the `client_secret` and is the only party that ever exchanges or refreshes tokens with SoundCloud.

### Login flow

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

### Token storage (frontend `localStorage`)

| Key | Value |
|---|---|
| `access_token` | Bearer token for direct SoundCloud API calls |
| `refresh_token` | Used to obtain a new access token when expired |
| `token_expires_at` | Unix timestamp (ms) when the access token expires |
| `sc_user` | Cached `{ id, username, permalink, avatar_url }` |

### Token refresh

`ensureValidToken()` in `frontend/src/lib/auth.ts` is called before every SoundCloud API request. If the token is within 60 seconds of expiring (or already expired), it calls `POST /auth/soundcloud/refresh` on the backend, which in turn calls SoundCloud's `/oauth/token` with `grant_type=refresh_token` + `client_secret`.

### Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/soundcloud/authorize` | Generate PKCE params + SC authorization URL |
| `POST` | `/auth/soundcloud/callback` | Exchange authorization code for tokens |
| `POST` | `/auth/soundcloud/refresh` | Refresh an expired access token |

---


This includes a __workflow__ to collect all __liked, posted and reposted tracks__ and playlists of a users __favorited artists__ for the past week.

The worlkflow is meant to be run weekly, and will store the tracks and playlists in a new playlist on the users SoundCloud account.

---

Another tool is the __MetaEditor__, which allows you to edit the metadata of your local tracks, including the artwork. The editor offers an integrated Soundcloud search to find the correct metadata for your tracks.

## Installation

```bash
pip install uv
uv sync --group editor
```

If `ffmpeg` is not installed on your system, you can install it via Homebrew by running:

```bash
brew install ffmpeg
```

### `starlib` Script

The `starlib` script contains shortcuts to the tools provided in this repository.
For easier access to the commands, add the following to your `.bashrc` or `.zshrc`. Otherwise, _all following commands have to be prefixed with `./`_:

```bash
alias starlib="./starlib"
```

Execute the following command to make the script executable:

```bash
chmod +x starlib
```

#### Commands

```bash
starlib app # Run the Streamlit application
starlib weekly # Run the weekly workflow
```

## Settings

A set of environment variables are required and have to be set in a `.env` file in the root directory of the project.
You can find a blank [`.env.example`](./.env.example) file that you can copy (`cp .env.example .env`) and fill in the required values.

Similarly, if you want to use the GitHub workflow, you have to add the environment variables as secrets in the repository settings.


<details>
<summary>Authentication Setup (OAuth 2.1 - RECOMMENDED)</summary>

**New in 2026**: Automatic OAuth 2.1 authentication with token refresh!

### Quick Setup (5 minutes)

1. **Register your app** at [SoundCloud Developer Portal](https://soundcloud.com/you/apps)
2. **Get your credentials**: Copy `CLIENT_ID` and `CLIENT_SECRET` from your app settings
3. **Add to `.env`**:
   ```env
   CLIENT_ID=your_client_id_here
   CLIENT_SECRET=your_client_secret_here
   USER_ID=your_soundcloud_user_id
   ```

That's it! The application will:
- ✅ Automatically obtain OAuth tokens
- ✅ Refresh tokens before expiry
- ✅ Cache tokens locally (`.oauth_cache.json`)
- ✅ No manual token extraction needed

### Migration from Manual Tokens

If you previously used manual `OAUTH_TOKEN` extraction, you can now switch to automatic OAuth:

1. Follow the Quick Setup above
2. Comment out or remove old `OAUTH_TOKEN` and `DATADOME_CLIENTID` variables
3. The app will automatically switch to OAuth 2.1 flow

**Legacy method** (manual token extraction) is still supported but deprecated.

</details>

<details>
<summary>Legacy Authentication (Manual Token Extraction - DEPRECATED)</summary>

**⚠️ This method is deprecated. Use OAuth 2.1 setup above instead.**

To get the first three variables, visit your SoundCloud profile, open up the developer tools menu, reload the page and search for `tracks?representation` in the network tab. The `USER_ID` and `CLIENT_ID` can be found in the request url, and the `OAUTH_TOKEN` in the request headers.

![Network Tab](assets/network-1.png)
![Network Tab](assets/network-2.png)


The `DATADOME_CLIENTID` and `SC_A_ID` can be found similarly by creating a new playlist, and extracting that value from the request that is made in the network tab (`POST` to the `/playlists` endpoint).

</details>

## Tools

The following section describes the tools provided in this repository.
An interface for the tools can be started by running the following command:

```bash
uv run streamlit run soundcloud_tools/streamlit/app.py   
```

### MetaEditor

You can use the MetaEditor to edit the metadata of your local tracks.
It uses the `mutagen` library to edit the metadata of the tracks.
The editor offers an integrated Soundcloud search to find the correct metadata, including artwork, for your tracks.

Note that to optimize the workflow, the MetaEditor uses three folders to store the tracks:

- `root_folder/prepared`: This is the folder where you should store the tracks that you want to edit the metadata of.
- `root_folder/cleaned`: This is the folder where the MP3 tracks with the edited metadata will be stored.
- `root_folder/archive`: This is the folder where the original tracks will be stored after finishing the editing process. If the tracks are already in MP3 format, they will only be copied to the `cleaned` folder.

---

![Meta Editor](assets/meta-editor-dark.png)

<details>
<summary>Light Mode</summary>

![Meta Editor](assets/meta-editor-light.png)

</details>

### Favorite Archiver

```bash
poetry run soundcloud_tools
```

__Options__

- `--week`: The week number relative to the current week. For example, `--week=0` will download the tracks from the current week, `--week=-1` will download the tracks from the previous week, and so on.


In order to setup the workflow, simply add the environment variables as secrets in the GitHub repository settings. By default the workflow will run every Sunday at 08:00 AM, but this can be changed in the [`.github/workflows/run.yml`](.github/workflows/run.yml) file.
