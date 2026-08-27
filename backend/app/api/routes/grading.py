"""LMS AI rubric-grading endpoints.

The normal student flow can trigger grading immediately after a final submit;
these endpoints provide an explicit retry/review action for flaky providers
and a teacher batch action for a whole assignment.  Quiz assignments remain
on the deterministic grader in ``lms.py`` and are rejected here.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query

from app.api.routes.auth import require_user
from app.services import ai_grade_store, ai_grading, cloud_db

router = APIRouter()


def _actor(authorization: str | None) -> dict[str, Any]:
    return require_user(authorization)


def _assignment_and_submission(
    assignment_id: str, submission_id: str, user: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    role = str(user.get("role") or "student")
    assignment = cloud_db.get_assignment_for_user(
        assignment_id,
        user["id"],
        role=role,
        include_private=True,
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    submission = cloud_db.get_submission(assignment_id, submission_id=submission_id)
    if submission is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    if role == "student" and submission.get("student_id") != user["id"]:
        raise HTTPException(status_code=404, detail="Submission not found")
    if role not in ("student", "teacher", "admin"):
        raise HTTPException(status_code=403, detail="Account cannot grade submissions")
    return assignment, submission


def _quota_gate(user_id: str) -> None:
    """Apply the same server-key weekly quota as ``/api/agent/stream``.

    BYOK is intentionally not accepted for classroom grading: a student must
    not be able to redirect the server's grading request to an arbitrary
    provider.  If no server key exists, the grader returns ``needs_review``
    and no quota is consumed.
    """

    if not os.environ.get("VELXIO_OPENAI_API_KEY", ""):
        return
    usage = cloud_db.get_ai_usage(user_id)
    if usage["used"] >= usage["limit"]:
        raise HTTPException(
            status_code=429,
            detail=(
                f"AI weekly quota reached ({usage['limit']:,} tokens); "
                "teacher review is required or ask an administrator to increase it."
            ),
        )


def _record_usage(user_id: str, result: dict[str, Any]) -> None:
    if os.environ.get("VELXIO_OPENAI_API_KEY", ""):
        try:
            cloud_db.add_ai_usage(user_id, int(result.get("usage_tokens") or 0))
        except Exception:
            # A usage write must not discard a persisted grade.  The regular
            # agent route follows the same best-effort accounting policy.
            return


async def _grade(
    assignment: dict[str, Any], submission: dict[str, Any], actor: dict[str, Any]
) -> dict[str, Any]:
    if assignment.get("assignment_type") == "quiz" and ai_grading.is_deterministic_quiz(assignment.get("quiz")):
        raise HTTPException(
            status_code=409,
            detail="This answer-key quiz uses deterministic grading",
        )
    if not assignment.get("auto_grade"):
        raise HTTPException(
            status_code=409,
            detail="AI grading is disabled for this assignment",
        )
    if submission.get("status") == "draft":
        raise HTTPException(status_code=409, detail="Submit the assignment before grading")
    _quota_gate(actor["id"])
    result = await ai_grading.grade_submission(assignment=assignment, submission=submission)
    attempt_no = int(submission.get("attempt_no") or submission.get("attempt_count") or 1)
    persisted_ai = ai_grade_store.save_result(
        submission_id=str(submission["id"]),
        assignment_id=str(assignment["id"]),
        student_id=str(submission["student_id"]),
        attempt_no=attempt_no,
        result=result,
    )
    _record_usage(actor["id"], result)
    updated_submission = submission
    if result.get("status") == "graded" and result.get("score") is not None:
        # ``auto_grade_submission`` bounds the mark against max_score and
        # publishes it atomically. A separate AI table retains confidence and
        # criterion evidence for teacher review.
        updated_submission = cloud_db.auto_grade_submission(
            str(submission["id"]),
            score=float(result["score"]),
            feedback=str(result.get("feedback") or ""),
        ) or submission
    return {"submission": updated_submission, "ai_grade": persisted_ai, **persisted_ai}


@router.post("/assignments/{assignment_id}/submissions/{submission_id}/ai-grade")
async def ai_grade_submission(
    assignment_id: str,
    submission_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = _actor(authorization)
    assignment, submission = _assignment_and_submission(assignment_id, submission_id, user)
    return await _grade(assignment, submission, user)


@router.get("/assignments/{assignment_id}/submissions/{submission_id}/ai-grade")
async def ai_grade_get(
    assignment_id: str,
    submission_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    user = _actor(authorization)
    assignment, submission = _assignment_and_submission(assignment_id, submission_id, user)
    result = ai_grade_store.latest_result(submission_id)
    return {"submission": submission, "ai_grade": result}


@router.post("/assignments/{assignment_id}/ai-grade")
async def ai_grade_assignment(
    assignment_id: str,
    authorization: str | None = Header(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    """Grade all final submissions for an assignment (teacher/admin only)."""

    user = _actor(authorization)
    if user.get("role") not in ("teacher", "admin"):
        raise HTTPException(status_code=403, detail="Teacher account required")
    assignment = cloud_db.get_assignment_for_user(
        assignment_id,
        user["id"],
        role=str(user.get("role") or "teacher"),
        include_private=True,
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    submissions = cloud_db.list_submissions(assignment_id)
    results: list[dict[str, Any]] = []
    for submission in submissions[:limit]:
        if submission.get("status") == "draft":
            continue
        try:
            results.append(await _grade(assignment, submission, user))
        except HTTPException as exc:
            # A quota stop applies to the whole batch and is surfaced rather
            # than silently returning a partial class mark.
            if exc.status_code == 429:
                raise
            results.append(
                {
                    "submission_id": submission.get("id"),
                    "status": "needs_review",
                    "error": str(exc.detail),
                }
            )
    return {
        "assignment": assignment,
        "results": results,
        "graded": sum(item.get("ai_grade", {}).get("status") == "graded" for item in results),
        "needs_review": sum(item.get("ai_grade", {}).get("status") == "needs_review" for item in results),
    }


__all__ = ["router"]
