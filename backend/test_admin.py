"""
Self-contained test for the admin/quota layer (cloud_db + /api/admin +
/api/auth usage/rate-limit + /api/agent quota gate).

Throwaway SQLite in a temp dir; routes exercised in-process. Run:

    cd backend && python3 test_admin.py
"""

from __future__ import annotations

import os
import sys
import tempfile

_tmp = tempfile.mkdtemp(prefix="velxio-admin-test-")
os.environ["VELXIO_DATA_DIR"] = _tmp
os.environ["VELXIO_ADMIN_EMAIL"] = "boss@ailab.test"
os.environ["VELXIO_ADMIN_PASSWORD"] = "BossPass123"
os.environ["VELXIO_DEFAULT_WEEKLY_TOKENS"] = "1000"
# Server key present → /api/agent/stream is metered for signed-in users.
os.environ["VELXIO_OPENAI_API_KEY"] = "sk-test-server-key"
os.environ["VELXIO_OPENAI_BASE_URL"] = "http://127.0.0.1:9/v1"  # never reached

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes import admin as admin_routes  # noqa: E402
from app.api.routes import agent as agent_routes  # noqa: E402
from app.api.routes import auth as auth_routes  # noqa: E402
from app.core import ratelimit  # noqa: E402
from app.services import cloud_db  # noqa: E402

app = FastAPI()
app.include_router(auth_routes.router, prefix="/api/auth")
app.include_router(admin_routes.router, prefix="/api/admin")
app.include_router(agent_routes.router, prefix="/api/agent")
client = TestClient(app)

PASSED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED
    mark = "\x1b[32m✓\x1b[0m" if cond else "\x1b[31m✗\x1b[0m"
    print(f"  {mark} {name}" + (f"  — {detail}" if detail and not cond else ""))
    if cond:
        PASSED += 1
    else:
        sys.exit(1)


def hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def main() -> None:
    print(f"DB: {cloud_db.DB_PATH}")

    print("\n── Admin bootstrap ──")
    r = client.post(
        "/api/auth/login", json={"email": "boss@ailab.test", "password": "BossPass123"}
    )
    check("admin login (env bootstrap)", r.status_code == 200, r.text)
    admin_tok = r.json()["token"]
    check("bootstrap role is admin", r.json()["user"]["role"] == "admin")

    r = client.post(
        "/api/auth/register",
        json={"email": "sneaky@x.tw", "password": "secret123", "role": "admin"},
    )
    check(
        "public register cannot claim admin",
        r.status_code == 200 and r.json()["user"]["role"] == "student",
    )

    print("\n── Batch account creation ──")
    # a teacher + a class to auto-join
    t = client.post(
        "/api/admin/users/batch",
        json={"role": "teacher", "count": 1, "prefix": "teach", "name_prefix": "老師"},
        headers=hdr(admin_tok),
    ).json()
    check("teacher batch created", len(t["created"]) == 1, str(t))
    t_login = client.post(
        "/api/auth/login",
        json={"email": t["created"][0]["email"], "password": t["created"][0]["password"]},
    )
    check("generated teacher can log in", t_login.status_code == 200)
    check("generated teacher role", t_login.json()["user"]["role"] == "teacher")
    cls = client.post(
        "/api/lms/classes", json={"name": "七年級"}, headers=hdr(t_login.json()["token"])
    ) if False else None  # lms router not mounted here; join via db directly
    cls = cloud_db.create_class(t_login.json()["user"]["id"], "七年級")

    s = client.post(
        "/api/admin/users/batch",
        json={
            "role": "student",
            "count": 5,
            "prefix": "stu",
            "name_prefix": "學生",
            "class_code": cls["code"],
            "weekly_token_limit": 500,
        },
        headers=hdr(admin_tok),
    ).json()
    check("5 students created", len(s["created"]) == 5, str(s))
    check("students auto-joined class", s["joined_class"] == 5, str(s))
    check("passwords look generated", all(len(c["password"]) == 10 for c in s["created"]))

    dup = client.post(
        "/api/admin/users/batch",
        json={"role": "student", "count": 2, "prefix": "stu", "name_prefix": "學生"},
        headers=hdr(admin_tok),
    ).json()
    check("existing emails skipped, never overwritten", len(dup["skipped"]) == 2, str(dup))

    r = client.post(
        "/api/admin/users/batch",
        json={"role": "student", "count": 1, "prefix": "x"},
        headers=hdr(t_login.json()["token"]),
    )
    check("teacher cannot use admin API", r.status_code == 403)

    print("\n── Quotas & usage ──")
    stu_email = s["created"][0]["email"]
    stu_login = client.post(
        "/api/auth/login", json={"email": stu_email, "password": s["created"][0]["password"]}
    ).json()
    stu_tok, stu_id = stu_login["token"], stu_login["user"]["id"]

    u = client.get("/api/auth/usage", headers=hdr(stu_tok)).json()
    check("student sees own usage + custom limit 500", u["used"] == 0 and u["limit"] == 500, str(u))

    cloud_db.add_ai_usage(stu_id, 123)
    cloud_db.add_ai_usage(stu_id, 77)
    u = client.get("/api/auth/usage", headers=hdr(stu_tok)).json()
    check("usage accumulates within the week", u["used"] == 200, str(u))
    check("week_start is a Monday", cloud_db.week_start() == u["week_start"])

    lst = client.get("/api/admin/users?query=stu1", headers=hdr(admin_tok)).json()
    row = next(x for x in lst["users"] if x["email"] == stu_email)
    check("admin list shows per-user usage", row["used_this_week"] == 200, str(row))

    ov = client.get("/api/admin/overview", headers=hdr(admin_tok)).json()
    check("overview aggregates week tokens", ov["week_tokens"] >= 200, str(ov))

    r = client.post(
        f"/api/admin/users/{stu_id}/quota",
        json={"weekly_token_limit": 150},
        headers=hdr(admin_tok),
    )
    check("admin lowers quota", r.status_code == 200 and r.json()["limit"] == 150)

    print("\n── Agent quota gate ──")
    stream_req = {"system": "s", "messages": [], "tools": []}
    r = client.post("/api/agent/stream", json=stream_req)
    check("anonymous cannot use server key", r.status_code == 401, r.text)
    r = client.post("/api/agent/stream", json=stream_req, headers=hdr(stu_tok))
    check("over-quota student gets 429", r.status_code == 429, r.text[:120])
    r = client.post(
        f"/api/admin/users/{stu_id}/quota",
        json={"weekly_token_limit": 100000},
        headers=hdr(admin_tok),
    )
    r = client.post("/api/agent/stream", json=stream_req, headers=hdr(stu_tok))
    # Under quota the gate passes; the request then proceeds to the (dead)
    # upstream and fails INSIDE the stream, not with 401/429.
    check("under-quota student passes the gate", r.status_code == 200, r.text[:120])
    check("upstream failure surfaced in-stream", "velxio_error" in r.text)
    r = client.post(
        "/api/agent/stream", json=stream_req, headers={"x-agent-key": "sk-own-key"}
    )
    check("own-key user is unmetered (no 401/429)", r.status_code == 200)

    print("\n── Password reset & delete ──")
    r = client.post(
        f"/api/admin/users/{stu_id}/password", json={}, headers=hdr(admin_tok)
    )
    newpw = r.json()["password"]
    check("admin resets password (generated)", r.status_code == 200 and len(newpw) >= 6)
    r = client.post("/api/auth/login", json={"email": stu_email, "password": newpw})
    check("student logs in with new password", r.status_code == 200)

    admin_id = client.get("/api/auth/me", headers=hdr(admin_tok)).json()["user"]["id"]
    r = client.delete(f"/api/admin/users/{admin_id}", headers=hdr(admin_tok))
    check("admin cannot delete self", r.status_code == 422)
    r = client.delete(f"/api/admin/users/{stu_id}", headers=hdr(admin_tok))
    check("admin deletes a user", r.status_code == 200)

    print("\n── Platform settings ──")
    s0 = client.get("/api/admin/settings", headers=hdr(admin_tok)).json()
    check("settings default model gpt-5.6-luna", s0["ai_model"] == "gpt-5.6-luna", str(s0))
    check("settings default effort high", s0["ai_effort"] == "high")

    r = client.put(
        "/api/admin/settings",
        json={
            "ai_model": "gpt-5.6-terra",
            "ai_effort": "medium",
            "student_weekly_tokens": 700,
            "allow_registration": False,
            "teacher_code": "TCODE9",
            "allow_own_key": False,
        },
        headers=hdr(admin_tok),
    )
    check("admin updates settings", r.status_code == 200 and r.json()["ai_model"] == "gpt-5.6-terra")

    cfg = client.get("/api/agent/config").json()
    check("agent config reflects settings", cfg["model"] == "gpt-5.6-terra" and cfg["effort"] == "medium", str(cfg))
    check("agent config exposes gating flags", cfg["allow_custom_model"] is False and cfg["allow_own_key"] is False)

    r = client.post(
        "/api/auth/register", json={"email": "walkin@x.tw", "password": "secret123"}
    )
    check("registration closed → 403", r.status_code == 403, r.text)

    # BYOK disabled → header key ignored → anonymous still 401 (metered path)
    r = client.post(
        "/api/agent/stream",
        json={"system": "s", "messages": [], "tools": []},
        headers={"x-agent-key": "sk-own"},
    )
    check("BYOK off: own key no longer bypasses metering", r.status_code == 401, r.text[:100])

    # role-based default limit: a fresh teacher (no override) uses teacher default
    t2 = client.post(
        "/api/admin/users/batch",
        json={"role": "teacher", "count": 1, "prefix": "teach2", "name_prefix": "老師"},
        headers=hdr(admin_tok),
    ).json()
    t2_login = client.post(
        "/api/auth/login",
        json={"email": t2["created"][0]["email"], "password": t2["created"][0]["password"]},
    ).json()
    u2 = client.get("/api/auth/usage", headers=hdr(t2_login["token"])).json()
    check(
        "teacher default limit from settings",
        u2["limit"] == s0["teacher_weekly_tokens"],
        str(u2),
    )

    r = client.put(
        "/api/admin/settings",
        json={"allow_registration": True, "allow_own_key": True},
        headers=hdr(admin_tok),
    )
    check("settings restored", r.status_code == 200)

    print("\n── Login rate limit ──")
    ratelimit.reset()
    codes = [
        client.post(
            "/api/auth/login", json={"email": "nobody@x.tw", "password": "wrong!!"}
        ).status_code
        for _ in range(12)
    ]
    check("11th+ rapid login attempt → 429", codes[-1] == 429, str(codes))

    print(f"\n\x1b[32mALL {PASSED} CHECKS PASSED\x1b[0m")


if __name__ == "__main__":
    main()
