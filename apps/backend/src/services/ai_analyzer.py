"""
Cloud AI Analyzer service.

Responsibilities:
  - Parsing GitHub event payloads (push, pull_request, release, etc.)
  - Extracting diffs / commit messages
  - Calling an LLM (e.g. Gemini / OpenAI) to produce a structured summary
  - Returning a resolution payload for downstream consumers

TODO: Integrate real LLM SDK calls.
"""

from __future__ import annotations

import textwrap
from typing import Any


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def analyze_payload(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Main entry point called by the webhook route.

    Returns a structured summary dict that is broadcast to connected clients.
    """
    extractor = _EXTRACTORS.get(event_type, _generic_extractor)
    context = extractor(payload)
    summary_text = await _call_llm(context)

    return {
        "event_type": event_type,
        "summary": summary_text,
        "context": context,
        "resolution_actions": _derive_actions(event_type, payload),
    }


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------


def _extract_push_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract meaningful data from a 'push' event."""
    commits = payload.get("commits", [])
    return {
        "ref": payload.get("ref"),
        "pusher": payload.get("pusher", {}).get("name"),
        "commit_count": len(commits),
        "commit_messages": [c.get("message", "") for c in commits[:10]],
        "repository": payload.get("repository", {}).get("full_name"),
    }


def _extract_pr_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract meaningful data from a 'pull_request' event."""
    pr = payload.get("pull_request", {})
    return {
        "action": payload.get("action"),
        "title": pr.get("title"),
        "body": pr.get("body"),
        "author": pr.get("user", {}).get("login"),
        "base": pr.get("base", {}).get("ref"),
        "head": pr.get("head", {}).get("ref"),
        "diff_url": pr.get("diff_url"),
    }


def _generic_extractor(payload: dict[str, Any]) -> dict[str, Any]:
    return {"keys": list(payload.keys())}


_EXTRACTORS = {
    "push": _extract_push_context,
    "pull_request": _extract_pr_context,
}


# ---------------------------------------------------------------------------
# LLM Integration (placeholder)
# ---------------------------------------------------------------------------


async def _call_llm(context: dict[str, Any]) -> str:
    """
    TODO: Replace with real LLM SDK call.

    Example (Google Gemini):
        import google.generativeai as genai
        model = genai.GenerativeModel('gemini-pro')
        response = model.generate_content(prompt)
        return response.text
    """
    prompt = textwrap.dedent(f"""
        You are a developer-experience assistant. Summarise the following
        GitHub event in 2-3 sentences for a developer notification:

        {context}
    """)
    _ = prompt  # suppress unused variable warning until LLM is wired in
    return "[AI summary placeholder] Change detected — review required."


def _derive_actions(event_type: str, payload: dict[str, Any]) -> list[str]:
    """
    Suggest local actions based on event type.
    These are sent to the Mac agent as 'resolution_actions'.
    """
    if event_type == "push":
        return ["git_fetch", "git_pull", "npm_install"]
    if event_type == "pull_request" and payload.get("action") == "closed":
        if payload.get("pull_request", {}).get("merged"):
            return ["git_fetch", "git_pull", "npm_install", "run_tests"]
    return ["git_fetch"]
