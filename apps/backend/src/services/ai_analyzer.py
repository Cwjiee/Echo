"""
Cloud AI Agent — main orchestrator (Phase 2).

Pipeline for each incoming GitHub event:
  1. Extract structured context  (event-type-aware extractor)
  2. Fetch diff from GitHub API  (diff_fetcher)
  3. Detect conflicts            (conflict_detector)
  4. Generate resolution         (resolution_generator)
  5. Build & return the standardised AnalysisResult payload

The AnalysisResult is consumed by the webhook route, which broadcasts it
over WebSocket to the connected Mac agents and posts a notification to the
Discord/Slack ChatOps bot.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from src.services.conflict_detector import ConflictReport, analyse_conflict
from src.services.diff_fetcher import (
    fetch_commit_diff,
    fetch_pr_diff,
    list_changed_files,
)
from src.services.resolution_generator import ResolutionProposal, generate_resolution

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def analyze_payload(
    event_type: str,
    payload: dict[str, Any],
    local_branch: str = "unknown",
) -> dict[str, Any]:
    """
    Main entry point — called by the webhook route.

    Parameters
    ----------
    event_type:   GitHub event header value ("push", "pull_request", …)
    payload:      Raw JSON payload from GitHub webhook.
    local_branch: Developer's local branch (passed from the Mac agent when
                  known; defaults to "unknown" for broadcast-to-all mode).

    Returns a standardised AnalysisResult dict.
    """
    extractor = _EXTRACTORS.get(event_type, _generic_extractor)
    context = extractor(payload)

    # --- Fetch diff ----------------------------------------------------------
    diff = await _fetch_diff(event_type, payload, context)

    # --- Changed files list (for heuristic screening) -----------------------
    changed_files = await _fetch_changed_files(event_type, payload, context)

    # --- Conflict detection --------------------------------------------------
    upstream_branch = context.get("ref", context.get("head", "unknown"))
    conflict_report: ConflictReport = await analyse_conflict(
        diff=diff,
        local_branch=local_branch,
        upstream_branch=upstream_branch,
        changed_files=changed_files,
    )

    # --- Resolution proposal -------------------------------------------------
    proposal: ResolutionProposal = await generate_resolution(
        event_type=event_type,
        context=context,
        diff=diff,
        conflict_report=conflict_report,
    )

    # --- Build standardised payload -----------------------------------------
    action_id = str(uuid.uuid4())
    return _build_result(
        action_id=action_id,
        event_type=event_type,
        context=context,
        conflict_report=conflict_report,
        proposal=proposal,
    )


# ---------------------------------------------------------------------------
# Result builder
# ---------------------------------------------------------------------------


def _build_result(
    action_id: str,
    event_type: str,
    context: dict[str, Any],
    conflict_report: ConflictReport,
    proposal: ResolutionProposal,
) -> dict[str, Any]:
    """
    Produces the standardised AnalysisResult dict.

    Shape expected by the Mac agent and Discord bot:
    {
        "action_id":          str   — unique ID for this analysis run
        "event_type":         str
        "summary":            str   — human-readable summary from the LLM
        "severity":           str   — "info" | "warning" | "critical"
        "requires_approval":  bool
        "conflict": {
            "has_conflict":   bool
            "confidence":     float
            "conflict_type":  str
            "affected_files": list[str]
            "description":    str
        },
        "resolution": {
            "steps":   list[str]
            "actions": list[str]  — machine-executable action tokens
        },
        "context":            dict  — raw extracted context for debugging
    }
    """
    return {
        "action_id": action_id,
        "event_type": event_type,
        "summary": proposal.summary,
        "severity": proposal.severity,
        "requires_approval": proposal.requires_approval,
        "conflict": conflict_report.to_dict(),
        "resolution": {
            "steps": proposal.steps,
            "actions": proposal.actions,
        },
        "context": context,
    }


# ---------------------------------------------------------------------------
# Context extractors
# ---------------------------------------------------------------------------


def _extract_push_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract meaningful data from a 'push' event."""
    commits = payload.get("commits", [])
    repo = payload.get("repository", {})
    return {
        "ref": payload.get("ref", ""),
        "pusher": payload.get("pusher", {}).get("name"),
        "repository": repo.get("full_name"),
        "default_branch": repo.get("default_branch", "main"),
        "commit_count": len(commits),
        "head_commit_sha": payload.get("head_commit", {}).get("id"),
        "commit_messages": [c.get("message", "") for c in commits[:10]],
        "before_sha": payload.get("before"),
        "after_sha": payload.get("after"),
    }


def _extract_pr_context(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract meaningful data from a 'pull_request' event."""
    pr = payload.get("pull_request", {})
    repo = payload.get("repository", {})
    return {
        "action": payload.get("action"),
        "pr_number": pr.get("number"),
        "title": pr.get("title"),
        "body": pr.get("body", "")[:500],   # Truncate long PR bodies
        "author": pr.get("user", {}).get("login"),
        "base": pr.get("base", {}).get("ref"),
        "head": pr.get("head", {}).get("ref"),
        "head_sha": pr.get("head", {}).get("sha"),
        "merged": pr.get("merged", False),
        "diff_url": pr.get("diff_url"),
        "repository": repo.get("full_name"),
    }


def _extract_release_context(payload: dict[str, Any]) -> dict[str, Any]:
    release = payload.get("release", {})
    repo = payload.get("repository", {})
    return {
        "action": payload.get("action"),
        "tag_name": release.get("tag_name"),
        "name": release.get("name"),
        "prerelease": release.get("prerelease", False),
        "body": (release.get("body") or "")[:500],
        "repository": repo.get("full_name"),
    }


def _generic_extractor(payload: dict[str, Any]) -> dict[str, Any]:
    repo = payload.get("repository", {})
    return {
        "repository": repo.get("full_name"),
        "keys": list(payload.keys()),
    }


_EXTRACTORS = {
    "push": _extract_push_context,
    "pull_request": _extract_pr_context,
    "release": _extract_release_context,
}


# ---------------------------------------------------------------------------
# Diff fetching (per event type)
# ---------------------------------------------------------------------------


async def _fetch_diff(
    event_type: str,
    payload: dict[str, Any],
    context: dict[str, Any],
) -> str:
    """Fetch the unified diff for the event from GitHub. Returns "" on failure."""
    repo = context.get("repository")
    if not repo:
        return ""

    try:
        if event_type == "push":
            sha = context.get("head_commit_sha")
            if sha:
                return await fetch_commit_diff(repo, sha)

        elif event_type == "pull_request":
            pr_number = context.get("pr_number")
            if pr_number:
                return await fetch_pr_diff(repo, int(pr_number))

    except Exception as exc:
        logger.warning("Failed to fetch diff for %s event: %s", event_type, exc)

    return ""


async def _fetch_changed_files(
    event_type: str,
    payload: dict[str, Any],
    context: dict[str, Any],
) -> list[dict[str, Any]]:
    """Fetch the list of changed files. Returns [] on failure."""
    repo = context.get("repository")
    if not repo:
        return []

    try:
        if event_type == "push":
            sha = context.get("head_commit_sha")
            if sha:
                return await list_changed_files(repo, sha)
    except Exception as exc:
        logger.warning("Failed to fetch changed files for %s event: %s", event_type, exc)

    return []
