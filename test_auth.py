#!/usr/bin/env python3
"""Test script to verify SoundCloud API authentication"""

import base64
import sys

import requests

from soundcloud_tools.settings import get_settings


def test_client_credentials():
    """Test authentication with client credentials"""
    settings = get_settings()

    if not settings.client_id or not settings.client_secret:
        print("❌ ERROR: CLIENT_ID and CLIENT_SECRET must be set")
        return False

    print(f"🔑 Using Client ID: {settings.client_id[:20]}...")

    # Encode credentials for Basic auth
    credentials = f"{settings.client_id}:{settings.client_secret}"
    encoded = base64.b64encode(credentials.encode()).decode()

    headers = {
        "accept": "application/json; charset=utf-8",
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": f"Basic {encoded}",
    }

    data = {"grant_type": "client_credentials"}

    print("\n📡 Requesting access token...")
    response = requests.post(
        "https://secure.soundcloud.com/oauth/token",
        headers=headers,
        data=data,
        verify=False,
    )

    print(f"Status: {response.status_code}")

    if response.status_code == 200:
        token_data = response.json()
        access_token = token_data.get("access_token")
        print(f"✅ Authentication successful!")
        print(f"Access token: {access_token[:30]}...")
        print(f"Expires in: {token_data.get('expires_in')} seconds")

        # Test the /me endpoint
        print("\n🧪 Testing /me endpoint...")
        me_response = requests.get(
            "https://api.soundcloud.com/me",
            headers={
                "accept": "application/json; charset=utf-8",
                "Authorization": f"OAuth {access_token}",
            },
            verify=False,
        )

        print(f"Status: {me_response.status_code}")

        if me_response.status_code == 200:
            me_data = me_response.json()
            print(f"✅ /me endpoint works!")
            print(f"Username: {me_data.get('username')}")
            print(f"Full name: {me_data.get('full_name')}")
            return True
        else:
            print(f"❌ /me endpoint failed: {me_response.text}")
            return False

    else:
        print(f"❌ Authentication failed: {response.text}")
        return False


if __name__ == "__main__":
    success = test_client_credentials()
    sys.exit(0 if success else 1)
