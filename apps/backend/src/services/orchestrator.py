"""
Orchestrator.

The central coordination layer that wires together every Phase 1 concern:

  1. Receives a raw GitHub event (type + payload) from the webhook route.
  2. Extracts the repository name and derives the target workspace(s).
  3. Calls the AI analyser (Phase 2) to produce an AnalysisResult.
  4. Updates the StateManager (upserts the repo + creates a PendingAction).
  5. Broadcasts the 'github_event' payload to connected Mac agents via Socket.IO.
  6. Returns a bot-ready notification payload so the ChatOps bot (Phase 3) can
     post a Discord/Slack embed with the Sync / Dismiss buttons.

The orchestrator deliberately has no knowledge of Socket.IO internals or bot
protocols — it only calls the helpers exported by those modules.

Routing strategy
----------------
By default every agent receives the broadcast (room="/").  When the event
carries a known repository, only agents in the matching workspace rooms are
targeted.  Workspaces are registered by agents at connect-time via the
``workspace`` auth field.
"""

from __future__ import annotations

import logging
from typing import Any

from src.services.ai_analyzer import analyze_payload
from src.services.state_manager import PendingAction, get_state_manager
from src.websocket.manager import broadcast_event

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def process_github_event(
    event_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """
    Full orchestration pipeline for an inbound GitHub webhook.

    Parameters
    ----------
    event_type : GitHub event header value ("push", "pull_request", …)
    payload    : Raw JSON payload body.

    Returns
    -------
    A bot-notification dict ready to be posted to Discord / Slack.
    """
    state = get_state_manager()

    # ------------------------------------------------------------------
    # 1. Extract repository metadata from the payload
    # ------------------------------------------------------------------
    repo_name = _extract_repo_name(payload)
    default_branch = _extract_default_branch(payload)

    # ------------------------------------------------------------------
    # 2. Run AI analysis (Phase 2)
    # ------------------------------------------------------------------
    logger.info("[orchestrator] Analysing %s event for repo=%s", event_type, repo_name)
    analysis: dict[str, Any] = await analyze_payload(event_type, payload)

    action_id: str = analysis["action_id"]

    # ------------------------------------------------------------------
    # 3. Determine target workspace(s)
    # ------------------------------------------------------------------
    # Agents register their workspace at connect time.  When we know the
    # repo we route only to agents that have declared interest in it.
    # If the repo is unknown (not yet registered) we broadcast to everyone.
    workspaces = state.repos_for_workspace("*")  # placeholder
    repo_record = state.get_repo(repo_name) if repo_name else None
    if repo_record and repo_record.watched_by:
        workspaces = repo_record.watched_by

    # Use "/" (all agents) when no specific workspace is known
    target_room = workspaces[0] if workspaces else "/"

    # ------------------------------------------------------------------
    # 4. Persist state
    # ------------------------------------------------------------------
    if repo_name:
        await state.upsert_repo(
            full_name=repo_name,
            default_branch=default_branch,
            event_type=event_type,
            workspace=target_room if target_room != "/" else "",
        )

    pending: PendingAction = await state.create_pending_action(
        action_id=action_id,
        event_type=event_type,
        repository=repo_name or "unknown",
        workspace=target_room,
        analysis=analysis,
    )
    logger.info(
        "[orchestrator] PendingAction created: action_id=%s severity=%s requires_approval=%s",
        action_id,
        pending.severity,
        pending.requires_approval,
    )

    # ------------------------------------------------------------------
    # 5. Broadcast to Mac agents
    # ------------------------------------------------------------------
    socket_payload = {
        "event_type": event_type,
        "analysis": analysis,
    }
    await broadcast_event("github_event", socket_payload, room=target_room)
    logger.info(
        "[orchestrator] Broadcast 'github_event' to room='%s' action_id=%s",
        target_room,
        action_id,
    )

    # ------------------------------------------------------------------
    # 6. Build and return the bot-notification payload
    # ------------------------------------------------------------------
    return _build_bot_notification(event_type, repo_name, analysis, action_id)


async def handle_approval(
    action_id: str,
    workspace: str,
    approved_by: str = "unknown",
) -> bool:
    """
    Called when a developer clicks "Sync Local Env" in the bot.

    Updates the PendingAction status, then emits 'approved_resolution'
    to the workspace room so the Mac agent can execute the resolution.

    Returns True if the action was found and dispatched, False otherwise.
    """
    from src.websocket.manager import send_approved_resolution  # local import avoids cycle

    state = get_state_manager()
    action = state.get_pending_action(action_id)
    if not action:
        logger.warning("[orchestrator] Approval for unknown action_id=%s", action_id)
        return False

    await state.update_action_status(action_id, "approved")
    logger.info(
        "[orchestrator] Action approved: action_id=%s by=%s workspace=%s",
        action_id,
        approved_by,
        workspace,
    )

    await send_approved_resolution(
        workspace=workspace,
        action_id=action_id,
        actions=action.actions,
        context={
            "repository": action.repository,
            "event_type": action.event_type,
            "approved_by": approved_by,
            **action.context,
        },
    )
    return True


async def handle_dismissal(action_id: str) -> bool:
    """Called when a developer clicks "Dismiss" in the bot."""
    state = get_state_manager()
    action = state.get_pending_action(action_id)
    if not action:
        return False
    await state.update_action_status(action_id, "rejected")
    logger.info("[orchestrator] Action dismissed: action_id=%s", action_id)
    return True


async def handle_execution_result(
    action_id: str,
    success: bool,
    output: str,
) -> PendingAction | None:
    """
    Called when the Mac agent reports back the execution result.
    Updates state and returns the updated PendingAction.
    """
    state = get_state_manager()
    status = "completed" if success else "failed"
    return await state.update_action_status(action_id, status, output=output)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _extract_repo_name(payload: dict[str, Any]) -> str:
    """Extract the repository full_name from any GitHub event payload."""
    repo = payload.get("repository", {})
    return repo.get("full_name", "")


def _extract_default_branch(payload: dict[str, Any]) -> str:
    repo = payload.get("repository", {})
    return repo.get("default_branch", "main")


def _build_bot_notification(
    event_type: str,
    repo_name: str,
    analysis: dict[str, Any],
    action_id: str,
) -> dict[str, Any]:
    """
    Produce a notification dict consumed by the Discord/Slack bot (Phase 3).

    Shape the bot expects:
    {
        "action_id":         str
        "event_type":        str
        "repository":        str
        "summary":           str
        "severity":          "info" | "warning" | "critical"
        "requires_approval": bool
        "conflict":          { ... }
        "resolution_steps":  list[str]
        "actions":           list[str]
    }
    """
    return {
        "action_id": action_id,
        "event_type": event_type,
        "repository": repo_name,
        "summary": analysis.get("summary", ""),
        "severity": analysis.get("severity", "info"),
        "requires_approval": analysis.get("requires_approval", False),
        "conflict": analysis.get("conflict", {}),
        "resolution_steps": analysis.get("resolution", {}).get("steps", []),
        "actions": analysis.get("resolution", {}).get("actions", []),
    }
