"""
Self-contained test for the LMS layer (cloud_db + /api/auth + /api/lms).

Runs against a THROWAWAY SQLite database in a temp dir — your real
backend/data/velxio-cloud.db is never touched. No server needed; routes
are exercised in-process with FastAPI's TestClient.

    cd backend && python test_lms.py
"""

from __future__ import annotations

import os
import sys
import tempfile

# Point cloud_db at a throwaway data dir BEFORE importing the app.
_tmp = tempfile.mkdtemp(prefix="velxio-lms-test-")
os.environ["VELXIO_DATA_DIR"] = _tmp
os.environ["VELXIO_TEACHER_CODE"] = "SCHOOL2026"

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes import auth as auth_routes  # noqa: E402
from app.api.routes import lms as lms_routes  # noqa: E402
from app.services import cloud_db  # noqa: E402

app = FastAPI()
app.include_router(auth_routes.router, prefix="/api/auth")
app.include_router(lms_routes.router, prefix="/api/lms")
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


def register(email: str, role: str = "student", teacher_code: str = "") -> dict:
    r = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "secret123",
            "name": email.split("@")[0],
            "role": role,
            "teacher_code": teacher_code,
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def main() -> None:
    cloud_db.init_db()
    print(f"DB: {cloud_db.DB_PATH}")

    print("\n── Registration & roles ──")
    teacher = register("teacher@school.tw", role="teacher", teacher_code="SCHOOL2026")
    check("teacher registers with correct code", teacher["user"]["role"] == "teacher")

    bad = client.post(
        "/api/auth/register",
        json={"email": "fake@x.tw", "password": "secret123", "role": "teacher"},
    )
    check("teacher registration rejected without code", bad.status_code == 403)

    s1 = register("amy@student.tw")
    s2 = register("ben@student.tw")
    check("student default role", s1["user"]["role"] == "student")

    me = client.get("/api/auth/me", headers=hdr(teacher["token"])).json()
    check("/me returns role", me["user"]["role"] == "teacher")

    print("\n── Classes ──")
    r = client.post(
        "/api/lms/classes", json={"name": "八年級甲班"}, headers=hdr(teacher["token"])
    )
    check("teacher creates class", r.status_code == 200, r.text)
    cls = r.json()
    check("class code shape", len(cls["code"]) == cloud_db.CLASS_CODE_LENGTH)

    r = client.post("/api/lms/classes", json={"name": "x"}, headers=hdr(s1["token"]))
    check("student cannot create class", r.status_code == 403)

    r = client.post(
        "/api/lms/classes/join", json={"code": cls["code"].lower()}, headers=hdr(s1["token"])
    )
    check("student joins by (case-insensitive) code", r.status_code == 200, r.text)
    r2 = client.post(
        "/api/lms/classes/join", json={"code": cls["code"]}, headers=hdr(s2["token"])
    )
    check("second student joins", r2.status_code == 200)
    r3 = client.post(
        "/api/lms/classes/join", json={"code": cls["code"]}, headers=hdr(s1["token"])
    )
    check("re-join is idempotent", r3.status_code == 200)
    r4 = client.post(
        "/api/lms/classes/join", json={"code": "ZZZZZZ"}, headers=hdr(s1["token"])
    )
    check("unknown code → 404", r4.status_code == 404)

    lst = client.get("/api/lms/classes", headers=hdr(teacher["token"])).json()
    check(
        "teacher list shows member_count=2",
        lst["teaching"][0]["member_count"] == 2,
        str(lst),
    )
    lst_s = client.get("/api/lms/classes", headers=hdr(s1["token"])).json()
    check("student list shows joined class", lst_s["joined"][0]["name"] == "八年級甲班")

    print("\n── Progress & quizzes ──")
    for lesson in ("arduino-basics/blink", "arduino-basics/button"):
        r = client.post(
            "/api/lms/progress", json={"lesson_id": lesson}, headers=hdr(s1["token"])
        )
        assert r.status_code == 200
    client.post(
        "/api/lms/quiz",
        json={
            "lesson_id": "arduino-basics/blink",
            "score": 2,
            "total": 3,
            "answers": [0, 2, 1],
        },
        headers=hdr(s1["token"]),
    )
    client.post(
        "/api/lms/quiz",
        json={
            "lesson_id": "arduino-basics/blink",
            "score": 3,
            "total": 3,
            "answers": [0, 1, 1],
        },
        headers=hdr(s1["token"]),
    )
    prog = client.get("/api/lms/progress", headers=hdr(s1["token"])).json()
    check("progress lists 2 lessons", sorted(prog["done"]) == [
        "arduino-basics/blink",
        "arduino-basics/button",
    ])
    check(
        "quiz best keeps max score + attempt count",
        prog["quiz"]["arduino-basics/blink"] == {"best_score": 3, "total": 3, "attempts": 2},
        str(prog["quiz"]),
    )

    r = client.post(
        "/api/lms/progress",
        json={"lesson_id": "arduino-basics/button", "status": "reset"},
        headers=hdr(s1["token"]),
    )
    prog = client.get("/api/lms/progress", headers=hdr(s1["token"])).json()
    check("reset removes progress", prog["done"] == ["arduino-basics/blink"])

    bad_quiz = client.post(
        "/api/lms/quiz",
        json={"lesson_id": "x", "score": 5, "total": 3, "answers": []},
        headers=hdr(s1["token"]),
    )
    check("score > total rejected", bad_quiz.status_code == 422)

    print("\n── Teacher report ──")
    rep = client.get(
        f"/api/lms/classes/{cls['id']}/report", headers=hdr(teacher["token"])
    ).json()
    amy = next(m for m in rep["members"] if m["email"] == "amy@student.tw")
    check("report has both members", len(rep["members"]) == 2)
    check("report carries progress", amy["progress"] == ["arduino-basics/blink"])
    check(
        "report carries quiz best",
        amy["quiz"]["arduino-basics/blink"]["best_score"] == 3,
    )
    r = client.get(
        f"/api/lms/classes/{cls['id']}/report", headers=hdr(s1["token"])
    )
    check("student cannot read report", r.status_code == 403)

    other_teacher = register("other@school.tw", role="teacher", teacher_code="SCHOOL2026")
    r = client.get(
        f"/api/lms/classes/{cls['id']}/report", headers=hdr(other_teacher["token"])
    )
    check("other teacher cannot read report", r.status_code == 404)

    r = client.delete(
        f"/api/lms/classes/{cls['id']}", headers=hdr(teacher["token"])
    )
    check("teacher deletes class", r.status_code == 200)

    print(f"\n\x1b[32mALL {PASSED} CHECKS PASSED\x1b[0m")


if __name__ == "__main__":
    main()
