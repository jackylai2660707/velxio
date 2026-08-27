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

import csv
import io
from datetime import datetime, timezone
import math
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, Field

from app.api.routes.auth import require_user
from app.services import cloud_db

router = APIRouter()

_DASHBOARD_STATUSES = {
    "missing", "not_started", "in_progress", "submitted", "graded", "returned",
    "late", "grading", "expired", "draft",
}


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


# ── Assignment models ─────────────────────────────────────────────────────


class AssignmentCreate(BaseModel):
    title: str
    description: str = ""
    instructions: str = ""
    lesson_id: str | None = None
    # project/code/text/quiz are intentionally open to future course types;
    # the API normalises aliases and rejects unknown values at the edge.
    assignment_type: str = "project"
    project_template: Any = None
    quiz: Any = None
    rubric: Any = None
    due_at: float | str | None = None
    opens_at: float | str | None = None
    closes_at: float | str | None = None
    # Seconds per student attempt; null/0 disables the timer.
    time_limit: int | float | str | None = Field(default=None, ge=0)
    # 0 means unlimited retries.  Positive values cap final submissions.
    max_attempts: int | str | None = Field(default=0, ge=0)
    late_policy: str = "reject"
    max_score: float = Field(default=100, gt=0, le=10000)
    auto_grade: bool = False
    status: str | None = None
    publish: bool = False


class AssignmentUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    instructions: str | None = None
    lesson_id: str | None = None
    assignment_type: str | None = None
    project_template: Any = None
    quiz: Any = None
    rubric: Any = None
    due_at: float | str | None = None
    opens_at: float | str | None = None
    closes_at: float | str | None = None
    time_limit: int | float | str | None = Field(default=None, ge=0)
    max_attempts: int | str | None = Field(default=None, ge=0)
    late_policy: str | None = None
    max_score: float | None = Field(default=None, gt=0, le=10000)
    auto_grade: bool | None = None
    status: str | None = None


class SubmissionCreate(BaseModel):
    # ``answers`` is preferred; singular ``answer`` is accepted for simple
    # text/one-question activities and retained for backwards-compatible
    # classroom templates.
    answers: Any = None
    answer: Any = None
    content: str = ""
    project_data: Any = None
    files: Any = None
    submit: bool = True
    save: bool | None = None
    status: str | None = None


class SubmissionGrade(BaseModel):
    score: float | None = Field(default=None, ge=0)
    feedback: str = ""
    status: str = "graded"


def _require_teacher(authorization: str | None) -> dict:
    user = require_user(authorization)
    if user.get("role") != "teacher":
        raise HTTPException(status_code=403, detail="Teacher account required")
    return user


def _require_staff(authorization: str | None) -> dict:
    user = require_user(authorization)
    if user.get("role") not in ("teacher", "admin"):
        raise HTTPException(status_code=403, detail="Teacher account required")
    return user


def _parse_due_at(value: float | str | None) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise HTTPException(status_code=422, detail="due_at must be a timestamp or ISO date")
    if isinstance(value, (int, float)):
        out = float(value)
    else:
        raw = str(value).strip()
        try:
            out = float(raw)
        except ValueError:
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(status_code=422, detail="due_at must be a timestamp or ISO date")
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            out = parsed.timestamp()
    if not math.isfinite(out) or out < 0:
        raise HTTPException(status_code=422, detail="due_at must be a valid future-compatible timestamp")
    return out


def _parse_window_time(value: float | str | None, field: str) -> float | None:
    """Parse an assignment window boundary using the server's UTC epoch.

    ``due_at`` historically accepted both seconds and ISO-8601 strings; the
    new ``opens_at``/``closes_at`` fields intentionally share that contract.
    Keeping one parser prevents clients from accidentally mixing milliseconds
    and seconds and gives consistent 422 responses.
    """
    try:
        out = _parse_due_at(value)
    except HTTPException as exc:
        raise HTTPException(status_code=exc.status_code, detail=f"{field} must be a timestamp or ISO date")
    return out


def _parse_nonnegative_int(value: Any, field: str, *, maximum: int = 31_536_000) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, bool):
        raise HTTPException(status_code=422, detail=f"{field} must be a non-negative integer")
    try:
        number = float(value)
        if not math.isfinite(number) or number < 0 or number != int(number):
            raise ValueError
        out = int(number)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"{field} must be a non-negative integer")
    if out > maximum:
        raise HTTPException(status_code=422, detail=f"{field} is too large")
    return out


