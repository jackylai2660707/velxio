"""Timed assignment windows and append-only submission history."""

from __future__ import annotations

import importlib
import time

import pytest


@pytest.fixture()
def lms_client(tmp_path, monkeypatch):
    monkeypatch.setenv("VELXIO_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VELXIO_TEACHER_CODE", "TIMED2026")
    from app.services import cloud_db
    from app.api.routes import auth, lms

    importlib.reload(cloud_db)
    importlib.reload(auth)
    importlib.reload(lms)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(auth.router, prefix="/api/auth")
    app.include_router(lms.router, prefix="/api/lms")
    cloud_db.init_db()
    return TestClient(app)


def _register(client, email: str, role: str = "student") -> dict:
    response = client.post(
        "/api/auth/register",
        json={
            "email": email,
            "password": "secret123",
            "name": email.split("@")[0],
            "role": role,
            "teacher_code": "TIMED2026",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _headers(user: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {user['token']}"}


def test_timed_attempt_lifecycle_and_history(lms_client):
    teacher = _register(lms_client, "teacher@timed.example", "teacher")
    student = _register(lms_client, "student@timed.example")
    teacher_headers = _headers(teacher)
    student_headers = _headers(student)

    klass = lms_client.post(
        "/api/lms/classes", json={"name": "Timed class"}, headers=teacher_headers
    )
    assert klass.status_code == 200, klass.text
    class_data = klass.json()
    assert lms_client.post(
        "/api/lms/classes/join",
        json={"code": class_data["code"]},
        headers=student_headers,
    ).status_code == 200

    now = time.time()
    assignment = lms_client.post(
        f"/api/lms/classes/{class_data['id']}/assignments",
        json={
            "title": "Exam",
            "status": "published",
            "publish": True,
            "opens_at": now - 1,
            "closes_at": now + 120,
            "time_limit": 60,
            "max_attempts": 2,
        },
        headers=teacher_headers,
    )
    assert assignment.status_code == 200, assignment.text
    exam = assignment.json()["assignment"]
    assert exam["opens_at"] < exam["closes_at"]
    assert exam["time_limit"] == 60
    assert exam["max_attempts"] == 2

    aid = exam["id"]
    empty = lms_client.get(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert empty.status_code == 200 and empty.json()["attempts"] == []

    started = lms_client.post(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert started.status_code == 200, started.text
    attempt = started.json()["attempt"]
    assert attempt["status"] == "in_progress"
    assert attempt["expires_at"] > attempt["started_at"]

    saved = lms_client.patch(
        f"/api/lms/attempts/{attempt['id']}",
        json={"content": "draft answer"},
        headers=student_headers,
    )
    assert saved.status_code == 200, saved.text
    submitted = lms_client.post(
        f"/api/lms/attempts/{attempt['id']}/submit",
        json={"content": "final answer"},
        headers=student_headers,
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["submission"]["attempt_no"] == 1

    history = lms_client.get(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert [row["attempt_no"] for row in history.json()["attempts"]] == [1]

    # A retry gets a fresh timer and appends attempt #2; the third start is
    # rejected by the server even if the client manipulates its clock.
    retry = lms_client.post(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert retry.status_code == 200, retry.text
    retry_id = retry.json()["attempt"]["id"]
    assert lms_client.post(
        f"/api/lms/attempts/{retry_id}/submit",
        json={"content": "improved answer"},
        headers=student_headers,
    ).status_code == 200
    blocked = lms_client.post(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert blocked.status_code == 409, blocked.text

    final_history = lms_client.get(
        f"/api/lms/assignments/{aid}/attempts", headers=student_headers
    )
    assert [row["attempt_no"] for row in final_history.json()["attempts"]] == [1, 2]


def test_assignment_window_and_late_policy(lms_client):
    teacher = _register(lms_client, "teacher-window@timed.example", "teacher")
    student = _register(lms_client, "student-window@timed.example")
    th, sh = _headers(teacher), _headers(student)
    klass = lms_client.post("/api/lms/classes", json={"name": "Window"}, headers=th).json()
    assert lms_client.post(
        "/api/lms/classes/join", json={"code": klass["code"]}, headers=sh
    ).status_code == 200
    now = time.time()

    before = lms_client.post(
        f"/api/lms/classes/{klass['id']}/assignments",
        json={"title": "Not yet", "status": "published", "opens_at": now + 600},
        headers=th,
    ).json()["id"]
    assert lms_client.post(
        f"/api/lms/assignments/{before}/submissions", json={"content": "x"}, headers=sh
    ).status_code == 409

    closed = lms_client.post(
        f"/api/lms/classes/{klass['id']}/assignments",
        json={"title": "Closed", "status": "published", "closes_at": now - 1},
        headers=th,
    ).json()["id"]
    assert lms_client.post(
        f"/api/lms/assignments/{closed}/submissions", json={"content": "x"}, headers=sh
    ).status_code == 409

    late = lms_client.post(
        f"/api/lms/classes/{klass['id']}/assignments",
        json={
            "title": "Late allowed",
            "status": "published",
            "closes_at": now - 1,
            "late_policy": "allow",
        },
        headers=th,
    ).json()["id"]
    result = lms_client.post(
        f"/api/lms/assignments/{late}/submissions", json={"content": "x"}, headers=sh
    )
    assert result.status_code == 200 and result.json()["submission"]["is_late"] is True
