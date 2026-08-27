from __future__ import annotations

import pytest

from app.services import ai_grading


def _assignment(**overrides):
    value = {
        "title": "ESP32 LED",
        "description": "Build a safe LED circuit.",
        "instructions": "Use the button to toggle the LED.",
        "assignment_type": "project",
        "max_score": 100,
        "rubric": {
            "criteria": [
                {"id": "compile", "name": "Build", "points": 40},
                {"id": "circuit", "name": "Circuit", "points": 60},
            ]
        },
    }
    value.update(overrides)
    return value


def _submission(**overrides):
    value = {"content": "The LED is connected to GPIO 25 with a resistor.", "project_data": {"components": []}}
    value.update(overrides)
    return value


def test_normalize_rubric_accepts_list_and_aliases():
    result = ai_grading.normalize_rubric(
        [{"id": "one", "title": "One", "max_score": 50}, {"id": "two", "name": "Two", "weight": 50}],
        100,
    )
    assert result is not None
    assert [item["id"] for item in result["criteria"]] == ["one", "two"]
    assert sum(item["max_score"] for item in result["criteria"]) == 100


def test_normalize_rubric_scales_question_points_to_assignment_total():
    result = ai_grading.normalize_rubric([{"id": "one", "name": "One", "points": 5}], 100)
    assert result is not None
    assert result["criteria"][0]["max_score"] == 100


def test_custom_exam_is_not_treated_as_deterministic_quiz():
    assert ai_grading.is_deterministic_quiz(
        {"questions": [{"id": "q1", "type": "single", "answer": 1, "options": ["a", "b"]}]}
    )
    assert not ai_grading.is_deterministic_quiz(
        {"questions": [
            {"id": "q1", "type": "single", "answer": 1, "options": ["a", "b"]},
            {"id": "q2", "type": "code", "points": 10},
        ]}
    )


@pytest.mark.asyncio
async def test_grade_submission_strictly_accepts_confident_json(monkeypatch):
    async def fake_request(messages):
        return (
            {"choices": [{"message": {"content": '{"score":88,"confidence":0.9,"feedback":"Good.","criteria":[{"id":"compile","score":35,"feedback":"Builds."},{"id":"circuit","score":53,"feedback":"Safe."}],"needs_review":false}'}}]},
            "test-model",
            None,
            42,
        )

    monkeypatch.setattr(ai_grading, "_request_completion", fake_request)
    result = await ai_grading.grade_submission(assignment=_assignment(), submission=_submission())
    assert result["status"] == "graded"
    assert result["score"] == 88
    assert result["suggested_score"] == 88
    assert result["confidence"] == 0.9
    assert result["usage_tokens"] == 42
    assert result["criteria"][0]["max_score"] == 40


@pytest.mark.asyncio
async def test_grade_submission_low_confidence_needs_review(monkeypatch):
    async def fake_request(messages):
        return (
            {"choices": [{"message": {"content": '{"score":88,"confidence":0.4,"feedback":"Maybe.","criteria":[{"id":"compile","score":35,"feedback":"Builds."},{"id":"circuit","score":53,"feedback":"Safe."}],"needs_review":false}'}}]},
            "test-model",
            None,
            10,
        )

    monkeypatch.setattr(ai_grading, "_request_completion", fake_request)
    result = await ai_grading.grade_submission(assignment=_assignment(), submission=_submission())
    assert result["status"] == "needs_review"
    assert result["score"] is None
    assert result["suggested_score"] == 88
    assert result["error"] == "model confidence below review threshold"


@pytest.mark.asyncio
async def test_grade_submission_rejects_markdown_or_schema_drift(monkeypatch):
    async def fake_request(messages):
        return (
            {"choices": [{"message": {"content": '```json\n{"score":100}\n```'}}]},
            "test-model",
            None,
            3,
        )

    monkeypatch.setattr(ai_grading, "_request_completion", fake_request)
    result = await ai_grading.grade_submission(assignment=_assignment(), submission=_submission())
    assert result["status"] == "needs_review"
    assert result["score"] is None
    assert result["error"] == "model output keys do not match schema" or result["error"] == "model output is not valid JSON"


@pytest.mark.asyncio
async def test_grade_submission_skips_empty_evidence_without_provider(monkeypatch):
    called = False

    async def fake_request(messages):
        nonlocal called
        called = True
        return None, None, "unexpected", 0

    monkeypatch.setattr(ai_grading, "_request_completion", fake_request)
    result = await ai_grading.grade_submission(assignment=_assignment(), submission={})
    assert result["status"] == "needs_review"
    assert result["error"] == "submission has no evidence"
    assert not called
