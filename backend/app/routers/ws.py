"""
app/routers/ws.py
WebSocket endpoint the frontend connects to right after starting a
streaming agent run (POST /agents/stream), to watch its steps arrive in
real time instead of polling or waiting for the whole thing to finish.

Auth: browsers can't set custom headers on a WebSocket handshake, so the
JWT access token is passed as a query parameter instead: 
ws://<host>/ws/agents/{run_id}?token=<access_token>
"""

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.database import SessionLocal
from app.core.deps import get_user_from_token_string
from app.models import AgentRun
from app.services import broadcaster

logger = logging.getLogger("researchmind")

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/agents/{run_id}")
async def agent_run_stream(websocket: WebSocket, run_id: str, token: str = ""):
    db = SessionLocal()
    try:
        user = get_user_from_token_string(token, db) if token else None
        if not user:
            # Closed BEFORE accept, so uvicorn only shows a generic handshake
            # failure in its access log — log the real reason here.
            logger.warning("WS /ws/agents/%s rejected: missing/invalid/expired token.", run_id)
            await websocket.close(code=4401)
            return

        run = db.query(AgentRun).filter(AgentRun.id == run_id, AgentRun.user_id == user.id).first()
        if not run:
            logger.warning(
                "WS /ws/agents/%s rejected: no run with that id for this user.", run_id
            )
            await websocket.close(code=4404)
            return

        await websocket.accept()

        # If the run already finished before the client connected (race on
        # a fast run), send the final state immediately and close.
        if run.status in ("done", "failed"):
            await websocket.send_text(json.dumps({
                "type": "run_finished", "run_id": run.id, "status": run.status,
                "result_text": run.result_text,
                "result": json.loads(run.result_json) if run.result_json else None,
                "error": run.error_message,
            }))
            await websocket.close()
            return

        queue = broadcaster.subscribe(run_id)
        try:
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=30)
                except asyncio.TimeoutError:
                    # Periodic keepalive so proxies/load balancers don't
                    # time out an idle-looking connection.
                    if websocket.client_state != WebSocketState.CONNECTED:
                        break
                    await websocket.send_text(json.dumps({"type": "ping"}))
                    continue

                await websocket.send_text(message)
                event = json.loads(message)
                if event.get("type") == "run_finished":
                    break
        finally:
            broadcaster.unsubscribe(run_id, queue)

        await websocket.close()
    except WebSocketDisconnect:
        pass
    finally:
        db.close()
