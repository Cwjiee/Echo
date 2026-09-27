"""Echo Backend — FastAPI + Socket.IO entry point."""

from contextlib import asynccontextmanager

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.routes.webhooks import router as webhook_router
from src.routes.health import router as health_router
from src.websocket.manager import sio


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup / shutdown hooks."""
    print("[echo] Backend starting up...")
    yield
    print("[echo] Backend shutting down...")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Echo Backend",
        description="AI-powered DevEx webhook processor and WebSocket bridge.",
        version="0.0.1",
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

    return app


# Mount Socket.IO on top of the FastAPI ASGI app
_fastapi_app = create_app()
app = socketio.ASGIApp(sio, other_asgi_app=_fastapi_app)
