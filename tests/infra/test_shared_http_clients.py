"""The shared httpx clients must not leak across event loops.

Both adapters keep one client so connections are reused instead of
re-handshaking per call.  A plain module-level cache is not enough: an
``AsyncClient``'s pooled connections belong to the loop that opened them, so
handing a client from a finished loop to a new one raises "Event loop is
closed".  The cache is therefore keyed on the running loop.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.infra.ai import ollama
from backend.infra.soundcloud import client as sc_client

MODULES = pytest.mark.parametrize("module", [sc_client, ollama], ids=["soundcloud", "ollama"])


@MODULES
def test_same_loop_reuses_one_client(module) -> None:
    async def scenario():
        return module.get_client(), module.get_client()

    first, second = asyncio.run(scenario())
    assert first is second


@MODULES
def test_a_new_loop_gets_a_fresh_client(module) -> None:
    """A client from a closed loop must never be handed out again."""

    async def scenario():
        return module.get_client()

    first = asyncio.run(scenario())
    second = asyncio.run(scenario())

    assert first is not second, "client from a finished loop was reused"


@MODULES
def test_close_client_clears_the_cache(module) -> None:
    async def scenario():
        client = module.get_client()
        await module.close_client()
        return client

    closed = asyncio.run(scenario())
    assert closed.is_closed
    assert module._client is None
    assert module._client_loop is None


@MODULES
def test_close_client_is_safe_when_never_used(module) -> None:
    asyncio.run(module.close_client())
    assert module._client is None
