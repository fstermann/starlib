"""
One-time script to get user OAuth tokens for GitHub Actions.
Run this locally to obtain access_token and refresh_token.
"""

import base64
import hashlib
import os
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import requests
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.getenv("SOUNDCLOUD_CLIENT_ID") or os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("SOUNDCLOUD_CLIENT_SECRET") or os.getenv("CLIENT_SECRET")
REDIRECT_URI = "http://localhost:8080/callback"  # Must match your app settings!

if not CLIENT_ID or not CLIENT_SECRET:
    print("❌ Error: Missing CLIENT_ID or CLIENT_SECRET")
    print("Please set these in your .env file:")
    print("  SOUNDCLOUD_CLIENT_ID=your_client_id")
    print("  SOUNDCLOUD_CLIENT_SECRET=your_client_secret")
    exit(1)

print("=" * 80)
print("SoundCloud OAuth Setup - Step 0: Verify App Settings")
print("=" * 80)
print(f"\n⚠️  IMPORTANT: Before continuing, verify your app settings!\n")
print(f"1. Go to: https://soundcloud.com/you/apps")
print(f"2. Click on your app")
print(f"3. Check 'Redirect URI' field contains: {REDIRECT_URI}")
print(f"4. If not, add it and save")
print(f"\nUsing Client ID: {CLIENT_ID[:15]}...")
print("=" * 80)
input("\nPress ENTER once you've verified the redirect URI is configured...")

# Global variable to store the authorization code
auth_code = None
auth_error = None


class CallbackHandler(BaseHTTPRequestHandler):
    """HTTP handler to catch the OAuth callback"""

    def do_GET(self):
        global auth_code, auth_error

        # Parse the query parameters
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if "code" in params:
            auth_code = params["code"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.end_headers()
            response = """
                <html>
                <head><title>Authorization Successful</title></head>
                <body style="font-family: Arial; padding: 50px; text-align: center;">
                    <h1 style="color: green;">✓ Authorization Successful!</h1>
                    <p>You can close this window and return to your terminal.</p>
                </body>
                </html>
            """
            self.wfile.write(response.encode("utf-8"))
        elif "error" in params:
            auth_error = params["error"][0]
            self.send_response(200)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.end_headers()
            response = f"""
                <html>
                <head><title>Authorization Failed</title></head>
                <body style="font-family: Arial; padding: 50px; text-align: center;">
                    <h1 style="color: red;">✗ Authorization Failed</h1>
                    <p>Error: {auth_error}</p>
                    <p>Please close this window and try again.</p>
                </body>
                </html>
            """
            self.wfile.write(response.encode("utf-8"))
        else:
            self.send_response(400)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.end_headers()
            response = """
                <html>
                <head><title>Invalid Request</title></head>
                <body style="font-family: Arial; padding: 50px; text-align: center;">
                    <h1>Invalid Request</h1>
                    <p>No authorization code found.</p>
                </body>
                </html>
            """
            self.wfile.write(response.encode("utf-8"))

    def log_message(self, format, *args):
        # Suppress server logs
        pass


# Generate PKCE code verifier and challenge
code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("utf-8").rstrip("=")
code_challenge = (
    base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("utf-8")).digest()).decode("utf-8").rstrip("=")
)

# Step 1: Authorization URL
auth_params = {
    "client_id": CLIENT_ID,
    "redirect_uri": REDIRECT_URI,
    "response_type": "code",
    "code_challenge": code_challenge,
    "code_challenge_method": "S256",
    "state": secrets.token_urlsafe(16),
    # Don't request specific scope - let SoundCloud use default scopes
}

auth_url = f"https://secure.soundcloud.com/authorize?{urlencode(auth_params)}"

print("=" * 80)
print("STEP 1: Authorize your application")
print("=" * 80)
print("\n🚀 Starting local callback server on http://localhost:8080...")

# Start local server in background
server = HTTPServer(("localhost", 8080), CallbackHandler)
server_thread = threading.Thread(target=server.handle_request)
server_thread.daemon = True
server_thread.start()

print("✓ Server started!")
print(f"\n📱 Opening browser for authorization...")
print(f"\nIf browser doesn't open automatically, visit:\n{auth_url}\n")

# Open browser automatically
webbrowser.open(auth_url)

print("⏳ Waiting for you to authorize the app...")
print("(This will open in your browser - click 'Connect' to authorize)")
print("=" * 80)

# Wait for the callback
server_thread.join(timeout=120)  # Wait up to 2 minutes

if auth_error:
    print(f"\n❌ Authorization failed: {auth_error}")
    exit(1)

if not auth_code:
    print("\n❌ Timeout: No authorization code received within 2 minutes.")
    print("\nPlease try again. If you closed the browser window, restart the script.")
    exit(1)

code = auth_code
print(f"\n✓ Authorization code received: {code[:20]}...")

print("\n🔄 Exchanging authorization code for tokens...")

# Step 2: Exchange code for tokens
token_data = {
    "grant_type": "authorization_code",
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "redirect_uri": REDIRECT_URI,
    "code_verifier": code_verifier,
    "code": code,
}

response = requests.post(
    "https://secure.soundcloud.com/oauth/token", data=token_data, headers={"accept": "application/json; charset=utf-8"}
)

if response.status_code == 200:
    tokens = response.json()
    print("\n" + "=" * 80)
    print("SUCCESS! Your tokens:")
    print("=" * 80)
    print(f"\nAccess Token: {tokens['access_token']}")
    print(f"\nRefresh Token: {tokens['refresh_token']}")
    print(f"\nExpires In: {tokens.get('expires_in', 'N/A')} seconds")
    print(f"Scope: {tokens.get('scope', 'N/A')}")

    print("\n" + "=" * 80)
    print("STEP 2: Add these to GitHub Secrets")
    print("=" * 80)
    print("\n1. Go to your repo: Settings > Secrets and variables > Actions")
    print("2. Add these secrets:\n")
    print(f"   SOUNDCLOUD_ACCESS_TOKEN = {tokens['access_token']}")
    print(f"   SOUNDCLOUD_REFRESH_TOKEN = {tokens['refresh_token']}")
    print("\n3. Also add your existing secrets:")
    print(f"   SOUNDCLOUD_CLIENT_ID = {CLIENT_ID}")
    print(f"   SOUNDCLOUD_CLIENT_SECRET = {CLIENT_SECRET}")
    print("=" * 80)
else:
    print(f"\nError: {response.status_code}")
    print(response.text)
