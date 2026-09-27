"""
Socket.IO WebSocket Manager.

Manages:
  - Authenticated connections from Mac agents
  - Room-based event broadcasting (per developer / workspace)
  - Approval payload relay from the bot to the Mac agent
  - Execution result relay from the Mac agent back to the bot
"""

from __future__ import annotations

import logging
from typing import Any

import socketio

from src.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------
# AsyncServer so all handlers are coroutines — compatible with FastAPI.

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # Tighten in production
    logger=False,
    engineio_logger=False,
)

# sid → developer metadata
_connected_agents: dict[str, dict[str, Any]] = {}


# ---------------------------------------------------------------------------
# Connection lifecycle events
# ---------------------------------------------------------------------------


@sio.event
async def connect(sid: str, environ: dict[str, Any], auth: dict[str, Any] | None = None) -> bool:
    """
    Called when a Mac agent connects.

    auth = { "token": "<agent-auth-token>", "workspace": "my-project" }

    The token is validated against the AGENT_AUTH_TOKENS env var.
    When AGENT_AUTH_TOKENS is empty (local dev), all tokens are accepted.
    """
    settings = get_settings()
    token = (auth or {}).get("token", "")
    workspace = (auth or {}).get("workspace", "default")

    if not token:
        logger.warning("[ws] Rejected unauthenticated connection: sid=%s", sid)
        return False  # Reject connection

    valid_tokens = settings.valid_agent_tokens
    if valid_tokens and token not in valid_tokens:
        logger.warning("[ws] Rejected connection with invalid token: sid=%s", sid)
        return False

    _connected_agents[sid] = {"workspace": workspace, "token": token}
    await sio.enter_room(sid, workspace)  # Group agents by workspace
    logger.info("[ws] Agent connected: sid=%s workspace=%s", sid, workspace)
    await sio.emit("connected", {"message": "Echo agent connected", "sid": sid}, to=sid)
    return True


@sio.event
async def disconnect(sid: str) -> None:
    agent = _connected_agents.pop(sid, {})
    logger.info("[ws] Agent disconnected: sid=%s was=%s", sid, agent)


# ---------------------------------------------------------------------------
# Client → Server events
# ---------------------------------------------------------------------------


@sio.event
async def inspect_report(sid: str, data: dict[str, Any]) -> None:
    """
    Mac agent reports the result of a local inspect() call.

    data = {
        "action_id": "...",          — links back to the PendingAction
        "head_sha":  "abc123...",    — local HEAD at inspect time
        "repository": "org/repo"
    }

    Stores head_sha on the PendingAction so handle_approval() can pass it
    as base_sha in the ApplyRequest, satisfying apply()'s STALE_STATE guard.
    """
    action_id = data.get("action_id", "")
    head_sha = data.get("head_sha", "")

    if not action_id or not head_sha:
        logger.warning("[ws] inspect_report missing fields from sid=%s: %s", sid, data)
        return

    from src.services.state_manager import get_state_manager
    action = await get_state_manager().store_inspect_result(action_id, head_sha)
    if action:
        logger.info(
            "[ws] Stored inspect result: action_id=%s head_sha=%s",
            action_id, head_sha,
        )
        # Ack back to the mac-agent so it knows the sha was recorded
        await sio.emit("inspect_ack", {"action_id": action_id}, to=sid)
    else:
        logger.warning("[ws] inspect_report for unknown action_id=%s", action_id)


@sio.event
async def bot_approval(sid: str, data: dict[str, Any]) -> None:
    """
    Discord bot relays a developer's approval click.

    data = { "action_id": "...", "workspace": "...", "approved_by": "username" }

    Flow: Discord button → bot → backend (here) → handle_approval()
          → send_approved_resolution() → mac-agent → apply()
    """
    action_id = data.get("action_id", "")
    workspace = data.get("workspace", "")
    approved_by = data.get("approved_by", "discord-user")

    if not action_id:
        logger.warning("[ws] bot_approval missing action_id from sid=%s", sid)
        return

    # Derive workspace from the action's stored state when not provided
    if not workspace:
        from src.services.state_manager import get_state_manager
        action = get_state_manager().get_pending_action(action_id)
        workspace = action.workspace if action else "default"

    from src.services.orchestrator import handle_approval
    dispatched = await handle_approval(action_id, workspace, approved_by=approved_by)
    logger.info(
        "[ws] bot_approval: action_id=%s workspace=%s dispatched=%s",
        action_id, workspace, dispatched,
    )


