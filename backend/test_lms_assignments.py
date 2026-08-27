"""End-to-end smoke test for classroom assignments.

The script intentionally uses a throwaway SQLite directory, like
``test_lms.py``.  It covers the safety boundary that matters in class:
students only see published work, submissions are scoped to class membership,
quiz work is graded server-side, and teachers can review/grade project work.

    docker run --rm -v "$PWD/backend:/mnt/backend" -w /mnt/backend deploy-app \
      python test_lms_assignments.py
"""

from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="velxio-assignment-test-")
os.environ["VELXIO_DATA_DIR"] = _tmp

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes import auth as auth_routes  # noqa: E402
from app.api.routes import lms as lms_routes  # noqa: E402
from app.services import cloud_db  # noqa: E402

app = FastAPI()
app.include_router(auth_routes.router, prefix="/api/auth")
app.include_router(lms_routes.router, prefix="/api/lms")
client = TestClient(app)


def register(email: str, role: str = "student") -> dict:
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "secret123", "name": email.split("@")[0], "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def main() -> None:
    cloud_db.init_db()
    teacher = register("teacher@class.test", "teacher")
    student = register("student@class.test")
    outsider = register("outsider@class.test")
    th, st, out = (header(teacher["token"]), header(student["token"]), header(outsider["token"]))

    klass = client.post("/api/lms/classes", json={"name": "IoT 101"}, headers=th)
    assert klass.status_code == 200, klass.text
    class_id = klass.json()["id"]
    code = klass.json()["code"]
    assert client.post("/api/lms/classes/join", json={"code": code}, headers=st).status_code == 200

    draft = client.post(
        f"/api/lms/classes/{class_id}/assignments",
        json={
            "title": "LED project",
            "description": "Build a safe LED circuit",
            "instructions": "Submit the .vlx project and explain your resistor choice.",
            "assignment_type": "project",
            "max_score": 20,
        },
        headers=th,
    )
    assert draft.status_code == 200, draft.text
    assignment = draft.json()["assignment"]
    aid = assignment["id"]
    assert assignment["status"] == "draft"
    assert client.get(f"/api/lms/assignments/{aid}", headers=st).status_code == 404
    assert client.get(f"/api/lms/classes/{class_id}/assignments", headers=out).status_code == 403

    published = client.post(f"/api/lms/assignments/{aid}/publish", headers=th)
    assert published.status_code == 200, published.text
    assert published.json()["assignment"]["status"] == "published"
    student_list = client.get(f"/api/lms/classes/{class_id}/assignments", headers=st)
    assert student_list.status_code == 200
    student_assignment = student_list.json()["assignments"][0]
    assert student_assignment["submission"] is None

    submission = client.post(
        f"/api/lms/assignments/{aid}/submissions",
        json={"project_data": {"components": [], "wires": []}, "content": "LED works"},
        headers=st,
    )
    assert submission.status_code == 200, submission.text
    sid = submission.json()["submission"]["id"]
    assert submission.json()["submission"]["status"] == "submitted"
    reviewed = client.get(f"/api/lms/assignments/{aid}/submissions", headers=th)
    assert reviewed.status_code == 200
    assert len(reviewed.json()["submissions"]) == 1
    graded = client.patch(
        f"/api/lms/submissions/{sid}/grade",
        json={"score": 18, "feedback": "Good circuit; add a wiring note."},
        headers=th,
    )
    assert graded.status_code == 200, graded.text
    assert graded.json()["submission"]["score"] == 18
    assert client.get(f"/api/lms/assignments/{aid}/submission", headers=st).json()["submission"]["status"] == "graded"

    quiz = client.post(
        f"/api/lms/classes/{class_id}/assignments",
        json={
            "title": "GPIO check",
            "assignment_type": "quiz",
            "max_score": 10,
            "auto_grade": True,
            "quiz": {
                "questions": [
                    {"id": "q1", "question": "High output?", "options": ["LOW", "HIGH"], "answer": 1},
                    {"id": "q2", "question": "PWM?", "options": ["analogWrite", "digitalRead"], "answer": 0},
                ]
            },
        },
        headers=th,
    )
    assert quiz.status_code == 200, quiz.text
    qid = quiz.json()["id"]
    assert client.post(f"/api/lms/assignments/{qid}/publish", headers=th).status_code == 200
    qsubmit = client.post(
        f"/api/lms/assignments/{qid}/submissions",
        json={"answers": {"q1": 1, "q2": 1}},
        headers=st,
    )
    assert qsubmit.status_code == 200, qsubmit.text
    qrow = qsubmit.json()["submission"]
    assert qsubmit.json()["auto_graded"] is True
    assert qrow["score"] == 5
    assert qrow["status"] == "graded"
    visible = client.get(f"/api/lms/assignments/{qid}", headers=st).json()["assignment"]
    assert visible["quiz"]["questions"][0].get("answer") is None

    print("ALL ASSIGNMENT CHECKS PASSED")


if __name__ == "__main__":
    main()
