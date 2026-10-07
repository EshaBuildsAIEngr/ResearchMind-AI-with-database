"""
app/main.py
Entry point. Run with:
    uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
Production (multiple workers — this is what fixes the single-threaded
Streamlit hang):
    uvicorn app.main:app --workers 4 --host 0.0.0.0 --port 8000
"""

import asyncio
import logging
import os
import sys

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import Base, engine
from app.routers import auth, documents, query, agents, features, voice, admin, billing, ws
from app.services import broadcaster

# ---------------- Logging ----------------
# Structured-enough for now (JSON formatter can be swapped in later without
# touching any call site — every log call already goes through this logger).
logging.basicConfig(
    level=logging.INFO,
    format='{"time": "%(asctime)s", "level": "%(levelname)s", '
           '"logger": "%(name)s", "message": "%(message)s"}',
)
logger = logging.getLogger("researchmind")

# ---------------- Tables ----------------
# For production, replace this with Alembic migrations. Fine for now to
# get the API running against a fresh Postgres/SQLite instance.
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title=settings.APP_NAME,
    description="ResearchMind AI — production backend",
    version="1.0.0",
    root_path=os.getenv("ROOT_PATH", ""),
)

# ---------------- CORS ----------------
# Only the React frontend's real origin(s) are allowed — everything else
# is blocked by default.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------- Startup ----------------
# Captures the real running event loop so broadcaster.publish() — called
# from background worker threads during streaming agent runs — can
# reliably deliver WebSocket updates instead of silently dropping them.
@app.on_event("startup")
async def _capture_main_event_loop():
    broadcaster.set_main_loop(asyncio.get_running_loop())


# Fails loudly instead of silently 404ing every streaming run: if uvicorn has
# no usable WebSocket protocol (neither `websockets` nor `wsproto` importable —
# e.g. uvicorn installed without its [standard] extra, or an incompatible
# websockets major), it refuses every upgrade and serves /ws/agents/* as a
# plain HTTP GET, which Starlette answers with 404.
def _websocket_protocol_missing() -> bool:
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == "--ws" and i + 1 < len(args):
            return args[i + 1] == "none"
        if arg.startswith("--ws="):
            return arg.split("=", 1)[1] == "none"
    try:
        from uvicorn.protocols.websockets.auto import AutoWebSocketsProtocol
    except ImportError:
        return True
    return AutoWebSocketsProtocol is None


@app.on_event("startup")
async def _warn_if_websockets_unavailable():
    if _websocket_protocol_missing():
        logger.error(
            "WebSocket support is NOT available in this environment — every "
            "/ws/agents/{run_id} handshake will be answered with 404. "
            "Install a compatible library (pip install 'uvicorn[standard]' or "
            "pip install 'websockets>=12') and restart."
        )


# ---------------- Global error handler ----------------
# Catches anything a route didn't explicitly handle so the user always
# gets a clean JSON error instead of a blank page / raw traceback.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(f"Unhandled error on {request.method} {request.url.path}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"message": "Something went wrong on our end. Please try again."},
    )


# ---------------- Routers ----------------
app.include_router(auth.router)
app.include_router(documents.router)
app.include_router(query.router)
app.include_router(agents.router)
app.include_router(features.router)
app.include_router(voice.router)
app.include_router(admin.router)
app.include_router(billing.router)
app.include_router(ws.router)


# ---------------- Health check ----------------
@app.get("/health", tags=["system"])
def health_check():
    return {"status": "ok", "env": settings.ENV}


@app.get("/", tags=["system"])
def root():
    return {"message": f"{settings.APP_NAME} API is running."}
