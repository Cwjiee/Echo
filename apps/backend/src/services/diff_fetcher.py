"""
GitHub diff fetcher.

Fetches raw diff / patch content from the GitHub API so the AI agent
has concrete file-level changes to reason about — not just commit metadata.

Uses httpx (already in requirements.txt) with optional GITHUB_TOKEN auth to
avoid rate-limiting on the 60 req/hr unauthenticated tier.

Required (optional but strongly recommended):
  GITHUB_TOKEN — Personal Access Token or GitHub App installation token
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_GITHUB_API = "https://api.github.com"
_DIFF_TRUNCATE_CHARS = 12_000   # Keep prompt under model context limit


def _headers() -> dict[str, str]:
    token = os.getenv("GITHUB_TOKEN")
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


async def fetch_commit_diff(repo_full_name: str, commit_sha: str) -> str:
    """
    Return the unified diff for a single commit.

    Example:
        diff = await fetch_commit_diff("octocat/Hello-World", "abc123")
    """
    url = f"{_GITHUB_API}/repos/{repo_full_name}/commits/{commit_sha}"
    async with httpx.AsyncClient(headers={**_headers(), "Accept": "application/vnd.github.diff"}) as client:
        resp = await client.get(url, timeout=15)
        if resp.status_code == 404:
            logger.warning("Commit %s not found in %s", commit_sha, repo_full_name)
            return ""
        resp.raise_for_status()
        return _truncate(resp.text)


async def fetch_pr_diff(repo_full_name: str, pr_number: int) -> str:
    """
    Return the unified diff for a pull-request.
    """
    url = f"{_GITHUB_API}/repos/{repo_full_name}/pulls/{pr_number}"
    async with httpx.AsyncClient(headers={**_headers(), "Accept": "application/vnd.github.diff"}) as client:
        resp = await client.get(url, timeout=15)
        if resp.status_code == 404:
            logger.warning("PR #%d not found in %s", pr_number, repo_full_name)
            return ""
        resp.raise_for_status()
        return _truncate(resp.text)


async def fetch_compare_diff(repo_full_name: str, base: str, head: str) -> str:
    """
    Return the diff between two refs (branch/SHA).

    Useful for comparing a developer's local branch against the upstream.
    """
    url = f"{_GITHUB_API}/repos/{repo_full_name}/compare/{base}...{head}"
    async with httpx.AsyncClient(headers={**_headers(), "Accept": "application/vnd.github.diff"}) as client:
        resp = await client.get(url, timeout=15)
        if resp.status_code == 404:
            logger.warning("Compare %s...%s not found in %s", base, head, repo_full_name)
            return ""
        resp.raise_for_status()
        return _truncate(resp.text)


async def list_changed_files(repo_full_name: str, commit_sha: str) -> list[dict[str, Any]]:
    """
    Return a list of changed-file objects for a commit.
    Each item: {"filename": str, "status": str, "additions": int,
                 "deletions": int, "patch": str}
    """
    url = f"{_GITHUB_API}/repos/{repo_full_name}/commits/{commit_sha}"
    async with httpx.AsyncClient(headers=_headers()) as client:
        resp = await client.get(url, timeout=15)
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        data = resp.json()
        return data.get("files", [])


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------


def _truncate(text: str) -> str:
    if len(text) > _DIFF_TRUNCATE_CHARS:
        logger.info("Diff truncated from %d to %d chars", len(text), _DIFF_TRUNCATE_CHARS)
        return text[:_DIFF_TRUNCATE_CHARS] + "\n... [diff truncated for context limit]"
    return text
