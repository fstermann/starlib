import streamlit as st

from soundcloud_tools.client import Client
from soundcloud_tools.streamlit.token_store import read_tokens


class StreamlitClient(Client):
    def _make_request(self, *arg, **kwargs):
        return self.make_request(*arg, **kwargs)

    def apply_tokens(self, access_token: str, refresh_token: str) -> None:
        """Apply new OAuth tokens to this client instance."""
        self._access_token = access_token
        self._refresh_token = refresh_token
        self._token_type = "OAuth"
        self.headers["Authorization"] = f"OAuth {access_token}"

    def load_from_token_file(self) -> bool:
        """
        Load tokens from the persistent token file if available.
        Returns True if tokens were successfully loaded.
        """
        tokens = read_tokens()
        if tokens:
            self.apply_tokens(tokens["access_token"], tokens.get("refresh_token", ""))
            return True
        return False


@st.cache_resource
def get_client() -> StreamlitClient:
    client = StreamlitClient()
    # If no user OAuth token came from env vars, try the token file.
    # This ensures tokens survive app restarts.
    if not client._refresh_token:
        client.load_from_token_file()
    return client
