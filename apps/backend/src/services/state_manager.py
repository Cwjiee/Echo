"""
State Manager.

Tracks the live state of the Echo backend:

  - Known repositories and which workspaces care about them.
  - Connected agent sessions (sid → metadata), managed by the WebSocket layer.
  - Pending actions awaiting developer approval or execution confirmation.

Storage strategy
----------------
The primary store is an in-memory dict so reads are O(1) with zero latency.
When Redis is available, writes are also mirrored to Redis so the state
survives a process restart and can be inspected externally.

Redis key conventions
---------------------
  echo:repo:{owner/name}            → JSON  (RepoRecord)
  echo:pending:{action_id}          → JSON  (PendingAction)  TTL: 24 h
  echo:workspace_repos:{workspace}  → Redis SET of repo full_names
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Protocol version — must match PROTOCOL_VERSION in @echo/local-executor/src/types.ts
# ---------------------------------------------------------------------------
PROTOCOL_VERSION = 1

# ---------------------------------------------------------------------------
# TTL for pending actions in Redis (seconds)
# ---------------------------------------------------------------------------
_PENDING_TTL = 86_400  # 24 hours


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class RepoRecord:
    """A GitHub repository that the backend knows about."""

    full_name: str           # "owner/repo"
    default_branch: str = "main"
    last_event: str = ""     # event type of the most recent webhook
    last_event_at: str = ""  # ISO timestamp
    watched_by: list[str] = field(default_factory=list)  # workspace names

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PendingAction:
    """An AI-analysed action waiting for developer approval or completion."""

    action_id: str
    event_type: str
    repository: str          # full_name
    workspace: str           # target workspace / room
    summary: str
    severity: str            # "info" | "warning" | "critical"
    requires_approval: bool
    actions: list[str]       # executable action tokens
    steps: list[str]
    conflict: dict[str, Any]
    context: dict[str, Any]
    status: str = "pending"  # pending | approved | rejected | completed | failed
    created_at: str = field(default_factory=lambda: _utcnow())
    resolved_at: str = ""
    output: str = ""
    # Populated by the inspect round-trip: local HEAD SHA at the moment the
    # developer saw the resolution.  Required by apply() to prevent STALE_STATE.
    base_sha: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _utcnow() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# StateManager
# ---------------------------------------------------------------------------


class StateManager:
    """
    In-process state store with optional Redis mirroring.

    Usage
    -----
    Call ``await state_manager.init(redis_client)`` at startup if you want
    Redis persistence.  If no Redis client is provided the manager operates
    fully in-memory — suitable for development and tests.
    """

    def __init__(self) -> None:
        self._repos: dict[str, RepoRecord] = {}          # full_name → RepoRecord
        self._pending: dict[str, PendingAction] = {}     # action_id → PendingAction
        self._workspace_repos: dict[str, set[str]] = {}  # workspace → set[full_name]
        self._redis: Any | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def init(self, redis_client: Any | None = None) -> None:
        """Connect the optional Redis client and warm up in-memory state."""
        self._redis = redis_client
        if redis_client:
            await self._warm_up()
            logger.info("[state] State manager initialised with Redis mirroring")
        else:
            logger.info("[state] State manager initialised (in-memory only)")

    # ------------------------------------------------------------------
    # Repository tracking
    # ------------------------------------------------------------------

    async def upsert_repo(
        self,
        full_name: str,
        default_branch: str = "main",
        event_type: str = "",
        workspace: str = "",
    ) -> RepoRecord:
        """Create or update a repository record."""
        existing = self._repos.get(full_name)
        if existing:
            if event_type:
                existing.last_event = event_type
                existing.last_event_at = _utcnow()
            if workspace and workspace not in existing.watched_by:
                existing.watched_by.append(workspace)
            record = existing
        else:
            record = RepoRecord(
                full_name=full_name,
                default_branch=default_branch,
                last_event=event_type,
                last_event_at=_utcnow() if event_type else "",
                watched_by=[workspace] if workspace else [],
            )
            self._repos[full_name] = record

        if workspace:
            self._workspace_repos.setdefault(workspace, set()).add(full_name)

        await self._redis_set(f"echo:repo:{full_name}", record.to_dict())
        return record

    def get_repo(self, full_name: str) -> RepoRecord | None:
        return self._repos.get(full_name)

    def list_repos(self) -> list[RepoRecord]:
        return list(self._repos.values())

    def repos_for_workspace(self, workspace: str) -> list[str]:
        """Return repo full_names watched by the given workspace."""
        return list(self._workspace_repos.get(workspace, set()))

    # ------------------------------------------------------------------
    # Pending actions
    # ------------------------------------------------------------------

    async def create_pending_action(
        self,
        action_id: str,
        event_type: str,
        repository: str,
        workspace: str,
        analysis: dict[str, Any],
    ) -> PendingAction:
        """Record an AI-analysed action waiting for disposition."""
        action = PendingAction(
            action_id=action_id,
            event_type=event_type,
            repository=repository,
            workspace=workspace,
            summary=analysis.get("summary", ""),
            severity=analysis.get("severity", "info"),
            requires_approval=analysis.get("requires_approval", False),
            actions=analysis.get("resolution", {}).get("actions", []),
            steps=analysis.get("resolution", {}).get("steps", []),
            conflict=analysis.get("conflict", {}),
            context=analysis.get("context", {}),
        )
        self._pending[action_id] = action
        await self._redis_set(
            f"echo:pending:{action_id}", action.to_dict(), ttl=_PENDING_TTL
        )
        return action

    def get_pending_action(self, action_id: str) -> PendingAction | None:
        return self._pending.get(action_id)

    def list_pending_actions(self, workspace: str | None = None) -> list[PendingAction]:
        actions = list(self._pending.values())
        if workspace:
            actions = [a for a in actions if a.workspace == workspace]
        return actions

    async def update_action_status(
        self,
        action_id: str,
        status: str,
        output: str = "",
    ) -> PendingAction | None:
        """Transition an action to a new status (approved / completed / failed …)."""
        action = self._pending.get(action_id)
        if not action:
            return None
        action.status = status
        if output:
            action.output = output
        if status in ("completed", "failed", "rejected"):
            action.resolved_at = _utcnow()
        await self._redis_set(
            f"echo:pending:{action_id}", action.to_dict(), ttl=_PENDING_TTL
        )
        return action

    async def store_inspect_result(
        self,
        action_id: str,
        head_sha: str,
    ) -> PendingAction | None:
        """Store the local HEAD SHA reported by the mac-agent's inspect call.

        Called when the mac-agent emits an 'inspect_report' event.
        The head_sha is later forwarded as base_sha in the ApplyRequest so
        apply() can verify the local repo hasn't moved since the developer
        approved the resolution.
        """
        action = self._pending.get(action_id)
        if not action:
            return None
        action.base_sha = head_sha
        await self._redis_set(
            f"echo:pending:{action_id}", action.to_dict(), ttl=_PENDING_TTL
        )
        return action

    # ------------------------------------------------------------------
    # Redis helpers (no-ops when Redis is not configured)
    # ------------------------------------------------------------------

    async def _redis_set(
        self, key: str, value: dict[str, Any], ttl: int | None = None
    ) -> None:
        if not self._redis:
            return
        try:
            serialised = json.dumps(value)
            if ttl:
                await self._redis.set(key, serialised, ex=ttl)
            else:
                await self._redis.set(key, serialised)
        except Exception as exc:
            logger.warning("[state] Redis write failed for %s: %s", key, exc)

    async def _warm_up(self) -> None:
        """Restore in-memory state from Redis on startup."""
        try:
            # Repos
            async for key in self._redis.scan_iter("echo:repo:*"):
                raw = await self._redis.get(key)
                if raw:
                    data = json.loads(raw)
                    record = RepoRecord(**data)
                    self._repos[record.full_name] = record
                    for ws in record.watched_by:
                        self._workspace_repos.setdefault(ws, set()).add(record.full_name)

            # Pending actions
            async for key in self._redis.scan_iter("echo:pending:*"):
                raw = await self._redis.get(key)
                if raw:
                    data = json.loads(raw)
                    action = PendingAction(**data)
                    if action.status == "pending":
                        self._pending[action.action_id] = action

            logger.info(
                "[state] Warm-up complete: %d repos, %d pending actions",
                len(self._repos),
                len(self._pending),
            )
        except Exception as exc:
            logger.exception("[state] Warm-up from Redis failed: %s", exc)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_state_manager: StateManager = StateManager()


def get_state_manager() -> StateManager:
    """Return the module-level StateManager singleton."""
    return _state_manager
