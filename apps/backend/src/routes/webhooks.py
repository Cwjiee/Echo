"""GitHub webhook ingestion route."""

import hashlib
import hmac
import json
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request, status

from src.config import get_settings
from src.services.orchestrator import process_github_event

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def _verify_signature(payload_body: bytes, signature_header: str | None) -> None:
    """Validate the X-Hub-Signature-256 header sent by GitHub."""
    settings = get_settings()

    if settings.skip_signature_check:
        return

    if not signature_header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")

    expected = "sha256=" + hmac.new(
        settings.github_webhook_secret.encode(), payload_body, hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, signature_header):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid signature")


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


@router.post("/github", status_code=status.HTTP_202_ACCEPTED)
async def receive_github_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_hub_signature_256: Annotated[str | None, Header()] = None,
    x_github_event: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    """
    Ingests raw GitHub webhook payloads.

    Flow:
      1. Validate HMAC signature.
      2. Parse event type.
      3. Dispatch background task → orchestrator → AI analyser → WebSocket broadcast.
    """
    body = await request.body()
    _verify_signature(body, x_hub_signature_256)

    event_type = x_github_event or "unknown"
    payload: dict[str, Any] = json.loads(body)

    # Fire-and-forget: orchestrate the full pipeline
    background_tasks.add_task(process_github_event, event_type, payload)

    return {"accepted": True, "event": event_type}
