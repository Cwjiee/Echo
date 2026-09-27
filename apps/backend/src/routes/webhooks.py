"""GitHub webhook ingestion route."""

import hashlib
import hmac
import json
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request, status

from src.services.ai_analyzer import analyze_payload
from src.websocket.manager import broadcast_event

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

# ---------------------------------------------------------------------------
# Config (load from env in production)
# ---------------------------------------------------------------------------

GITHUB_WEBHOOK_SECRET = "changeme"


def _verify_signature(payload_body: bytes, signature_header: str | None) -> None:
    """Validate the X-Hub-Signature-256 header sent by GitHub."""
    if not signature_header:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing signature")

    expected = "sha256=" + hmac.new(
        GITHUB_WEBHOOK_SECRET.encode(), payload_body, hashlib.sha256
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
) -> dict:
    """
    Ingests raw GitHub webhook payloads.

    Flow:
      1. Validate HMAC signature.
      2. Parse event type.
      3. Dispatch background task → AI analyser → WebSocket broadcast.
    """
    body = await request.body()
    _verify_signature(body, x_hub_signature_256)

    event_type = x_github_event or "unknown"
    payload: dict = json.loads(body)

    # Fire-and-forget: analyse + notify connected Mac agents
    background_tasks.add_task(_process_event, event_type, payload)

    return {"accepted": True, "event": event_type}


async def _process_event(event_type: str, payload: dict) -> None:
    """Background task: run AI analysis and broadcast result over WebSocket."""
    print(f"[webhook] Processing event: {event_type}")
    # analyze_payload now returns a full AnalysisResult dict (Phase 2)
    analysis_result = await analyze_payload(event_type, payload)
    await broadcast_event(
        "github_event",
        {
            "event_type": event_type,
            "analysis": analysis_result,
        },
    )
    print(
        f"[webhook] Broadcast complete — action_id={analysis_result.get('action_id')} "
        f"severity={analysis_result.get('severity')} "
        f"requires_approval={analysis_result.get('requires_approval')}"
    )
