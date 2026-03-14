# SoundCloud Authentication Guide

This project supports two authentication methods depending on your needs:

## 1. Client Credentials Flow (Read-Only)

**Use for**: Browsing, searching, fetching likes/tracks, exploring collections

**Setup**: Automatic! Just provide `CLIENT_ID` and `CLIENT_SECRET` in `.env`

```bash
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
```

The client will automatically authenticate and get an access token.

**Limitations**: Cannot create playlists, upload tracks, or perform any write operations.

---

## 2. OAuth User Authentication (Read/Write)

**Use for**: Creating playlists, uploading tracks, liking tracks - any write operations

### Step 1: Get User Tokens

Run the authentication helper script:

```bash
poetry run python get_user_tokens.py
```

This will:
1. Open your browser for SoundCloud authorization
2. Ask you to authorize your app
3. Display your access and refresh tokens

### Step 2: Add Tokens to .env

Add the tokens to your `.env` file:

```bash
# User OAuth tokens (for playlist creation)
SOUNDCLOUD_OAUTH_TOKEN=your_access_token_here
SOUNDCLOUD_REFRESH_TOKEN=your_refresh_token_here
```

### Step 3: Restart the App

If you're running Streamlit, restart it:

```bash
./sct app
```

Now playlist creation will work! The app will show "✓ Authenticated with user account" at the top.

---

## Token Lifecycle

- **Access tokens** expire after ~1 hour
- The client **automatically refreshes** them using the refresh token
- **Refresh tokens** are single-use (a new one is issued each time)
- The client handles all of this automatically - you don't need to do anything!

---

## Troubleshooting

### "401 Unauthorized" when creating playlists

- Make sure you've set `SOUNDCLOUD_OAUTH_TOKEN` and `SOUNDCLOUD_REFRESH_TOKEN`
- Try re-running `get_user_tokens.py` to get fresh tokens
- Restart the Streamlit app after updating `.env`

### "Read-only mode" in Streamlit

- The app is using Client Credentials (no refresh token found)
- Follow the OAuth User Authentication steps above
- Make sure your `.env` includes both `SOUNDCLOUD_OAUTH_TOKEN` and `SOUNDCLOUD_REFRESH_TOKEN`

### Tokens not working after a while

- Refresh tokens can expire if not used for a long time
- Re-run `get_user_tokens.py` to get new tokens

---

## GitHub Actions

For automated workflows (like weekly playlists), add the tokens as GitHub Secrets:

1. Get user tokens: `poetry run python get_user_tokens.py`
2. Go to: **Settings** → **Secrets and variables** → **Actions**
3. Add these secrets:
   - `SOUNDCLOUD_CLIENT_ID`
   - `SOUNDCLOUD_CLIENT_SECRET`
   - `SOUNDCLOUD_ACCESS_TOKEN`
   - `SOUNDCLOUD_REFRESH_TOKEN`
   - `SOUNDCLOUD_USER_ID`

The workflow will automatically refresh tokens as needed.