@sio.event
async def approval_response(sid: str, data: dict[str, Any]) -> None:
    """
    Mac agent reports back the result of executing an approved resolution.

    data = { "action_id": "...", "success": true, "output": "..." }

    Flow: Mac agent → backend (here) → update state → notify bot channel.
    """
    action_id = data.get("action_id", "")
    success = bool(data.get("success", False))
    output = str(data.get("output", ""))

    logger.info(
        "[ws] Execution result from sid=%s action_id=%s success=%s",
        sid,
        action_id,
        success,
    )

    # Update state and build the bot notification
    from src.services.orchestrator import handle_execution_result  # avoid import cycle

    action = await handle_execution_result(action_id, success, output)
    if action:
        # Emit an execution_result event so the bot can update the Discord message
        await sio.emit(
            "execution_result",
            {
                "action_id": action_id,
                "success": success,
                "output": output,
                "repository": action.repository,
                "workspace": action.workspace,
            },
        )


# ---------------------------------------------------------------------------
# Server → Client broadcast helpers
# ---------------------------------------------------------------------------


async def broadcast_event(event_name: str, data: dict[str, Any], room: str = "/") -> None:
    """Broadcast an event to all connected agents (or a specific room)."""
    if room == "/":
        await sio.emit(event_name, data)
    else:
        await sio.emit(event_name, data, room=room)


# Map from the resolution generator's action tokens to ApplyRequest ActionName tokens.
# The two vocabs differ because the AI layer uses human-readable names.
_ACTION_MAP: dict[str, str] = {
    "git_fetch": "git_fetch",
    "git_pull": "git_pull",
    "git_rebase": "git_rebase",
    "git_merge_upstream": "git_pull",   # closest safe equivalent
    "npm_install": "install_deps",
    "pip_install": "install_deps",      # local-executor handles both via installDeps
    "run_migrations": "run_tests",      # surface as a test step; no dedicated action yet
    "run_tests": "run_tests",
    "manual_review": None,              # no-op — human only, not executable
    "apply_patch": "apply_patch",
}


def _map_actions(raw_actions: list[str]) -> list[str]:
    """Translate resolution generator tokens → ApplyRequest ActionName tokens.

    Drops unknown or non-executable tokens (manual_review, unmapped).
    Falls back to ["git_fetch"] if nothing maps through.
    """
    mapped = []
    for a in raw_actions:
        target = _ACTION_MAP.get(a)
        if target is not None:
            mapped.append(target)
    # Deduplicate while preserving order
    seen: set[str] = set()
    deduped = [x for x in mapped if not (x in seen or seen.add(x))]  # type: ignore[func-returns-value]
    return deduped or ["git_fetch"]


async def send_approved_resolution(
    workspace: str,
    action_id: str,
    actions: list[str],
    context: dict[str, Any],
) -> None:
    """
    Send an ApplyRequest-shaped payload to all agents in a workspace room.

    Builds a protocol-compliant ApplyRequest the local-executor apply() function
    accepts directly.  protocol_version, repository, and base_sha are required by
    the engine; missing any causes an immediate PROTOCOL_MISMATCH / STALE_STATE
    rejection with no execution.
    """
    from src.services.state_manager import PROTOCOL_VERSION  # avoid circular at module level

    mapped_actions = _map_actions(actions)

    payload: dict[str, Any] = {
        "protocol_version": PROTOCOL_VERSION,
        "action_id": action_id,
        "repository": context.get("repository", ""),
        # base_sha must be the local HEAD at inspect-time.  Until the inspect
        # round-trip is implemented the backend passes an empty string; apply()
        # will reject with STALE_STATE and log it — safe failure mode.
        "base_sha": context.get("base_sha", ""),
        "actions": mapped_actions,
        "context": {
            "branch": context.get("ref", context.get("branch", "")),
            "remote": context.get("remote", "origin"),
            "workdir": context.get("workdir"),
        },
    }
    await sio.emit("approved_resolution", payload, room=workspace)
    logger.info(
        "[ws] Sent approved_resolution to room='%s': action_id=%s actions=%s",
        workspace, action_id, mapped_actions,
    )


# ---------------------------------------------------------------------------
# Inspection helpers (used by the admin route)
# ---------------------------------------------------------------------------


def get_connected_agents() -> dict[str, dict]:
    """Return a snapshot of currently connected agents."""
    return dict(_connected_agents)


def get_agent_count() -> int:
    return len(_connected_agents)
