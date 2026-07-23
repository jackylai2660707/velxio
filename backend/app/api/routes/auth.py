"""
Account endpoints for the self-contained OSS cloud (see services/cloud_db.py).

POST /api/auth/register  {email, password, name?} → {token, user}
POST /api/auth/login     {email, password}        → {token, user}
GET  /api/auth/me        (Authorization: Bearer)  → {user}

Sessions are stateless HMAC tokens; "logout" is the client discarding its
token. Rate limiting is intentionally omitted — this targets self-hosted
single-user / classroom instances behind your own network. Add a reverse
proxy limiter before exposing it publicly.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from app.core import ratelimit
from app.services import cloud_db

router = APIRouter()

cloud_db.init_db()
# Bootstrap the admin account from VELXIO_ADMIN_EMAIL/PASSWORD (no-op when unset).
cloud_db.ensure_admin_from_env()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate(request: Request, bucket: str, limit: int, window: float) -> None:
    if not ratelimit.allow(f"{bucket}:{_client_ip(request)}", limit, window):
        raise HTTPException(status_code=429, detail="Too many attempts — try again later")


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str = ""
    # LMS: 'student' (default) or 'teacher'. When the instance sets
    # VELXIO_TEACHER_CODE, registering as a teacher requires that code —
    # so a school deployment can hand it only to staff.
    role: str = "student"
    teacher_code: str = ""


class LoginRequest(BaseModel):
    email: str
    password: str


def require_user(authorization: str | None) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not signed in")
    user_id = cloud_db.verify_token(authorization[7:].strip())
    if not user_id:
        raise HTTPException(status_code=401, detail="Session expired — sign in again")
    user = cloud_db.get_user(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Account no longer exists")
    return user


@router.post("/register")
async def register(req: RegisterRequest, request: Request) -> dict:
    _check_rate(request, "register", limit=10, window=600)
    settings = cloud_db.get_settings()
    if not settings["allow_registration"]:
        raise HTTPException(
            status_code=403,
            detail="此平台未開放自助註冊,帳號由管理員發放 — 請向老師或管理員索取。",
        )
    email = req.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Invalid email address")
    if len(req.password) < 6:
        raise HTTPException(status_code=422, detail="Password must be at least 6 characters")
    name = req.name.strip() or email.split("@")[0]
    role = req.role if req.role in ("student", "teacher") else "student"
    if role == "teacher":
        required = str(settings["teacher_code"] or "")
        if required and req.teacher_code.strip() != required:
            raise HTTPException(status_code=403, detail="Wrong teacher registration code")
    user = cloud_db.create_user(email, req.password, name[:50], role=role)
    if user is None:
        raise HTTPException(status_code=409, detail="This email is already registered")
    return {"token": cloud_db.make_token(user["id"]), "user": user}


@router.post("/login")
async def login(req: LoginRequest, request: Request) -> dict:
    _check_rate(request, "login", limit=10, window=60)
    user = cloud_db.authenticate(req.email.strip(), req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Wrong email or password")
    return {"token": cloud_db.make_token(user["id"]), "user": user}


@router.get("/me")
async def me(authorization: str | None = Header(default=None)) -> dict:
    return {"user": require_user(authorization)}


@router.get("/usage")
async def usage(authorization: str | None = Header(default=None)) -> dict:
    """The signed-in user's current-week AI token usage and limit."""
    user = require_user(authorization)
    return cloud_db.get_ai_usage(user["id"])
