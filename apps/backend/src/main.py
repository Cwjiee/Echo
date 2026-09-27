"""Echo Backend — FastAPI + Socket.IO entry point."""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import get_settings
from src.routes.admin import router as admin_router
from src.routes.health import router as health_router
from src.routes.webhooks import router as webhook_router
from src.services.state_manager import get_state_manager
from src.websocket.manager import sio

settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: startup / shutdown hooks."""
    logger.info("[echo] Backend starting up (env=%s)", settings.app_env)

    # Initialise state manager (Redis mirroring when REDIS_URL is available)
    redis_client = None
    try:
        import redis.asyncio as aioredis  # type: ignore[import-untyped]
        redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)
        await redis_client.ping()
        logger.info("[echo] Redis connected: %s", settings.redis_url)
    except Exception as exc:
        logger.warning("[echo] Redis unavailable — running in-memory only: %s", exc)
        redis_client = None

    await get_state_manager().init(redis_client)

    yield

    logger.info("[echo] Backend shutting down...")
    if redis_client:
        await redis_client.aclose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Echo Backend",
        description="AI-powered DevEx webhook processor and WebSocket bridge.",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Tighten in production
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # REST routes
    app.include_router(health_router, prefix="/api")
    app.include_router(webhook_router, prefix="/api")
    app.include_router(admin_router, prefix="/api")

    return app


# Mount Socket.IO on top of the FastAPI ASGI app
_fastapi_app = create_app()
app = socketio.ASGIApp(sio, other_asgi_app=_fastapi_app)
