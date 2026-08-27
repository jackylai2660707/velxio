"""Persistence for AI rubric decisions.

AI grading metadata is kept in a separate table so old classroom databases
can be upgraded without rewriting the mutable ``assignment_submissions``
row.  The table is an append-only audit log keyed by submission and attempt;
the most recent row is the result a student/teacher sees.  This also lets the
submission-history migration evolve independently from the AI provider.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from app.services import cloud_db


def init_store() -> None:
    """Create the AI result table and indexes (idempotent)."""

    with cloud_db._connect() as conn:  # type: ignore[attr-defined]
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ai_submission_grades (
                id TEXT PRIMARY KEY,
                submission_id TEXT NOT NULL REFERENCES assignment_submissions(id) ON DELETE CASCADE,
                assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
                student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                attempt_no INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                score REAL,
                suggested_score REAL,
                confidence REAL,
                feedback TEXT NOT NULL DEFAULT '',
                criteria TEXT NOT NULL DEFAULT '[]',
                model TEXT,
                usage_tokens INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ai_submission_grades_submission
                ON ai_submission_grades(submission_id, attempt_no DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_ai_submission_grades_assignment
                ON ai_submission_grades(assignment_id, status, updated_at DESC);
            """
        )


def _dump(value: Any, fallback: str) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return fallback


def _load(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def _row_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "submission_id": row["submission_id"],
        "assignment_id": row["assignment_id"],
        "student_id": row["student_id"],
        "attempt_no": int(row["attempt_no"] or 1),
        "status": row["status"],
        "score": row["score"],
        "suggested_score": row["suggested_score"],
        "confidence": row["confidence"],
        "feedback": row["feedback"] or "",
        "criteria": _load(row["criteria"], []),
        "model": row["model"],
        "usage_tokens": int(row["usage_tokens"] or 0),
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def save_result(
    *,
    submission_id: str,
    assignment_id: str,
    student_id: str,
    attempt_no: int,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Persist one result, replacing no history rows.

    ``attempt_no`` comes from the mutable submission/history row.  A retry of
    the same attempt gets a new id and remains visible to the teacher as an
    audit event; callers should use :func:`latest_result` for the current
    decision.
    """

    init_store()
    now = time.time()
    with cloud_db._connect() as conn:  # type: ignore[attr-defined]
        rid = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO ai_submission_grades ("
            "id, submission_id, assignment_id, student_id, attempt_no, status, score, "
            "suggested_score, confidence, feedback, criteria, model, usage_tokens, error, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                rid,
                submission_id,
                assignment_id,
                student_id,
                max(1, int(attempt_no or 1)),
                str(result.get("status") or "needs_review"),
                result.get("score"),
                result.get("suggested_score"),
                result.get("confidence"),
                str(result.get("feedback") or "")[:20_000],
                _dump(result.get("criteria") or [], "[]"),
                (str(result.get("model"))[:200] if result.get("model") else None),
                max(0, int(result.get("usage_tokens") or 0)),
                (str(result.get("error"))[:500] if result.get("error") else None),
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM ai_submission_grades WHERE id = ?", (rid,)
        ).fetchone()
    return _row_dict(row)


def latest_result(submission_id: str) -> dict[str, Any] | None:
    init_store()
    with cloud_db._connect() as conn:  # type: ignore[attr-defined]
        row = conn.execute(
            "SELECT * FROM ai_submission_grades WHERE submission_id = ? "
            "ORDER BY attempt_no DESC, updated_at DESC, created_at DESC LIMIT 1",
            (submission_id,),
        ).fetchone()
    return _row_dict(row) if row else None


def list_results(
    submission_id: str | None = None, assignment_id: str | None = None
) -> list[dict[str, Any]]:
    init_store()
    clauses: list[str] = []
    args: list[Any] = []
    if submission_id:
        clauses.append("submission_id = ?")
        args.append(submission_id)
    if assignment_id:
        clauses.append("assignment_id = ?")
        args.append(assignment_id)
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    with cloud_db._connect() as conn:  # type: ignore[attr-defined]
        rows = conn.execute(
            "SELECT * FROM ai_submission_grades" + where +
            " ORDER BY updated_at DESC, created_at DESC", args
        ).fetchall()
    return [_row_dict(row) for row in rows]


__all__ = ["init_store", "latest_result", "list_results", "save_result"]
