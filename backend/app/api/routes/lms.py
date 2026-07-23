"""
Learning-management endpoints for the「AI物聯網實驗室」fork: classes,
lesson progress, and quiz attempts. Auth via the same Bearer token as
/api/auth (see auth.require_user); storage in cloud_db (SQLite).

Classes
  POST   /api/lms/classes               {name} → class        (teacher only)
  GET    /api/lms/classes               → {teaching:[…], joined:[…]}
  DELETE /api/lms/classes/{id}          → {ok}                (owning teacher)
  POST   /api/lms/classes/join          {code} → class        (any signed-in user)
  GET    /api/lms/classes/{id}/report   → members + per-student progress/quiz
                                          (owning teacher only)

Progress & quizzes (per signed-in user)
  GET    /api/lms/progress              → {done:[lesson_id…], quiz:{lesson_id:{…}}}
  POST   /api/lms/progress              {lesson_id, status?} → {ok}
  POST   /api/lms/quiz                  {lesson_id, score, total, answers} → {id}

Lesson content itself ships with the frontend (src/learn/courses.ts) —
the backend only stores per-user state, so lesson_id is an opaque string.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.api.routes.auth import require_user
from app.services import cloud_db

router = APIRouter()


class ClassCreate(BaseModel):
    name: str


class ClassJoin(BaseModel):
    code: str


class ProgressSet(BaseModel):
    lesson_id: str
    status: str = "done"  # 'done' | 'reset'


class QuizSubmit(BaseModel):
    lesson_id: str
    score: int = Field(ge=0)
    total: int = Field(gt=0)
    answers: list[Any] = Field(default_factory=list)


def _require_teacher(authorization: str | None) -> dict:
    user = require_user(authorization)
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Teacher account required")
    return user


# ── Classes ────────────────────────────────────────────────────────────────


@router.post("/classes")
async def classes_create(
    req: ClassCreate, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    name = req.name.strip()[:80]
    if not name:
        raise HTTPException(status_code=422, detail="Class name required")
    cls = cloud_db.create_class(user["id"], name)
    if cls is None:
        raise HTTPException(status_code=409, detail="Class quota reached — delete one first")
    return cls


@router.get("/classes")
async def classes_list(authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    return {
        "teaching": (
            cloud_db.list_classes_teaching(user["id"]) if user.get("role") == "teacher" else []
        ),
        "joined": cloud_db.list_classes_joined(user["id"]),
    }


@router.delete("/classes/{class_id}")
async def classes_delete(
    class_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    if not cloud_db.delete_class(user["id"], class_id):
        raise HTTPException(status_code=404, detail="Class not found")
    return {"ok": True}


@router.post("/classes/join")
async def classes_join(
    req: ClassJoin, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    try:
        cls = cloud_db.join_class(user["id"], req.code)
    except ValueError:
        raise HTTPException(status_code=409, detail="Class is full")
    if cls is None:
        raise HTTPException(status_code=404, detail="Unknown class code")
    return cls


@router.get("/classes/{class_id}/report")
async def classes_report(
    class_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    report = cloud_db.get_class_report(user["id"], class_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Class not found")
    return report


# ── Progress & quizzes ─────────────────────────────────────────────────────


@router.get("/progress")
async def progress_get(authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    return {
        "done": cloud_db.get_progress(user["id"]),
        "quiz": cloud_db.get_quiz_best(user["id"]),
    }


@router.post("/progress")
async def progress_set(
    req: ProgressSet, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    status = req.status if req.status in ("done", "reset") else "done"
    lesson_id = req.lesson_id.strip()[:120]
    if not lesson_id:
        raise HTTPException(status_code=422, detail="lesson_id required")
    cloud_db.set_progress(user["id"], lesson_id, status)
    return {"ok": True}


@router.post("/quiz")
async def quiz_submit(
    req: QuizSubmit, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    if req.score > req.total:
        raise HTTPException(status_code=422, detail="score cannot exceed total")
    lesson_id = req.lesson_id.strip()[:120]
    if not lesson_id:
        raise HTTPException(status_code=422, detail="lesson_id required")
    try:
        attempt_id = cloud_db.record_quiz(
            user["id"], lesson_id, req.score, req.total, req.answers
        )
    except ValueError:
        raise HTTPException(status_code=413, detail="Answers payload too large")
    return {"id": attempt_id}
