"""
Cloud storage endpoints: per-user projects (.vlx payloads) and AI-chat
sessions. Auth via the Bearer token from /api/auth (see auth.require_user).

Projects
  GET    /api/cloud/projects            → {projects: [meta…]}
  POST   /api/cloud/projects            {name, data} → {id}
  GET    /api/cloud/projects/{id}       → {id, name, data, …}
  PUT    /api/cloud/projects/{id}       {name?, data?} → {ok}
  DELETE /api/cloud/projects/{id}       → {ok}

Chat sessions
  GET    /api/cloud/chats               → {chats: [meta…]}
  POST   /api/cloud/chats               {id?, title, messages, api_messages} → {id}
  GET    /api/cloud/chats/{id}          → full session
  DELETE /api/cloud/chats/{id}          → {ok}

POST /chats upserts: pass the id you got last time to update in place (the
frontend auto-sync path), omit it to create a new session.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.api.routes.auth import require_user
from app.services import cloud_db

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str
    data: dict[str, Any]


class ProjectUpdate(BaseModel):
    name: str | None = None
    data: dict[str, Any] | None = None


class ChatUpsert(BaseModel):
    id: str | None = None
    title: str = ""
    messages: list[Any] = Field(default_factory=list)
    api_messages: list[Any] = Field(default_factory=list)


# ── Projects ───────────────────────────────────────────────────────────────


@router.get("/projects")
async def projects_list(authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    return {"projects": cloud_db.list_projects(user["id"])}


@router.post("/projects")
async def projects_create(
    req: ProjectCreate, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    name = req.name.strip()[:100] or "Untitled"
    try:
        pid = cloud_db.create_project(user["id"], name, req.data)
    except ValueError:
        raise HTTPException(status_code=413, detail="Project too large")
    if pid is None:
        raise HTTPException(status_code=409, detail="Project quota reached — delete some first")
    return {"id": pid}


@router.get("/projects/{project_id}")
async def projects_get(
    project_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    project = cloud_db.get_project(user["id"], project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.put("/projects/{project_id}")
async def projects_update(
    project_id: str, req: ProjectUpdate, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    try:
        ok = cloud_db.update_project(
            user["id"], project_id, req.name.strip()[:100] if req.name else None, req.data
        )
    except ValueError:
        raise HTTPException(status_code=413, detail="Project too large")
    if not ok:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


@router.delete("/projects/{project_id}")
async def projects_delete(
    project_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    if not cloud_db.delete_project(user["id"], project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    return {"ok": True}


# ── Chat sessions ──────────────────────────────────────────────────────────


@router.get("/chats")
async def chats_list(authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    return {"chats": cloud_db.list_chats(user["id"])}


@router.post("/chats")
async def chats_upsert(req: ChatUpsert, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    title = req.title.strip()[:120] or "Untitled chat"
    try:
        cid = cloud_db.upsert_chat(user["id"], req.id, title, req.messages, req.api_messages)
    except ValueError:
        raise HTTPException(status_code=413, detail="Chat too large")
    if cid is None:
        if req.id:
            raise HTTPException(status_code=404, detail="Chat not found")
        raise HTTPException(status_code=409, detail="Chat quota reached — delete some first")
    return {"id": cid}


@router.get("/chats/{chat_id}")
async def chats_get(chat_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    chat = cloud_db.get_chat(user["id"], chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


@router.delete("/chats/{chat_id}")
async def chats_delete(chat_id: str, authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    if not cloud_db.delete_chat(user["id"], chat_id):
        raise HTTPException(status_code=404, detail="Chat not found")
    return {"ok": True}
