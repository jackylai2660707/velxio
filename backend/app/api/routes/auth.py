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

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.services import cloud_db

router = APIRouter()

cloud_db.init_db()

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str = ""


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
async def register(req: RegisterRequest) -> dict:
    email = req.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Invalid email address")
    if len(req.password) < 6:
        raise HTTPException(status_code=422, detail="Password must be at least 6 characters")
    name = req.name.strip() or email.split("@")[0]
    user = cloud_db.create_user(email, req.password, name[:50])
    if user is None:
        raise HTTPException(status_code=409, detail="This email is already registered")
    return {"token": cloud_db.make_token(user["id"]), "user": user}


@router.post("/login")
async def login(req: LoginRequest) -> dict:
    user = cloud_db.authenticate(req.email.strip(), req.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Wrong email or password")
    return {"token": cloud_db.make_token(user["id"]), "user": user}


@router.get("/me")
async def me(authorization: str | None = Header(default=None)) -> dict:
    return {"user": require_user(authorization)}