_LATE_POLICY_ALIASES = {
    "deny": "reject",
    "closed": "reject",
    "accept": "allow",
    "accepted": "allow",
    "allow_late": "allow",
    "mark": "flag",
    "mark_late": "flag",
    "penalize": "flag",
}


def _parse_late_policy(value: str | None) -> str:
    policy = str(value or "reject").strip().casefold()
    policy = _LATE_POLICY_ALIASES.get(policy, policy)
    if policy not in ("reject", "allow", "flag"):
        raise HTTPException(status_code=422, detail="late_policy must be reject|allow|flag")
    return policy


_ASSIGNMENT_TYPES = {
    "project", "code", "text", "quiz", "reflection", "mixed", "circuit", "design",
}
_ASSIGNMENT_STATUSES = {"draft", "published", "archived"}


def _normalise_assignment_type(value: str | None) -> str:
    kind = (value or "project").strip().lower()
    aliases = {"homework": "project", "assignment": "project", "essay": "text"}
    kind = aliases.get(kind, kind)
    if kind not in _ASSIGNMENT_TYPES:
        raise HTTPException(
            status_code=422,
            detail="assignment_type must be project|code|text|quiz|reflection|mixed",
        )
    return kind


def _assignment_payload(req: AssignmentCreate) -> dict[str, Any]:
    title = req.title.strip()[:200]
    if not title:
        raise HTTPException(status_code=422, detail="Assignment title required")
    status = (req.status or ("published" if req.publish else "draft")).strip().lower()
    if status not in _ASSIGNMENT_STATUSES:
        raise HTTPException(status_code=422, detail="status must be draft|published|archived")
    due_at = _parse_window_time(req.due_at, "due_at")
    opens_at = _parse_window_time(req.opens_at, "opens_at")
    closes_at = _parse_window_time(req.closes_at, "closes_at")
    # ``due_at`` is a backwards-compatible close boundary.  Explicit
    # ``closes_at`` wins when both are present; otherwise mirror the legacy
    # value so old clients and CSV exports continue to work.
    if closes_at is None:
        closes_at = due_at
    if due_at is None:
        due_at = closes_at
    if opens_at is not None and closes_at is not None and opens_at > closes_at:
        raise HTTPException(status_code=422, detail="opens_at must be before closes_at")
    try:
        time_limit = _parse_nonnegative_int(req.time_limit, "time_limit") if req.time_limit is not None else None
        max_attempts = _parse_nonnegative_int(req.max_attempts, "max_attempts")
    except HTTPException:
        raise
    return {
        "title": title,
        "description": req.description.strip()[:20_000],
        "instructions": req.instructions.strip()[:50_000],
        "lesson_id": req.lesson_id.strip()[:160] if req.lesson_id else None,
        "assignment_type": _normalise_assignment_type(req.assignment_type),
        "project_template": req.project_template,
        "quiz": req.quiz,
        "rubric": req.rubric,
        "due_at": due_at,
        "opens_at": opens_at,
        "closes_at": closes_at,
        "time_limit": time_limit,
        "max_attempts": max_attempts,
        "late_policy": _parse_late_policy(req.late_policy),
        "max_score": float(req.max_score),
        "auto_grade": bool(req.auto_grade),
        "status": status,
    }


