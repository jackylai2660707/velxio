"""Teacher multi-class dashboard and CSV export smoke test.

Run with the backend image (the host checkout intentionally does not require
FastAPI):

    docker run --rm -v "$PWD/backend:/mnt/backend" -w /mnt/backend deploy-app \
      python test_lms_teacher_dashboard.py
"""

from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="velxio-teacher-dashboard-test-")
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
    teacher = register("dashboard-teacher@class.test", "teacher")
    one = register("alpha@student.test")
    two = register("beta@student.test")
    other_teacher = register("other-teacher@class.test", "teacher")
    th = header(teacher["token"])
    h1 = header(one["token"])
    h2 = header(two["token"])
    oth = header(other_teacher["token"])

    first = client.post("/api/lms/classes", json={"name": "Alpha class"}, headers=th)
    second = client.post("/api/lms/classes", json={"name": "Beta class"}, headers=th)
    assert first.status_code == second.status_code == 200
    first_class, second_class = first.json(), second.json()
    assert client.post("/api/lms/classes/join", json={"code": first_class["code"]}, headers=h1).status_code == 200
    assert client.post("/api/lms/classes/join", json={"code": first_class["code"]}, headers=h2).status_code == 200
    assert client.post("/api/lms/classes/join", json={"code": second_class["code"]}, headers=h1).status_code == 200

    assignment = client.post(
        f"/api/lms/classes/{first_class['id']}/assignments",
        json={
            "title": "Formula-safe LED build",
            "assignment_type": "project",
            "max_score": 20,
            "status": "published",
            "publish": True,
        },
        headers=th,
    )
    assert assignment.status_code == 200, assignment.text
    aid = assignment.json()["id"]
    submitted = client.post(
        f"/api/lms/assignments/{aid}/submissions",
        json={"content": "=HYPERLINK(\"https://bad.example\")"},
        headers=h1,
    )
    assert submitted.status_code == 200, submitted.text

    dashboard = client.get("/api/lms/teacher/dashboard", headers=th)
    assert dashboard.status_code == 200, dashboard.text
    report = dashboard.json()
    assert {item["id"] for item in report["classes"]} == {first_class["id"], second_class["id"]}
    assert report["summary"]["class_count"] == 2
    assert report["summary"]["submission_count"] == 1
    assert report["summary"]["missing_count"] == 1
    assert {item["status"] for item in report["rows"]} == {"submitted", "missing"}
    assert len(report["rows"]) == len(report["submissions"])

    missing = client.get(
        "/api/lms/teacher/dashboard?status=missing&q=beta", headers=th
    )
    assert missing.status_code == 200
    assert [item["student_email"] for item in missing.json()["rows"]] == ["beta@student.test"]
    selected = client.get(
        f"/api/lms/teacher/dashboard?class_ids={second_class['id']}", headers=th
    )
    assert selected.status_code == 200
    assert selected.json()["total"] == 0

    exported = client.get(
        f"/api/lms/teacher/export.csv?class_ids={first_class['id']}", headers=th
    )
    assert exported.status_code == 200, exported.text
    assert exported.headers["content-type"].startswith("text/csv")
    assert "attachment" in exported.headers.get("content-disposition", "")
    assert exported.content.startswith(b"\xef\xbb\xbf")
    # Export omits private submission content by design, but still emits the
    # stable metadata columns and both roster rows.
    csv_text = exported.content.decode("utf-8-sig")
    assert "class_id,class_name,assignment_id" in csv_text
    assert "alpha@student.test" in csv_text and "beta@student.test" in csv_text
    assert "=HYPERLINK" not in csv_text

    # Compatibility aliases used by earlier teacher dashboards.
    alias = client.get(
        f"/api/lms/assignments/export.csv?class_id={first_class['id']}", headers=th
    )
    assert alias.status_code == 200 and alias.content.startswith(b"\xef\xbb\xbf")

    # Assignment-scoped JSON exports are roster-complete and carry the fields
    # needed by a gradebook importer, including a zero attempt for missing work.
    second_assignment = client.post(
        f"/api/lms/classes/{first_class['id']}/assignments",
        json={
            "title": "Assignment-only JSON export",
            "assignment_type": "quiz",
            "max_score": 10,
            "status": "published",
            "publish": True,
            "quiz": [{"id": "q1", "question": "1+1?", "options": ["2"], "answer": 0}],
        },
        headers=th,
    )
    assert second_assignment.status_code == 200, second_assignment.text
    second_aid = second_assignment.json()["id"]
    json_export = client.get(
        f"/api/lms/teacher/export.json?class_id={first_class['id']}&assignment_id={second_aid}",
        headers=th,
    )
    assert json_export.status_code == 200, json_export.text
    assert json_export.headers["content-type"].startswith("application/json")
    assert "attachment" in json_export.headers.get("content-disposition", "")
    json_payload = json_export.json()
    assert json_payload["count"] == 2
    assert {row["assignment_id"] for row in json_payload["rows"]} == {second_aid}
    assert {row["student_email"] for row in json_payload["rows"]} == {
        "alpha@student.test", "beta@student.test"
    }
    assert all({"student_name", "status", "score", "submitted_at", "attempt_no"} <= row.keys()
               for row in json_payload["rows"])
    assert all("project_data" not in row and "answers" not in row for row in json_payload["rows"])
    csv_assignment = client.get(
        f"/api/lms/teacher/export.csv?assignment_id={second_aid}", headers=th
    )
    assert csv_assignment.status_code == 200
    assert csv_assignment.content.decode("utf-8-sig").count(second_aid) == 2
    assert client.get("/api/lms/teacher/dashboard", headers=h1).status_code == 403
    assert client.get("/api/lms/teacher/dashboard", headers=oth).status_code == 200
    # Another teacher may view their own empty dashboard but receives no rows
    # from the first teacher's classes.
    assert client.get(
        f"/api/lms/teacher/export.csv?class_ids={first_class['id']}", headers=oth
    ).status_code == 200
    assert "alpha@student.test" not in client.get(
        f"/api/lms/teacher/export.csv?class_ids={first_class['id']}", headers=oth
    ).text

    print("ALL TEACHER DASHBOARD CHECKS PASSED")


if __name__ == "__main__":
    main()
