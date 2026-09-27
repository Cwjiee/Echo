"""
Socket.IO WebSocket Manager.

Manages:
  - Authenticated connections from Mac agents
  - Room-based event broadcasting (per developer / workspace)
  - Approval payload relay
"""

from __future__ import annotations

from typing import Any

import socketio

# ---------------------------------------------------------------------------
# Server instance
# ---------------------------------------------------------------------------
# AsyncServer so all handlers are coroutines — compatible with FastAPI.

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",  # Tighten in production
    logger=True,
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

    TODO: Validate token against a database / JWT.
    """
    token = (auth or {}).get("token", "")
    workspace = (auth or {}).get("workspace", "default")

    if not token:
        print(f"[ws] Rejected unauthenticated connection: {sid}")
        return False  # Reject connection

    _connected_agents[sid] = {"workspace": workspace, "token": token}
    await sio.enter_room(sid, workspace)  # Group agents by workspace
    print(f"[ws] Agent connected: sid={sid} workspace={workspace}")
    await sio.emit("connected", {"message": "Echo agent connected", "sid": sid}, to=sid)
    return True


@sio.event
async def disconnect(sid: str) -> None:
    agent = _connected_agents.pop(sid, {})
    print(f"[ws] Agent disconnected: sid={sid} was={agent}")


# ---------------------------------------------------------------------------
# Client → Server events
# ---------------------------------------------------------------------------


@sio.event
async def approval_response(sid: str, data: dict[str, Any]) -> None:
    """
    Mac agent acknowledges that an 'approved_resolution' was executed.

    data = { "action_id": "...", "success": true, "output": "..." }
    """
    print(f"[ws] Approval response from {sid}: {data}")
    # TODO: Persist result to database, notify bot channel


# ---------------------------------------------------------------------------
# Server → Client broadcast helpers
# ---------------------------------------------------------------------------


async def broadcast_event(event_name: str, data: dict[str, Any], room: str = "/") -> None:
    """Broadcast an event to all connected agents (or a specific room)."""
    if room == "/":
        await sio.emit(event_name, data)
    else:
        await sio.emit(event_name, data, room=room)


async def send_approved_resolution(
    workspace: str,
    action_id: str,
    actions: list[str],
    context: dict[str, Any],
) -> None:
    """
    Send an approved resolution payload to all agents in a workspace room.

    Payload shape the Mac agent / local-executor expects:
    {
        "action_id": "<uuid>",
        "actions": ["git_fetch", "git_pull", "npm_install"],
        "context": { ... }
    }
    """
    payload = {"action_id": action_id, "actions": actions, "context": context}
    await sio.emit("approved_resolution", payload, room=workspace)
    print(f"[ws] Sent approved_resolution to room '{workspace}': {payload}")