def _assignment_patch(req: AssignmentUpdate) -> dict[str, Any]:
    raw = req.model_dump(exclude_unset=True)
    if "title" in raw:
        raw["title"] = (raw["title"] or "").strip()[:200]
        if not raw["title"]:
            raise HTTPException(status_code=422, detail="Assignment title required")
    for key, limit in (("description", 20_000), ("instructions", 50_000), ("lesson_id", 160)):
        if key in raw and raw[key] is not None:
            raw[key] = str(raw[key]).strip()[:limit]
    if "assignment_type" in raw:
        raw["assignment_type"] = _normalise_assignment_type(raw["assignment_type"])
    if "due_at" in raw:
        raw["due_at"] = _parse_window_time(raw["due_at"], "due_at")
    if "opens_at" in raw:
        raw["opens_at"] = _parse_window_time(raw["opens_at"], "opens_at")
    if "closes_at" in raw:
        raw["closes_at"] = _parse_window_time(raw["closes_at"], "closes_at")
    # Mirror a one-sided close patch into the legacy field.  If both are sent,
    # the explicit ``closes_at`` value is authoritative.
    if "closes_at" in raw:
        raw["due_at"] = raw["closes_at"]
    elif "due_at" in raw:
        raw["closes_at"] = raw["due_at"]
    if "time_limit" in raw:
        raw["time_limit"] = _parse_nonnegative_int(raw["time_limit"], "time_limit") if raw["time_limit"] is not None else None
    if "max_attempts" in raw:
        raw["max_attempts"] = _parse_nonnegative_int(raw["max_attempts"], "max_attempts")
    if "late_policy" in raw:
        raw["late_policy"] = _parse_late_policy(raw["late_policy"])
    if "status" in raw:
        raw["status"] = str(raw["status"]).strip().lower()
        if raw["status"] not in _ASSIGNMENT_STATUSES:
            raise HTTPException(status_code=422, detail="status must be draft|published|archived")
    return raw


