"""SoundCloud-facing routes: OAuth, track streaming/likes, playlists.

Grouped here because they share the SoundCloud credentials and token handling;
``auth`` keeps its own ``/auth/soundcloud`` prefix rather than living under
``/api``, since the OAuth redirect target is a fixed public URL.
"""
