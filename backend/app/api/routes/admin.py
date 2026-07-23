"""
Admin endpoints for the「AI物聯網實驗室」platform operator.

The admin account is bootstrapped from VELXIO_ADMIN_EMAIL /
VELXIO_ADMIN_PASSWORD at startup (see cloud_db.ensure_admin_from_env);
there is no self-service path to the admin role.

  GET    /api/admin/overview            → user counts, classes, week tokens
  GET    /api/admin/users?query=        → users + this week's AI usage/limit
  POST   /api/admin/users/batch         → bulk-create accounts, returns creds
  POST   /api/admin/users/{id}/quota    {weekly_token_limit|null} → {ok}
  POST   /api/admin/users/{id}/password {password?} → {ok, password}
  DELETE /api/admin/users/{id}          → {ok}

Batch creation is how the operator provisions customers: N student and/or
teacher accounts with generated readable passwords, optionally auto-joined
to a class code. The response is the ONLY time the passwords are visible —
the admin downloads/copies them and hands them out.
"""

from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.api.routes.auth import require_user
from app.services import cloud_db

router = APIRouter()

# Readable password alphabet: no 0/O/1/l/I ambiguity.
_PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"
_PREFIX_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")

MAX_BATCH = 200


def require_admin(authorization: str | None) -> dict:
    user = require_user(authorization)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin account required")
    return user


def _gen_password(length: int = 10) -> str:
    return "".join(secrets.choice(_PW_ALPHABET) for _ in range(length))


class BatchCreate(BaseModel):
    role: str = "student"  # 'student' | 'teacher'
    count: int = Field(ge=1, le=MAX_BATCH)
    # Accounts become {prefix}{n}@{domain} — e.g. stu1@school.local
    prefix: str = "stu"
    domain: str = "school.local"
    # Display names become {name_prefix}{n} — e.g. 學生1
    name_prefix: str = "學生"
    start_number: int = Field(default=1, ge=1)
    # Students can be auto-joined to an existing class by its join code.
    class_code: str = ""
    # Optional per-user weekly AI token limit (None = platform default).
    weekly_token_limit: int | None = None


class QuotaSet(BaseModel):
    weekly_token_limit: int | None = Field(default=None, ge=0)


class PasswordReset(BaseModel):
    # Omit to have the server generate a readable one (returned once).
    password: str = ""


@router.get("/overview")
async def overview(authorization: str | None = Header(default=None)) -> dict:
    require_admin(authorization)
    return cloud_db.admin_overview()


@router.get("/users")
async def users_list(
    query: str = "", authorization: str | None = Header(default=None)
) -> dict:
    require_admin(authorization)
    return {"users": cloud_db.admin_list_users(query)}


@router.post("/users/batch")
async def users_batch(
    req: BatchCreate, authorization: str | None = Header(default=None)
) -> dict:
    require_admin(authorization)
    role = req.role if req.role in ("student", "teacher") else "student"
    prefix = req.prefix.strip().lower()
    if not _PREFIX_RE.match(prefix):
        raise HTTPException(
            status_code=422, detail="prefix must be lowercase letters/digits/dashes"
        )
    domain = req.domain.strip().lower() or "school.local"

    created: list[dict] = []
    skipped: list[str] = []
    joined = 0
    for i in range(req.count):
        n = req.start_number + i
        email = f"{prefix}{n}@{domain}"
        password = _gen_password()
        user = cloud_db.create_user(email, password, f"{req.name_prefix}{n}", role=role)
        if user is None:  # email already exists — never overwrite silently
            skipped.append(email)
            continue
        if req.weekly_token_limit is not None:
            cloud_db.set_token_limit(user["id"], req.weekly_token_limit)
        if role == "student" and req.class_code.strip():
            try:
                if cloud_db.join_class(user["id"], req.class_code):
                    joined += 1
            except ValueError:
                pass  # class full — accounts still created
        created.append({"email": email, "password": password, "name": user["name"]})

    return {"created": created, "skipped": skipped, "joined_class": joined}


@router.post("/users/{user_id}/quota")
async def user_quota(
    user_id: str, req: QuotaSet, authorization: str | None = Header(default=None)
) -> dict:
    require_admin(authorization)
    if not cloud_db.set_token_limit(user_id, req.weekly_token_limit):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True, **cloud_db.get_ai_usage(user_id)}


@router.post("/users/{user_id}/password")
async def user_password(
    user_id: str, req: PasswordReset, authorization: str | None = Header(default=None)
) -> dict:
    require_admin(authorization)
    password = req.password.strip() or _gen_password()
    if len(password) < 6:
        raise HTTPException(status_code=422, detail="Password must be at least 6 characters")
    if not cloud_db.admin_reset_password(user_id, password):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True, "password": password}


@router.delete("/users/{user_id}")
async def user_delete(
    user_id: str, authorization: str | None = Header(default=None)
) -> dict:
    admin = require_admin(authorization)
    if user_id == admin["id"]:
        raise HTTPException(status_code=422, detail="Cannot delete your own admin account")
    if not cloud_db.admin_delete_user(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    return {"ok": True}