def _strip_quiz_answers(value: Any) -> Any:
    """Remove answer keys from quiz manifests sent to students.  Teacher
    views retain the original manifest for grading and answer review."""
    private_keys = {
        "answer", "answers", "correct", "correct_answer", "correctanswer",
        "answer_index", "answerindex", "solution", "expected", "expected_answer",
    }
    if isinstance(value, list):
        return [_strip_quiz_answers(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _strip_quiz_answers(item)
            for key, item in value.items()
            if str(key).lower() not in private_keys
        }
    return value


def _quiz_questions(quiz: Any) -> list[Any]:
    if isinstance(quiz, dict):
        for key in ("questions", "items", "quiz"):
            if isinstance(quiz.get(key), list):
                return quiz[key]
        return []
    return quiz if isinstance(quiz, list) else []


def _question_answer(question: Any) -> tuple[bool, Any]:
    if not isinstance(question, dict):
        return False, None
    keys = {str(k).lower(): k for k in question}
    for key in (
        "answer", "correct_answer", "correctanswer", "correct", "answer_index",
        "answerindex", "solution", "expected", "expected_answer",
    ):
        if key in keys:
            return True, question[keys[key]]
    return False, None


def _normalise_answer(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip().casefold()
    if isinstance(value, (list, tuple, set)):
        return sorted(_normalise_answer(item) for item in value)
    if isinstance(value, dict):
        return {str(k): _normalise_answer(v) for k, v in sorted(value.items(), key=lambda kv: str(kv[0]))}
    return value


def _answers_match(question: Any, actual: Any, expected: Any) -> bool:
    """Compare an answer by stored index or visible option text.  Teachers
    commonly author manifests with ``answer: 1`` while imported quiz banks
    use ``answer: 'HIGH'``; accepting both keeps grading deterministic."""
    if _normalise_answer(actual) == _normalise_answer(expected):
        return True
    options = question.get("options") if isinstance(question, dict) else None
    if not isinstance(options, list):
        return False
    actual_candidates = [actual]
    expected_candidates = [expected]
    if isinstance(actual, int) and 0 <= actual < len(options):
        actual_candidates.append(options[actual])
    if isinstance(expected, int) and 0 <= expected < len(options):
        expected_candidates.append(options[expected])
    return any(
        _normalise_answer(left) == _normalise_answer(right)
        for left in actual_candidates
        for right in expected_candidates
    )


def _auto_grade_quiz(quiz: Any, submitted: Any, max_score: float) -> tuple[float, str] | None:
    questions = _quiz_questions(quiz)
    if not questions:
        return None
    if isinstance(submitted, dict) and "answers" in submitted:
        submitted = submitted["answers"]
    by_id: dict[str, Any] = {}
    if isinstance(submitted, dict):
        by_id = {str(k): v for k, v in submitted.items()}
    elif isinstance(submitted, list):
        # Accept [{question_id, answer}] as well as the conventional ordered list.
        if all(isinstance(item, dict) and ("question_id" in item or "id" in item) for item in submitted):
            for item in submitted:
                qid = item.get("question_id", item.get("id"))
                by_id[str(qid)] = item.get("answer", item.get("value"))
        else:
            by_id = {str(i): value for i, value in enumerate(submitted)}
    graded = 0
    correct = 0
    for index, question in enumerate(questions):
        has_key, expected = _question_answer(question)
        if not has_key:
            continue
        graded += 1
        qid = question.get("id", question.get("key", index)) if isinstance(question, dict) else index
        actual = by_id.get(str(qid), by_id.get(str(index)))
        if _answers_match(question, actual, expected):
            correct += 1
    if graded == 0:
        return None
    score = round(float(max_score) * correct / graded, 2)
    return score, f"Auto-graded: {correct}/{graded} correct"


def _with_student_submission(assignment: dict[str, Any], user_id: str) -> dict[str, Any]:
    assignment = dict(assignment)
    assignment["submission"] = cloud_db.get_submission(assignment["id"], student_id=user_id)
    assignment["submission_attempts"] = cloud_db.list_submission_attempts(
        assignment["id"], student_id=user_id, include_private=False
    )
    assignment["quiz"] = _strip_quiz_answers(assignment.get("quiz"))
    assignment.pop("rubric", None)
    assignment.pop("teacher_id", None)
    return assignment


def _query_class_ids(value: str | None) -> list[str]:
    """Parse a comma-separated ``class_ids`` query parameter.

    The dashboard keeps one compact URL for links copied between classes.  A
    de-duplicated bounded list is passed to cloud_db, which filters unknown
    classes without disclosing another teacher's class IDs.
    """
    if not value:
        return []
    out: list[str] = []
    for token in str(value).split(","):
        token = token.strip()
        if token and token not in out:
            out.append(token[:128])
    return out[:100]


def _csv_cell(value: Any) -> Any:
    """Make exported spreadsheet cells safe from formula injection."""
    if value is None:
        return ""
    text = str(value)
    if text.startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def _teacher_dashboard(
    authorization: str | None,
    *,
    class_ids: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> dict[str, Any]:
    user = _require_teacher(authorization)
    if status:
        statuses = {item.strip().casefold() for item in status.split(",") if item.strip()}
        allowed = _DASHBOARD_STATUSES
        if statuses - allowed:
            raise HTTPException(status_code=422, detail="Unknown dashboard status")
    if order and str(order).casefold() not in (
        "asc", "ascending", "desc", "descending", "up", "down"
    ):
        raise HTTPException(status_code=422, detail="order must be asc or desc")
    if limit is not None and (limit < 0 or limit > cloud_db.MAX_DASHBOARD_ROWS):
        raise HTTPException(
            status_code=422,
            detail=f"limit must be between 0 and {cloud_db.MAX_DASHBOARD_ROWS}",
        )
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be non-negative")
    return cloud_db.get_teacher_dashboard(
        user["id"],
        _query_class_ids(class_ids),
        status=status,
        q=q,
        sort=sort,
        order=order,
        limit=limit,
        offset=offset,
    )


def _teacher_export_csv(
    authorization: str | None,
    *,
    class_ids: str | None = None,
    class_id: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
) -> Response:
    """Build a safe UTF-8 CSV from exactly the dashboard's filtered rows."""
    user = _require_teacher(authorization)
    selected = class_ids if class_ids is not None else class_id
    if status:
        statuses = {item.strip().casefold() for item in status.split(",") if item.strip()}
        allowed = _DASHBOARD_STATUSES
        if statuses - allowed:
            raise HTTPException(status_code=422, detail="Unknown dashboard status")
    if order and str(order).casefold() not in (
        "asc", "ascending", "desc", "descending", "up", "down"
    ):
        raise HTTPException(status_code=422, detail="order must be asc or desc")
    rows = cloud_db.get_teacher_submission_rows(
        user["id"],
        _query_class_ids(selected),
        status=status,
        q=q,
        sort=sort,
        order=order,
    )
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(
        [
            "class_id", "class_name", "assignment_id", "assignment_title",
            "assignment_type", "assignment_status", "lesson_id", "student_id",
            "student_name", "student_email", "status", "attempt_no", "submitted",
            "attempt_count", "submitted_at", "graded_at", "is_late", "score", "max_score", "feedback",
            "opens_at", "closes_at", "time_limit", "max_attempts", "late_policy",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                _csv_cell(row.get("class_id")),
                _csv_cell(row.get("class_name")),
                _csv_cell(row.get("assignment_id")),
                _csv_cell(row.get("assignment_title")),
                _csv_cell(row.get("assignment_type")),
                _csv_cell(row.get("assignment_status")),
                _csv_cell(row.get("lesson_id")),
                _csv_cell(row.get("student_id")),
                _csv_cell(row.get("student_name")),
                _csv_cell(row.get("student_email")),
                _csv_cell(row.get("status")),
                _csv_cell(row.get("attempt_no")),
                _csv_cell(row.get("submitted")),
                _csv_cell(row.get("attempt_count")),
                _csv_cell(row.get("submitted_at")),
                _csv_cell(row.get("graded_at")),
                _csv_cell(row.get("is_late")),
                _csv_cell(row.get("score")),
                _csv_cell(row.get("max_score")),
                _csv_cell(row.get("feedback")),
                _csv_cell(row.get("opens_at")),
                _csv_cell(row.get("closes_at")),
                _csv_cell(row.get("time_limit")),
                _csv_cell(row.get("max_attempts")),
                _csv_cell(row.get("late_policy")),
            ]
        )
    # Excel and Numbers recognise the BOM and preserve Traditional Chinese
    # names without requiring the teacher to choose an encoding manually.
    body = "\ufeff" + stream.getvalue()
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="velxio-lms-submissions.csv"'},
    )


# These routes intentionally live before ``/classes/{class_id}`` and
# ``/assignments/{assignment_id}`` so FastAPI treats the dotted/static paths as
# routes rather than IDs.  ``/reports/*`` and ``/assignments/export.csv`` are
# compatibility aliases used by older teacher dashboards.


@router.get("/teacher/dashboard")
async def teacher_dashboard(
    class_ids: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    return _teacher_dashboard(
        authorization,
        class_ids=class_ids,
        status=status,
        sort=sort,
        order=order,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.get("/reports/students")
async def teacher_student_report(
    class_ids: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
    limit: int | None = None,
    offset: int = 0,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    return _teacher_dashboard(
        authorization,
        class_ids=class_ids,
        status=status,
        sort=sort,
        order=order,
        q=q,
        limit=limit,
        offset=offset,
    )


@router.get("/teacher/export.csv")
@router.get("/assignments/export.csv")
async def teacher_export_csv(
    class_ids: str | None = None,
    class_id: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
    authorization: str | None = Header(default=None),
) -> Response:
    return _teacher_export_csv(
        authorization,
        class_ids=class_ids,
        class_id=class_id,
        status=status,
        sort=sort,
        order=order,
        q=q,
    )


@router.get("/reports/export.csv")
async def teacher_reports_export_csv(
    class_ids: str | None = None,
    class_id: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    q: str | None = None,
    authorization: str | None = Header(default=None),
) -> Response:
    return _teacher_export_csv(
        authorization,
        class_ids=class_ids,
        class_id=class_id,
        status=status,
        sort=sort,
        order=order,
        q=q,
    )


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


# ── Assignments ────────────────────────────────────────────────────────────


@router.post("/classes/{class_id}/assignments")
async def assignment_create(
    class_id: str,
    req: AssignmentCreate,
    authorization: str | None = Header(default=None),
) -> dict:
    user = _require_staff(authorization)
    # A platform admin can inspect/manage classes, but assignments remain
    # owned by the class teacher so student visibility and audit trails stay
    # unambiguous.  Teachers may only write their own classes.
    if user.get("role") != "teacher" or not cloud_db.class_owned_by(user["id"], class_id):
        raise HTTPException(status_code=404, detail="Class not found")
    payload = _assignment_payload(req)
    try:
        assignment = cloud_db.create_assignment(user["id"], class_id, **payload)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if assignment is None:
        raise HTTPException(status_code=409, detail="Assignment quota reached")
    return {"assignment": assignment, **assignment}


@router.get("/classes/{class_id}/assignments")
async def class_assignments(
    class_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    role = str(user.get("role") or "student")
    if role == "teacher":
        if not cloud_db.class_owned_by(user["id"], class_id):
            raise HTTPException(status_code=404, detail="Class not found")
    elif role == "admin":
        pass
    elif not cloud_db.class_member(user["id"], class_id):
        raise HTTPException(status_code=403, detail="Join this class first")
    rows = cloud_db.list_assignments(
        user["id"], role=role, class_id=class_id, include_private=role in ("teacher", "admin")
    )
    if role == "student":
        rows = [_with_student_submission(row, user["id"]) for row in rows]
    return {"assignments": rows}


@router.get("/assignments")
async def assignments_list(
    class_id: str | None = None,
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    role = str(user.get("role") or "student")
    if class_id:
        if role == "teacher" and not cloud_db.class_owned_by(user["id"], class_id):
            raise HTTPException(status_code=404, detail="Class not found")
        if role == "student" and not cloud_db.class_member(user["id"], class_id):
            raise HTTPException(status_code=403, detail="Join this class first")
    rows = cloud_db.list_assignments(
        user["id"], role=role, class_id=class_id, include_private=role in ("teacher", "admin")
    )
    if role == "student":
        rows = [_with_student_submission(row, user["id"]) for row in rows]
    return {"assignments": rows}


@router.get("/assignments/{assignment_id}")
async def assignment_get(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    role = str(user.get("role") or "student")
    assignment = cloud_db.get_assignment_for_user(
        assignment_id,
        user["id"],
        role=role,
        include_private=role in ("teacher", "admin"),
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    if role == "student":
        assignment = _with_student_submission(assignment, user["id"])
    else:
        assignment = dict(assignment)
        assignment["submission"] = None
    return {"assignment": assignment, **assignment}


@router.put("/assignments/{assignment_id}")
@router.patch("/assignments/{assignment_id}")
async def assignment_update(
    assignment_id: str,
    req: AssignmentUpdate,
    authorization: str | None = Header(default=None),
) -> dict:
    user = _require_teacher(authorization)
    patch = _assignment_patch(req)
    try:
        assignment = cloud_db.update_assignment(user["id"], assignment_id, patch)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return {"assignment": assignment, **assignment}


@router.post("/assignments/{assignment_id}/publish")
async def assignment_publish(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    assignment = cloud_db.set_assignment_status(user["id"], assignment_id, "published")
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return {"assignment": assignment, **assignment}


@router.post("/assignments/{assignment_id}/unpublish")
async def assignment_unpublish(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    assignment = cloud_db.set_assignment_status(user["id"], assignment_id, "draft")
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return {"assignment": assignment, **assignment}


@router.delete("/assignments/{assignment_id}")
async def assignment_delete(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = _require_teacher(authorization)
    if not cloud_db.delete_assignment(user["id"], assignment_id):
        raise HTTPException(status_code=404, detail="Assignment not found")
    return {"ok": True}


@router.post("/assignments/{assignment_id}/submissions")
async def submission_save(
    assignment_id: str,
    req: SubmissionCreate,
    authorization: str | None = Header(default=None),
) -> dict:
    user = require_user(authorization)
    if user.get("role") not in ("student",):
        raise HTTPException(status_code=403, detail="Student account required")
    assignment = cloud_db.get_assignment_for_user(assignment_id, user["id"], role="student")
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    submit = req.submit
    if req.save is not None:
        submit = not req.save
    if req.status:
        if req.status not in ("draft", "submitted"):
            raise HTTPException(status_code=422, detail="status must be draft|submitted")
        submit = req.status == "submitted"
    answers = req.answers if req.answers is not None else req.answer
    try:
        submission, _created = cloud_db.save_submission(
            assignment_id,
            user["id"],
            content=req.content[:100_000],
            answers=answers,
            project_data=req.project_data,
            files=req.files,
            submit=submit,
        )
    except cloud_db.SubmissionPolicyError as exc:
        raise HTTPException(status_code=409, detail={"code": exc.reason, "message": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc))
    if submission is None:
        raise HTTPException(status_code=403, detail="You are not a member of this class")
    auto_graded = False
    if submit and assignment.get("auto_grade") and assignment.get("assignment_type") == "quiz":
        result = _auto_grade_quiz(assignment.get("quiz"), answers, float(assignment["max_score"]))
        if result is not None:
            score, feedback = result
            submission = cloud_db.auto_grade_submission(submission["id"], score=score, feedback=feedback)
            auto_graded = submission is not None
    elif submit and assignment.get("auto_grade") and assignment.get("assignment_type") != "quiz":
        # Rubric/AI grading runs server-side after final submit. Provider
        # failures become a persisted needs_review result and never reject a
        # valid student submission.
        try:
            from app.api.routes.grading import _grade
            graded = await _grade(assignment, submission or {}, user)
            submission = graded.get("submission") or submission
            auto_graded = graded.get("ai_grade", {}).get("status") == "graded"
        except Exception:
            auto_graded = False
    return {"submission": submission, **(submission or {}), "auto_graded": auto_graded}


@router.get("/assignments/{assignment_id}/submission")
async def submission_get(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict:
    user = require_user(authorization)
    role = str(user.get("role") or "student")
    assignment = cloud_db.get_assignment_for_user(assignment_id, user["id"], role=role)
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    if role in ("teacher", "admin"):
        raise HTTPException(status_code=400, detail="Use the submissions endpoint for teachers")
    return {"submission": cloud_db.get_submission(assignment_id, student_id=user["id"])}


@router.get("/assignments/{assignment_id}/submission/attempts")
@router.get("/assignments/{assignment_id}/submission/history")
async def submission_attempts_student(
    assignment_id: str, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    """Return the signed-in student's append-only submission history."""
    user = require_user(authorization)
    if user.get("role") != "student":
        raise HTTPException(status_code=403, detail="Student account required")
    assignment = cloud_db.get_assignment_for_user(assignment_id, user["id"], role="student")
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    rows = cloud_db.list_submission_attempts(
        assignment_id, student_id=user["id"], include_private=False
    )
    return {"assignment": assignment, "attempts": rows, "history": rows}


@router.get("/assignments/{assignment_id}/submissions")
async def submissions_list(
    assignment_id: str,
    status: str | None = None,
    history: bool = False,
    authorization: str | None = Header(default=None),
) -> dict:
    user = _require_teacher(authorization)
    assignment = cloud_db.get_assignment_for_user(
        assignment_id, user["id"], role=user.get("role", "teacher"), include_private=True
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    if status and status not in ("draft", "submitted", "graded", "returned"):
        raise HTTPException(status_code=422, detail="Unknown submission status")
    submissions = cloud_db.list_submissions(assignment_id, status=status)
    out: dict[str, Any] = {"assignment": assignment, "submissions": submissions}
    if history:
        attempts = cloud_db.list_submission_attempts(assignment_id, include_private=True)
        out["attempts"] = attempts
        out["history"] = attempts
    return out


@router.get("/assignments/{assignment_id}/submissions/{submission_id}/attempts")
@router.get("/assignments/{assignment_id}/submissions/{submission_id}/history")
async def submission_attempts_teacher(
    assignment_id: str,
    submission_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Teacher-only history view for one student's current submission row."""
    user = _require_teacher(authorization)
    assignment = cloud_db.get_assignment_for_user(
        assignment_id, user["id"], role=user.get("role", "teacher"), include_private=True
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    current = cloud_db.get_submission(assignment_id, submission_id=submission_id)
    if current is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    rows = cloud_db.list_submission_attempts(
        assignment_id, submission_id=submission_id, include_private=True
    )
    return {"assignment": assignment, "submission": current, "attempts": rows, "history": rows}


@router.get("/submissions/{submission_id}/attempts")
async def submission_attempts(
    submission_id: str, authorization: str | None = Header(default=None)
) -> dict:
    """Teacher-only immutable history for one student's submission."""
    user = _require_teacher(authorization)
    submission = cloud_db.get_submission("", submission_id=submission_id)
    if submission is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    assignment = cloud_db.get_assignment_for_user(
        submission["assignment_id"], user["id"], role=user.get("role", "teacher"), include_private=True
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    attempts = cloud_db.list_submission_attempts(
        submission["assignment_id"], submission_id=submission_id, include_private=True
    )
    return {"attempts": attempts}


@router.patch("/submissions/{submission_id}/grade")
@router.put("/submissions/{submission_id}/grade")
@router.post("/submissions/{submission_id}/grade")
async def submission_grade(
    submission_id: str,
    req: SubmissionGrade,
    authorization: str | None = Header(default=None),
) -> dict:
    user = _require_teacher(authorization)
    if len(req.feedback) > 20_000:
        raise HTTPException(status_code=422, detail="Feedback is too long")
    try:
        submission = cloud_db.grade_submission(
            submission_id,
            user["id"],
            score=req.score,
            feedback=req.feedback,
            status=req.status,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if submission is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    return {"submission": submission, **submission}
