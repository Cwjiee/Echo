"""
Groq LLM client wrapper.

Uses the official `groq` Python SDK to call Groq-hosted models
(Llama 3, Mixtral, Gemma, etc.) for fast, free-tier inference.

Required environment variables:
  GROQ_API_KEY  — from https://console.groq.com/keys

Optional:
  GROQ_MODEL    — defaults to "llama-3.3-70b-versatile"
"""

from __future__ import annotations

import asyncio
import logging
import os
from functools import cached_property
from typing import Any

from groq import Groq
from groq.types.chat import (
    ChatCompletion,
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "llama-3.3-70b-versatile"

# Defaults applied to every request (can be overridden via extra_params)
_TEMPERATURE = 0.2   # Low → deterministic, factual output
_MAX_TOKENS = 1024
_TOP_P = 0.9


class GroqClient:
    """Thin async wrapper around the Groq Python SDK."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
    ) -> None:
        self._api_key = api_key or os.environ["GROQ_API_KEY"]
        self._model = model or os.getenv("GROQ_MODEL", _DEFAULT_MODEL)

    @cached_property
    def _sdk(self) -> Groq:
        return Groq(api_key=self._api_key)

    async def chat(
        self,
        system_prompt: str,
        user_prompt: str,
        extra_params: dict[str, Any] | None = None,
    ) -> str:
        """
        Send a chat request to Groq and return the assistant's reply text.

        Runs the synchronous SDK call in a thread-pool executor so it
        doesn't block the asyncio event loop.
        """
        extra = extra_params or {}
        messages: list[ChatCompletionSystemMessageParam | ChatCompletionUserMessageParam] = [
            ChatCompletionSystemMessageParam(role="system", content=system_prompt),
            ChatCompletionUserMessageParam(role="user", content=user_prompt),
        ]

        loop = asyncio.get_running_loop()
        # stream=False is explicit so Pyright resolves the correct overload
        # (ChatCompletion, not Stream[ChatCompletionChunk]).
        response: ChatCompletion = await loop.run_in_executor(
            None,
            lambda: self._sdk.chat.completions.create(
                model=self._model,
                messages=messages,
                stream=False,
                temperature=extra.get("temperature", _TEMPERATURE),
                max_tokens=extra.get("max_tokens", _MAX_TOKENS),
                top_p=extra.get("top_p", _TOP_P),
            ),
        )

        choices = response.choices
        if not choices:
            raise RuntimeError(f"Groq returned no choices: {response}")
        return choices[0].message.content or ""


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_client: GroqClient | None = None


def get_client() -> GroqClient:
    """Return the module-level GroqClient singleton."""
    global _client
    if _client is None:
        _client = GroqClient()
    return _client
