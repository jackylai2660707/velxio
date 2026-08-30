"""Smoke tests for the Exam Studio AI generation boundary.

Provider traffic is mocked: these tests exercise authentication, request
limits, the stable response contract, and the fact that no assignment is
created by generation itself.
"""

from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="velxio-exam-generation-test-")
os.environ["VELXIO_DATA_DIR"] = _tmp

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.routes import auth as auth_routes  # noqa: E402
from app.api.routes import lms as lms_routes  # noqa: E402
from app.services import ai_exam_generation, cloud_db  # noqa: E402

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
    teacher = register("exam-teacher@class.test", "teacher")
    student = register("exam-student@class.test")
    teacher_headers = header(teacher["token"])
    student_headers = header(student["token"])

    original = ai_exam_generation.generate_questions
    calls: list[dict] = []

    async def fake_generate_questions(**kwargs):
        calls.append(kwargs)
        return {
            "questions": [
                {
                    "id": "q-1",
                    "type": "single",
                    "question": "Which pin is digital?",
                    "options": ["D2", "GND"],
                    "answer": 0,
                    "points": 10,
                    "rubric": "Recognizes a GPIO pin.",
                    "explanation": "D2 is a digital GPIO pin.",
                }
            ],
            "count": 1,
            "difficulty": kwargs["difficulty"],
            "language": kwargs["language"],
            "question_types": kwargs["question_types"],
            "model": "test-model",
            "usage_tokens": 12,
        }

    ai_exam_generation.generate_questions = fake_generate_questions
    try:
        denied = client.post(
            "/api/lms/exam-studio/generate",
            json={"topic": "GPIO", "count": 1},
            headers=student_headers,
        )
        assert denied.status_code == 403, denied.text

        invalid = client.post(
            "/api/lms/exam-studio/generate",
            json={"topic": "", "count": 1},
            headers=teacher_headers,
        )
        assert invalid.status_code == 422, invalid.text

        response = client.post(
            "/api/lms/exam-studio/generate",
            json={
                "topic": "Arduino button and LED",
                "context": "Use a breadboard and INPUT_PULLUP.",
                "count": 1,
                "difficulty": "easy",
                "language": "bilingual",
                "question_types": ["single"],
                "points_per_question": 10,
            },
            headers=teacher_headers,
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["count"] == 1
        assert body["questions"][0]["answer"] == 0
        assert calls == [
            {
                "topic": "Arduino button and LED",
                "context": "Use a breadboard and INPUT_PULLUP.",
                "count": 1,
                "difficulty": "easy",
                "language": "bilingual",
                "question_types": ["single"],
                "points_per_question": 10,
            }
        ]

        alias = client.post(
            "/api/lms/exams/generate",
            json={"topic": "GPIO", "count": 1, "question_types": ["single"]},
            headers=teacher_headers,
        )
        assert alias.status_code == 200, alias.text
        # Generation is a draft-only operation; no assignment exists yet.
        assert client.get("/api/lms/assignments", headers=teacher_headers).json()["assignments"] == []
    finally:
        ai_exam_generation.generate_questions = original

    print("ALL EXAM GENERATION CHECKS PASSED")


if __name__ == "__main__":
    main()
