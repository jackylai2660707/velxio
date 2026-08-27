"""
Self-contained cloud persistence for the OSS fork: accounts, projects,
AI-chat sessions, and the「AI物聯網實驗室」learning-management layer
(teacher/student roles, classes, lesson progress, quiz attempts) in a
single SQLite file. Deliberately stdlib-only (sqlite3 + hashlib/hmac/
secrets) — no ORM, no crypto deps, nothing to install, works inside the
existing Docker volume (/app/data).

Security model: a self-hosted classroom/personal instance.
- Passwords: PBKDF2-HMAC-SHA256, 200k iterations, per-user salt.
- Tokens: HMAC-signed `uid.expiry.sig` (JWT-lite, no external deps), 30-day
  expiry, secret persisted next to the DB (or VELXIO_SECRET_KEY env).
- Per-user quotas + payload size caps to keep the DB bounded.

Connections are opened per call (FastAPI sync endpoints run in a thread
pool; sqlite in WAL mode handles that fine at this scale).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

DATA_DIR = Path(os.environ.get("VELXIO_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
DB_PATH = DATA_DIR / "velxio-cloud.db"

TOKEN_TTL_SECONDS = 30 * 24 * 3600
PBKDF2_ITERATIONS = 200_000

MAX_PROJECTS_PER_USER = 100
MAX_CHATS_PER_USER = 100
MAX_PROJECT_BYTES = 2_000_000
MAX_CHAT_BYTES = 1_500_000

MAX_CLASSES_PER_TEACHER = 20
MAX_MEMBERS_PER_CLASS = 100
MAX_QUIZ_ANSWERS_BYTES = 20_000
# Assignment payloads are deliberately bounded.  The LMS stores the small
# project/quiz manifest needed for classroom work, while large source files
# remain in the student's cloud project record.
MAX_ASSIGNMENT_BYTES = 250_000
MAX_SUBMISSION_BYTES = 2_000_000
MAX_ASSIGNMENTS_PER_CLASS = 500
# A teacher dashboard is intentionally bounded even when a deployment has a
# very large roster.  The API still returns ``total`` so clients can paginate
# through the filtered rows without making an unbounded SQLite/JSON request.
MAX_DASHBOARD_ROWS = 100_000

# AI weekly token allowance (per user, resets Monday 00:00 UTC). Applies
# only when a request is served with the SERVER's upstream API key — users
# who bring their own key in the panel pay for themselves and are unmetered.
DEFAULT_WEEKLY_TOKEN_LIMIT = int(os.environ.get("VELXIO_DEFAULT_WEEKLY_TOKENS", "2000000"))

VALID_ROLES = ("student", "teacher", "admin")

# ── Platform settings (admin-editable, stored in SQLite) ───────────────────
# Every operational knob lives here so the admin UI can change it at runtime;
# environment variables only seed the DEFAULTS below. Precedence:
# settings row → env seed → hardcoded fallback.

SETTING_DEFAULTS: dict[str, Any] = {
    # AI upstream
    "ai_model": os.environ.get("VELXIO_AGENT_MODEL", "").strip() or "gpt-5.6-luna",
    "ai_effort": os.environ.get("VELXIO_AGENT_EFFORT", "").strip() or "high",
    # May users pick their own model/effort in the panel? (False = platform
    # values are forced server-side.)
    "allow_custom_model": False,
    # May users bring their own API key (unmetered, they pay)?
    "allow_own_key": True,
    # Weekly token quotas by role (per-user override still wins).
    "student_weekly_tokens": DEFAULT_WEEKLY_TOKEN_LIMIT,
    "teacher_weekly_tokens": int(
        os.environ.get("VELXIO_TEACHER_WEEKLY_TOKENS", str(DEFAULT_WEEKLY_TOKEN_LIMIT * 2))
    ),
    # Accounts: self-service registration on/off, and the teacher-role code.
    "allow_registration": True,
    "teacher_code": os.environ.get("VELXIO_TEACHER_CODE", ""),
}

_BOOL_SETTINGS = {"allow_custom_model", "allow_own_key", "allow_registration"}
_INT_SETTINGS = {"student_weekly_tokens", "teacher_weekly_tokens"}

# Class join codes: unambiguous uppercase alphabet (no 0/O/1/I).
_CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CLASS_CODE_LENGTH = 6


# ── Bootstrap ──────────────────────────────────────────────────────────────


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                password_hash BLOB NOT NULL,
                salt BLOB NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                messages TEXT NOT NULL,
                api_messages TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS classes (
                id TEXT PRIMARY KEY,
                teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                code TEXT NOT NULL UNIQUE,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS class_members (
                class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                joined_at REAL NOT NULL,
                PRIMARY KEY (class_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS lesson_progress (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                lesson_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'done',
                updated_at REAL NOT NULL,
                PRIMARY KEY (user_id, lesson_id)
            );
            CREATE TABLE IF NOT EXISTS quiz_attempts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                lesson_id TEXT NOT NULL,
                score INTEGER NOT NULL,
                total INTEGER NOT NULL,
                answers TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_quiz_user_lesson
                ON quiz_attempts(user_id, lesson_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS assignments (
                id TEXT PRIMARY KEY,
                class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
                teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                instructions TEXT NOT NULL DEFAULT '',
                lesson_id TEXT,
                assignment_type TEXT NOT NULL DEFAULT 'project',
                project_template TEXT,
                quiz TEXT,
                rubric TEXT,
                due_at REAL,
                max_score REAL NOT NULL DEFAULT 100,
                auto_grade INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'draft',
                published_at REAL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_assignments_class
                ON assignments(class_id, status, due_at, created_at DESC);
            CREATE TABLE IF NOT EXISTS assignment_submissions (
                id TEXT PRIMARY KEY,
                assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
                student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL DEFAULT '',
                answers TEXT,
                project_data TEXT,
                files TEXT,
                status TEXT NOT NULL DEFAULT 'draft',
                score REAL,
                feedback TEXT NOT NULL DEFAULT '',
                submitted_at REAL,
                graded_at REAL,
                grader_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                attempt_no INTEGER NOT NULL DEFAULT 1,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE (assignment_id, student_id)
            );
            CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment
                ON assignment_submissions(assignment_id, status, submitted_at DESC);
            CREATE INDEX IF NOT EXISTS idx_assignment_submissions_student
                ON assignment_submissions(student_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS ai_usage (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                week_start TEXT NOT NULL,
                tokens INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, week_start)
            );
            CREATE TABLE IF NOT EXISTS platform_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        # Migrations: columns added after the first release of the cloud
        # schema — backfill existing databases in place.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        if "role" not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'student'"
            )
        if "weekly_token_limit" not in cols:
            # NULL = use DEFAULT_WEEKLY_TOKEN_LIMIT; admin can override per user.
            conn.execute("ALTER TABLE users ADD COLUMN weekly_token_limit INTEGER")


def _secret_key() -> bytes:
    env = os.environ.get("VELXIO_SECRET_KEY")
    if env:
        return env.encode()
    keyfile = DATA_DIR / "secret_key"
    if keyfile.exists():
        return keyfile.read_bytes()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key = secrets.token_bytes(32)
    keyfile.write_bytes(key)
    try:
        keyfile.chmod(0o600)
    except OSError:
        pass
    return key


# ── Passwords & tokens ─────────────────────────────────────────────────────


def _hash_password(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)


def make_token(user_id: str) -> str:
    exp = int(time.time()) + TOKEN_TTL_SECONDS
    body = f"{user_id}.{exp}".encode()
    sig = hmac.new(_secret_key(), body, hashlib.sha256).digest()
    return (
        base64.urlsafe_b64encode(body).decode().rstrip("=")
        + "."
        + base64.urlsafe_b64encode(sig).decode().rstrip("=")
    )


def verify_token(token: str) -> str | None:
    """Returns the user id, or None if invalid/expired."""
    try:
        body_b64, sig_b64 = token.rsplit(".", 1)
        pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
        body = base64.urlsafe_b64decode(pad(body_b64))
        sig = base64.urlsafe_b64decode(pad(sig_b64))
        expected = hmac.new(_secret_key(), body, hashlib.sha256).digest()
        if not hmac.compare_digest(sig, expected):
            return None
        user_id, exp_str = body.decode().rsplit(".", 1)
        if int(exp_str) < time.time():
            return None
        return user_id
    except Exception:
        return None


# ── Users ──────────────────────────────────────────────────────────────────


def _user_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "role": row["role"] if "role" in row.keys() else "student",
    }


def create_user(
    email: str, password: str, name: str, role: str = "student"
) -> dict[str, Any] | None:
    """Returns the user, or None if the email is taken. NOTE: only trusted
    callers (admin routes / env bootstrap) may pass role='admin' — the
    public register route restricts itself to student/teacher."""
    if role not in VALID_ROLES:
        role = "student"
    salt = secrets.token_bytes(16)
    user_id = uuid.uuid4().hex
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO users (id, email, name, password_hash, salt, created_at, role) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    user_id,
                    email.lower(),
                    name,
                    _hash_password(password, salt),
                    salt,
                    time.time(),
                    role,
                ),
            )
    except sqlite3.IntegrityError:
        return None
    return {"id": user_id, "email": email.lower(), "name": name, "role": role}


def authenticate(email: str, password: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
    if not row:
        # burn comparable time so missing-vs-wrong-password isn't timeable
        _hash_password(password, b"x" * 16)
        return None
    if not hmac.compare_digest(_hash_password(password, row["salt"]), row["password_hash"]):
        return None
    return _user_row_to_dict(row)


def get_user(user_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _user_row_to_dict(row) if row else None


# ── Projects ───────────────────────────────────────────────────────────────


def list_projects(user_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at, length(data) AS size "
            "FROM projects WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_project(user_id: str, name: str, data: dict[str, Any]) -> str | None:
    """Returns new project id, or None when over quota."""
    payload = json.dumps(data, ensure_ascii=False)
    if len(payload.encode()) > MAX_PROJECT_BYTES:
        raise ValueError("project too large")
    with _connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM projects WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
        if count >= MAX_PROJECTS_PER_USER:
            return None
        pid = uuid.uuid4().hex
        now = time.time()
        conn.execute(
            "INSERT INTO projects (id, user_id, name, data, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (pid, user_id, name, payload, now, now),
        )
    return pid


def get_project(user_id: str, project_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)
        ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["name"],
        "data": json.loads(row["data"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def update_project(
    user_id: str, project_id: str, name: str | None, data: dict[str, Any] | None
) -> bool:
    sets: list[str] = ["updated_at = ?"]
    args: list[Any] = [time.time()]
    if name is not None:
        sets.append("name = ?")
        args.append(name)
    if data is not None:
        payload = json.dumps(data, ensure_ascii=False)
        if len(payload.encode()) > MAX_PROJECT_BYTES:
            raise ValueError("project too large")
        sets.append("data = ?")
        args.append(payload)
    args += [project_id, user_id]
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE projects SET {', '.join(sets)} WHERE id = ? AND user_id = ?", args
        )
    return cur.rowcount > 0


def delete_project(user_id: str, project_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user_id)
        )
    return cur.rowcount > 0


# ── Chat sessions ──────────────────────────────────────────────────────────


def list_chats(user_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at, length(messages) AS size "
            "FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_chat(
    user_id: str,
    chat_id: str | None,
    title: str,
    messages: list[Any],
    api_messages: list[Any],
) -> str | None:
    """Create (chat_id None) or update. Returns the chat id, None over quota,
    raises ValueError when too large."""
    m = json.dumps(messages, ensure_ascii=False)
    am = json.dumps(api_messages, ensure_ascii=False)
    if len(m.encode()) + len(am.encode()) > MAX_CHAT_BYTES:
        raise ValueError("chat too large")
    now = time.time()
    with _connect() as conn:
        if chat_id:
            cur = conn.execute(
                "UPDATE chats SET title = ?, messages = ?, api_messages = ?, updated_at = ? "
                "WHERE id = ? AND user_id = ?",
                (title, m, am, now, chat_id, user_id),
            )
            if cur.rowcount > 0:
                return chat_id
            return None  # unknown id — client should create a new one
        count = conn.execute("SELECT COUNT(*) FROM chats WHERE user_id = ?", (user_id,)).fetchone()[0]
        if count >= MAX_CHATS_PER_USER:
            return None
        cid = uuid.uuid4().hex
        conn.execute(
            "INSERT INTO chats (id, user_id, title, messages, api_messages, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (cid, user_id, title, m, am, now, now),
        )
    return cid


def get_chat(user_id: str, chat_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id)
        ).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "title": row["title"],
        "messages": json.loads(row["messages"]),
        "api_messages": json.loads(row["api_messages"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def delete_chat(user_id: str, chat_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM chats WHERE id = ? AND user_id = ?", (chat_id, user_id))
    return cur.rowcount > 0


# ── LMS: classes ───────────────────────────────────────────────────────────


def _new_class_code() -> str:
    return "".join(secrets.choice(_CLASS_CODE_ALPHABET) for _ in range(CLASS_CODE_LENGTH))


def create_class(teacher_id: str, name: str) -> dict[str, Any] | None:
    """Returns the class, or None when the teacher is over quota."""
    with _connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM classes WHERE teacher_id = ?", (teacher_id,)
        ).fetchone()[0]
        if count >= MAX_CLASSES_PER_TEACHER:
            return None
        class_id = uuid.uuid4().hex
        now = time.time()
        # Retry on the (unlikely) join-code collision.
        for _ in range(10):
            code = _new_class_code()
            try:
                conn.execute(
                    "INSERT INTO classes (id, teacher_id, name, code, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (class_id, teacher_id, name, code, now),
                )
                return {"id": class_id, "name": name, "code": code, "created_at": now}
            except sqlite3.IntegrityError:
                continue
    raise RuntimeError("could not allocate a unique class code")


def delete_class(teacher_id: str, class_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM classes WHERE id = ? AND teacher_id = ?", (class_id, teacher_id)
        )
    return cur.rowcount > 0


def list_classes_teaching(teacher_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT c.id, c.name, c.code, c.created_at, "
            "       (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id) AS member_count "
            "FROM classes c WHERE c.teacher_id = ? ORDER BY c.created_at DESC",
            (teacher_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_classes_joined(user_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT c.id, c.name, u.name AS teacher_name, m.joined_at "
            "FROM class_members m "
            "JOIN classes c ON c.id = m.class_id "
            "JOIN users u ON u.id = c.teacher_id "
            "WHERE m.user_id = ? ORDER BY m.joined_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def join_class(user_id: str, code: str) -> dict[str, Any] | None:
    """Join by code. Returns the class meta, None for an unknown code.
    Raises ValueError when the class is full."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT c.id, c.name, u.name AS teacher_name "
            "FROM classes c JOIN users u ON u.id = c.teacher_id WHERE c.code = ?",
            (code.strip().upper(),),
        ).fetchone()
        if not row:
            return None
        members = conn.execute(
            "SELECT COUNT(*) FROM class_members WHERE class_id = ?", (row["id"],)
        ).fetchone()[0]
        already = conn.execute(
            "SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?",
            (row["id"], user_id),
        ).fetchone()
        if not already:
            if members >= MAX_MEMBERS_PER_CLASS:
                raise ValueError("class full")
            conn.execute(
                "INSERT INTO class_members (class_id, user_id, joined_at) VALUES (?, ?, ?)",
                (row["id"], user_id, time.time()),
            )
    return {"id": row["id"], "name": row["name"], "teacher_name": row["teacher_name"]}


def get_class_report(teacher_id: str, class_id: str) -> dict[str, Any] | None:
    """Full progress/quiz report for one class. None unless owned by teacher_id."""
    with _connect() as conn:
        cls = conn.execute(
            "SELECT id, name, code, created_at FROM classes WHERE id = ? AND teacher_id = ?",
            (class_id, teacher_id),
        ).fetchone()
        if not cls:
            return None
        members = conn.execute(
            "SELECT u.id, u.name, u.email, m.joined_at "
            "FROM class_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.class_id = ? ORDER BY m.joined_at",
            (class_id,),
        ).fetchall()
        out_members: list[dict[str, Any]] = []
        for m in members:
            progress = [
                r["lesson_id"]
                for r in conn.execute(
                    "SELECT lesson_id FROM lesson_progress "
                    "WHERE user_id = ? AND status = 'done'",
                    (m["id"],),
                )
            ]
            quiz = {
                r["lesson_id"]: {
                    "best_score": r["best_score"],
                    "total": r["total"],
                    "attempts": r["attempts"],
                }
                for r in conn.execute(
                    "SELECT lesson_id, MAX(score) AS best_score, total, COUNT(*) AS attempts "
                    "FROM quiz_attempts WHERE user_id = ? GROUP BY lesson_id",
                    (m["id"],),
                )
            }
            out_members.append(
                {
                    "id": m["id"],
                    "name": m["name"],
                    "email": m["email"],
                    "joined_at": m["joined_at"],
                    "progress": progress,
                    "quiz": quiz,
                }
            )
    return {
        "id": cls["id"],
        "name": cls["name"],
        "code": cls["code"],
        "created_at": cls["created_at"],
        "members": out_members,
    }


# ── LMS: lesson progress & quizzes ─────────────────────────────────────────


def set_progress(user_id: str, lesson_id: str, status: str = "done") -> None:
    with _connect() as conn:
        if status == "reset":
            conn.execute(
                "DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = ?",
                (user_id, lesson_id),
            )
            return
        conn.execute(
            "INSERT INTO lesson_progress (user_id, lesson_id, status, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_id, lesson_id) DO UPDATE SET status = ?, updated_at = ?",
            (user_id, lesson_id, status, time.time(), status, time.time()),
        )


def get_progress(user_id: str) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT lesson_id FROM lesson_progress WHERE user_id = ? AND status = 'done'",
            (user_id,),
        ).fetchall()
    return [r["lesson_id"] for r in rows]


def record_quiz(
    user_id: str, lesson_id: str, score: int, total: int, answers: list[Any]
) -> str:
    payload = json.dumps(answers, ensure_ascii=False)
    if len(payload.encode()) > MAX_QUIZ_ANSWERS_BYTES:
        raise ValueError("answers too large")
    attempt_id = uuid.uuid4().hex
    with _connect() as conn:
        conn.execute(
            "INSERT INTO quiz_attempts (id, user_id, lesson_id, score, total, answers, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (attempt_id, user_id, lesson_id, int(score), int(total), payload, time.time()),
        )
    return attempt_id


# ── Platform settings ──────────────────────────────────────────────────────


def _coerce_setting(key: str, value: Any) -> Any:
    if key in _BOOL_SETTINGS:
        return bool(value) if isinstance(value, bool) else str(value).lower() in ("1", "true", "yes")
    if key in _INT_SETTINGS:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return SETTING_DEFAULTS[key]
    return str(value)


def get_settings() -> dict[str, Any]:
    """Effective platform settings: stored rows over the seeded defaults."""
    out = dict(SETTING_DEFAULTS)
    with _connect() as conn:
        for row in conn.execute("SELECT key, value FROM platform_settings"):
            if row["key"] in SETTING_DEFAULTS:
                out[row["key"]] = _coerce_setting(row["key"], json.loads(row["value"]))
    return out


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    """Persist the given known keys; unknown keys are ignored. Returns the
    new effective settings."""
    with _connect() as conn:
        for key, value in patch.items():
            if key not in SETTING_DEFAULTS:
                continue
            conn.execute(
                "INSERT INTO platform_settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = ?",
                (key, json.dumps(_coerce_setting(key, value)), json.dumps(_coerce_setting(key, value))),
            )
    return get_settings()


def default_limit_for_role(role: str, settings: dict[str, Any] | None = None) -> int:
    s = settings or get_settings()
    if role == "teacher":
        return int(s["teacher_weekly_tokens"])
    if role == "admin":
        return 10 ** 9  # effectively unlimited for the operator
    return int(s["student_weekly_tokens"])


# ── AI token usage (weekly, Monday-UTC reset) ──────────────────────────────


def week_start(now: float | None = None) -> str:
    """ISO date (YYYY-MM-DD) of the current week's Monday, UTC."""
    import datetime as _dt

    d = _dt.datetime.fromtimestamp(now if now is not None else time.time(), _dt.timezone.utc).date()
    return (d - _dt.timedelta(days=d.weekday())).isoformat()


def add_ai_usage(user_id: str, tokens: int) -> None:
    if tokens <= 0:
        return
    ws = week_start()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO ai_usage (user_id, week_start, tokens) VALUES (?, ?, ?) "
            "ON CONFLICT(user_id, week_start) DO UPDATE SET tokens = tokens + ?",
            (user_id, ws, int(tokens), int(tokens)),
        )


def get_ai_usage(user_id: str) -> dict[str, Any]:
    """Current-week usage + the user's effective weekly limit (per-user
    override, else the role default from platform settings)."""
    ws = week_start()
    with _connect() as conn:
        used_row = conn.execute(
            "SELECT tokens FROM ai_usage WHERE user_id = ? AND week_start = ?",
            (user_id, ws),
        ).fetchone()
        limit_row = conn.execute(
            "SELECT weekly_token_limit, role FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    limit = limit_row["weekly_token_limit"] if limit_row else None
    role = limit_row["role"] if limit_row else "student"
    return {
        "week_start": ws,
        "used": used_row["tokens"] if used_row else 0,
        "limit": limit if limit is not None else default_limit_for_role(role),
        "is_custom_limit": limit is not None,
    }


def set_token_limit(user_id: str, limit: int | None) -> bool:
    """Per-user weekly limit override. None reverts to the global default."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET weekly_token_limit = ? WHERE id = ?",
            (int(limit) if limit is not None else None, user_id),
        )
    return cur.rowcount > 0


# ── Admin ──────────────────────────────────────────────────────────────────


def ensure_admin_from_env() -> None:
    """Bootstrap/refresh the admin account from VELXIO_ADMIN_EMAIL /
    VELXIO_ADMIN_PASSWORD. Creates it if missing, promotes+updates the
    password if the email already exists (so a lost admin password is
    recoverable by redeploying with new env)."""
    email = os.environ.get("VELXIO_ADMIN_EMAIL", "").strip().lower()
    password = os.environ.get("VELXIO_ADMIN_PASSWORD", "")
    if not email or not password:
        return
    with _connect() as conn:
        row = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
        if row:
            salt = secrets.token_bytes(16)
            conn.execute(
                "UPDATE users SET role = 'admin', password_hash = ?, salt = ? WHERE id = ?",
                (_hash_password(password, salt), salt, row["id"]),
            )
            return
    create_user(email, password, email.split("@")[0], role="admin")


def admin_list_users(query: str = "", limit: int = 200) -> list[dict[str, Any]]:
    ws = week_start()
    like = f"%{query.strip().lower()}%"
    with _connect() as conn:
        rows = conn.execute(
            "SELECT u.id, u.email, u.name, u.role, u.created_at, u.weekly_token_limit, "
            "       COALESCE(a.tokens, 0) AS used_this_week "
            "FROM users u "
            "LEFT JOIN ai_usage a ON a.user_id = u.id AND a.week_start = ? "
            "WHERE u.email LIKE ? OR lower(u.name) LIKE ? "
            "ORDER BY u.created_at DESC LIMIT ?",
            (ws, like, like, int(limit)),
        ).fetchall()
    settings = get_settings()
    out = []
    for r in rows:
        d = dict(r)
        d["effective_limit"] = (
            d["weekly_token_limit"]
            if d["weekly_token_limit"] is not None
            else default_limit_for_role(d["role"], settings)
        )
        out.append(d)
    return out


def admin_reset_password(user_id: str, new_password: str) -> bool:
    salt = secrets.token_bytes(16)
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
            (_hash_password(new_password, salt), salt, user_id),
        )
    return cur.rowcount > 0


def admin_delete_user(user_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    return cur.rowcount > 0


def admin_overview() -> dict[str, Any]:
    ws = week_start()
    with _connect() as conn:
        by_role = {
            r["role"]: r["n"]
            for r in conn.execute("SELECT role, COUNT(*) AS n FROM users GROUP BY role")
        }
        week_tokens = conn.execute(
            "SELECT COALESCE(SUM(tokens), 0) FROM ai_usage WHERE week_start = ?", (ws,)
        ).fetchone()[0]
        classes = conn.execute("SELECT COUNT(*) FROM classes").fetchone()[0]
    settings = get_settings()
    return {
        "week_start": ws,
        "users": by_role,
        "classes": classes,
        "week_tokens": week_tokens,
        "default_weekly_limit": int(settings["student_weekly_tokens"]),
        "teacher_weekly_limit": int(settings["teacher_weekly_tokens"]),
    }


def get_quiz_best(user_id: str) -> dict[str, dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT lesson_id, MAX(score) AS best_score, total, COUNT(*) AS attempts "
            "FROM quiz_attempts WHERE user_id = ? GROUP BY lesson_id",
            (user_id,),
        ).fetchall()
    return {
        r["lesson_id"]: {
            "best_score": r["best_score"],
            "total": r["total"],
            "attempts": r["attempts"],
        }
        for r in rows
    }


# ── LMS: assignments & submissions ────────────────────────────────────────


def _json_load(value: Any, default: Any = None) -> Any:
    """Decode a nullable JSON column without allowing a damaged row to take
    down the whole classroom dashboard."""
    if value is None:
        return default
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _json_payload(value: Any, *, default: Any = None) -> str | None:
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        if default is not None:
            return json.dumps(default, ensure_ascii=False, separators=(",", ":"))
        raise ValueError("invalid JSON payload")


def _assignment_dict(row: sqlite3.Row, *, include_private: bool = True) -> dict[str, Any]:
    keys = set(row.keys())
    out: dict[str, Any] = {
        "id": row["id"],
        "class_id": row["class_id"],
        "teacher_id": row["teacher_id"],
        "class_name": row["class_name"] if "class_name" in keys else None,
        "title": row["title"],
        "description": row["description"],
        "instructions": row["instructions"],
        "lesson_id": row["lesson_id"],
        "assignment_type": row["assignment_type"],
        "project_template": _json_load(row["project_template"]),
        "due_at": row["due_at"],
        "max_score": row["max_score"],
        "auto_grade": bool(row["auto_grade"]),
        "status": row["status"],
        "published_at": row["published_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "submission_count": row["submission_count"] if "submission_count" in keys else 0,
        "graded_count": row["graded_count"] if "graded_count" in keys else 0,
        "average_score": row["average_score"] if "average_score" in keys else None,
    }
    # Quiz questions are useful to students, but answer keys are stripped by
    # the HTTP route before this object leaves the server.  Keep the manifest
    # available here so student clients can render a quiz; rubric remains a
    # teacher-only field.
    out["quiz"] = _json_load(row["quiz"]) if "quiz" in keys else None
    if include_private:
        out["rubric"] = _json_load(row["rubric"]) if "rubric" in keys else None
    return out


def _submission_dict(row: sqlite3.Row, *, include_private: bool = True) -> dict[str, Any]:
    keys = set(row.keys())
    out: dict[str, Any] = {
        "id": row["id"],
        "assignment_id": row["assignment_id"],
        "student_id": row["student_id"],
        "student_name": row["student_name"] if "student_name" in keys else None,
        "student_email": row["student_email"] if "student_email" in keys else None,
        "content": row["content"],
        "answers": _json_load(row["answers"]),
        "project_data": _json_load(row["project_data"]),
        "files": _json_load(row["files"]),
        "status": row["status"],
        "submitted": row["status"] in ("submitted", "graded", "returned"),
        "score": row["score"],
        # ``grader_id`` is NULL for deterministic quiz grading.  Exposing the
        # alias lets the teacher dashboard distinguish automatic and manual
        # marks without leaking any answer key.
        "auto_score": row["score"] if row["grader_id"] is None and row["status"] == "graded" else None,
        "max_score": row["max_score"] if "max_score" in keys else None,
        "due_at": row["due_at"] if "due_at" in keys else None,
        "is_late": bool(
            row["submitted_at"] is not None
            and row["due_at"] is not None
            and row["submitted_at"] > row["due_at"]
        ) if "due_at" in keys else False,
        "feedback": row["feedback"],
        "submitted_at": row["submitted_at"],
        "graded_at": row["graded_at"],
        "grader_id": row["grader_id"],
        "attempt_no": row["attempt_no"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if not include_private:
        out.pop("grader_id", None)
    return out


def _assignment_select() -> str:
    return (
        "SELECT a.*, c.name AS class_name, "
        "(SELECT COUNT(*) FROM assignment_submissions s0 WHERE s0.assignment_id = a.id "
        " AND s0.status IN ('submitted', 'graded', 'returned')) AS submission_count, "
        "(SELECT COUNT(*) FROM assignment_submissions s1 WHERE s1.assignment_id = a.id "
        " AND s1.status IN ('graded', 'returned')) AS graded_count, "
        "(SELECT AVG(s2.score) FROM assignment_submissions s2 WHERE s2.assignment_id = a.id "
        " AND s2.score IS NOT NULL) AS average_score "
        "FROM assignments a JOIN classes c ON c.id = a.class_id "
    )


def class_owned_by(user_id: str, class_id: str) -> bool:
    with _connect() as conn:
        return conn.execute(
            "SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?", (class_id, user_id)
        ).fetchone() is not None


def class_member(user_id: str, class_id: str) -> bool:
    with _connect() as conn:
        return conn.execute(
            "SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?",
            (class_id, user_id),
        ).fetchone() is not None


def create_assignment(
    teacher_id: str,
    class_id: str,
    *,
    title: str,
    description: str = "",
    instructions: str = "",
    lesson_id: str | None = None,
    assignment_type: str = "project",
    project_template: Any = None,
    quiz: Any = None,
    rubric: Any = None,
    due_at: float | None = None,
    max_score: float = 100,
    auto_grade: bool = False,
    status: str = "draft",
) -> dict[str, Any] | None:
    """Create an assignment owned by ``teacher_id``. None means unknown or
    non-owned class, or the per-class assignment quota was reached."""
    payloads = [_json_payload(project_template), _json_payload(quiz), _json_payload(rubric)]
    if sum(len(p.encode("utf-8")) for p in payloads if p is not None) > MAX_ASSIGNMENT_BYTES:
        raise ValueError("assignment too large")
    with _connect() as conn:
        cls = conn.execute(
            "SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?",
            (class_id, teacher_id),
        ).fetchone()
        if not cls:
            return None
        count = conn.execute(
            "SELECT COUNT(*) FROM assignments WHERE class_id = ?", (class_id,)
        ).fetchone()[0]
        if count >= MAX_ASSIGNMENTS_PER_CLASS:
            return None
        aid = uuid.uuid4().hex
        now = time.time()
        published_at = now if status == "published" else None
        conn.execute(
            "INSERT INTO assignments (id, class_id, teacher_id, title, description, instructions, "
            "lesson_id, assignment_type, project_template, quiz, rubric, due_at, max_score, "
            "auto_grade, status, published_at, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                aid,
                class_id,
                teacher_id,
                title,
                description,
                instructions,
                lesson_id,
                assignment_type,
                payloads[0],
                payloads[1],
                payloads[2],
                due_at,
                float(max_score),
                1 if auto_grade else 0,
                status,
                published_at,
                now,
                now,
            ),
        )
        row = conn.execute(_assignment_select() + "WHERE a.id = ?", (aid,)).fetchone()
    return _assignment_dict(row) if row else None


def get_assignment(assignment_id: str, *, include_private: bool = True) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(_assignment_select() + "WHERE a.id = ?", (assignment_id,)).fetchone()
    return _assignment_dict(row, include_private=include_private) if row else None


def get_assignment_for_user(
    assignment_id: str, user_id: str, *, role: str = "student", include_private: bool = False
) -> dict[str, Any] | None:
    """Return an assignment only when the caller owns its class or is a
    member. Students cannot discover unpublished assignments."""
    with _connect() as conn:
        row = conn.execute(
            _assignment_select()
            + "WHERE a.id = ? AND ("
            "a.teacher_id = ? OR (? = 'admin') OR "
            "(a.status = 'published' AND EXISTS (SELECT 1 FROM class_members m "
            " WHERE m.class_id = a.class_id AND m.user_id = ?)) )",
            (assignment_id, user_id, role, user_id),
        ).fetchone()
    if not row:
        return None
    return _assignment_dict(row, include_private=include_private or role in ("teacher", "admin"))


def list_assignments(
    user_id: str,
    *,
    role: str = "student",
    class_id: str | None = None,
    include_private: bool = False,
) -> list[dict[str, Any]]:
    """List assignments visible to a user. Teachers see drafts in classes
    they own; students see published assignments in classes they joined."""
    params: list[Any] = []
    where: list[str] = []
    if role in ("teacher", "admin"):
        if role == "admin":
            where.append("1 = 1")
        else:
            where.append("a.teacher_id = ?")
            params.append(user_id)
    else:
        where.append(
            "a.status = 'published' AND EXISTS (SELECT 1 FROM class_members m "
            "WHERE m.class_id = a.class_id AND m.user_id = ?)"
        )
        params.append(user_id)
    if class_id:
        where.append("a.class_id = ?")
        params.append(class_id)
    sql = _assignment_select() + "WHERE " + " AND ".join(where) + " ORDER BY " \
        "CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, a.due_at, a.created_at DESC"
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_assignment_dict(r, include_private=include_private or role in ("teacher", "admin")) for r in rows]


def update_assignment(teacher_id: str, assignment_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {
        "title", "description", "instructions", "lesson_id", "assignment_type",
        "project_template", "quiz", "rubric", "due_at", "max_score", "auto_grade", "status",
    }
    updates = {k: v for k, v in patch.items() if k in allowed}
    if not updates:
        return get_assignment(assignment_id)
    payloads = {k: _json_payload(updates[k]) for k in ("project_template", "quiz", "rubric") if k in updates}
    if sum(len((p or "").encode("utf-8")) for p in payloads.values()) > MAX_ASSIGNMENT_BYTES:
        raise ValueError("assignment too large")
    if "auto_grade" in updates:
        updates["auto_grade"] = 1 if updates["auto_grade"] else 0
    if "max_score" in updates:
        updates["max_score"] = float(updates["max_score"])
    updates.update(payloads)
    if "status" in updates and updates["status"] not in ("draft", "published", "archived"):
        raise ValueError("invalid assignment status")
    now = time.time()
    assignments = list(updates.items())
    sets = ", ".join(f"{key} = ?" for key, _ in assignments) + ", updated_at = ?"
    args = [value for _, value in assignments] + [now, assignment_id, teacher_id]
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE assignments SET {sets} WHERE id = ? AND teacher_id = ?", args
        )
        if cur.rowcount == 0:
            return None
        if updates.get("status") == "published":
            conn.execute(
                "UPDATE assignments SET published_at = COALESCE(published_at, ?) WHERE id = ?",
                (now, assignment_id),
            )
        elif updates.get("status") == "draft":
            conn.execute("UPDATE assignments SET published_at = NULL WHERE id = ?", (assignment_id,))
        row = conn.execute(_assignment_select() + "WHERE a.id = ?", (assignment_id,)).fetchone()
    return _assignment_dict(row) if row else None


def set_assignment_status(teacher_id: str, assignment_id: str, status: str) -> dict[str, Any] | None:
    return update_assignment(teacher_id, assignment_id, {"status": status})


def delete_assignment(teacher_id: str, assignment_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "DELETE FROM assignments WHERE id = ? AND teacher_id = ?", (assignment_id, teacher_id)
        )
    return cur.rowcount > 0


def _submission_select() -> str:
    return (
        "SELECT s.*, u.name AS student_name, u.email AS student_email, "
        "a.max_score AS max_score, a.due_at AS due_at "
        "FROM assignment_submissions s "
        "JOIN users u ON u.id = s.student_id "
        "JOIN assignments a ON a.id = s.assignment_id "
    )


def save_submission(
    assignment_id: str,
    student_id: str,
    *,
    content: str = "",
    answers: Any = None,
    project_data: Any = None,
    files: Any = None,
    submit: bool = True,
) -> tuple[dict[str, Any] | None, bool]:
    """Create or replace the student's submission. Returns (submission,
    created). The unique assignment/student key keeps retries idempotent."""
    answer_payload = _json_payload(answers)
    project_payload = _json_payload(project_data)
    files_payload = _json_payload(files)
    total_bytes = len(content.encode("utf-8")) + sum(
        len(p.encode("utf-8")) for p in (answer_payload, project_payload, files_payload) if p is not None
    )
    if total_bytes > MAX_SUBMISSION_BYTES:
        raise ValueError("submission too large")
    now = time.time()
    status = "submitted" if submit else "draft"
    submitted_at = now if submit else None
    with _connect() as conn:
        assignment = conn.execute(
            "SELECT id, class_id, status FROM assignments WHERE id = ?", (assignment_id,)
        ).fetchone()
        if not assignment:
            return None, False
        member = conn.execute(
            "SELECT 1 FROM class_members WHERE class_id = ? AND user_id = ?",
            (assignment["class_id"], student_id),
        ).fetchone()
        if not member or assignment["status"] != "published":
            return None, False
        old = conn.execute(
            "SELECT id, attempt_no FROM assignment_submissions WHERE assignment_id = ? AND student_id = ?",
            (assignment_id, student_id),
        ).fetchone()
        if old:
            attempt_no = int(old["attempt_no"]) + (1 if submit else 0)
            conn.execute(
                "UPDATE assignment_submissions SET content = ?, answers = ?, project_data = ?, files = ?, "
                "status = ?, submitted_at = CASE WHEN ? THEN ? ELSE submitted_at END, "
                "score = CASE WHEN ? THEN NULL ELSE score END, "
                "feedback = CASE WHEN ? THEN '' ELSE feedback END, "
                "graded_at = CASE WHEN ? THEN NULL ELSE graded_at END, grader_id = CASE WHEN ? THEN NULL ELSE grader_id END, "
                "attempt_no = ?, updated_at = ? WHERE id = ?",
                (
                    content,
                    answer_payload,
                    project_payload,
                    files_payload,
                    status,
                    1 if submit else 0,
                    submitted_at,
                    1 if submit else 0,
                    1 if submit else 0,
                    1 if submit else 0,
                    1 if submit else 0,
                    attempt_no,
                    now,
                    old["id"],
                ),
            )
            sid = old["id"]
            created = False
        else:
            sid = uuid.uuid4().hex
            attempt_no = 1
            conn.execute(
                "INSERT INTO assignment_submissions (id, assignment_id, student_id, content, answers, "
                "project_data, files, status, submitted_at, attempt_no, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    sid,
                    assignment_id,
                    student_id,
                    content,
                    answer_payload,
                    project_payload,
                    files_payload,
                    status,
                    submitted_at,
                    attempt_no,
                    now,
                    now,
                ),
            )
            created = True
        row = conn.execute(_submission_select() + "WHERE s.id = ?", (sid,)).fetchone()
    return (_submission_dict(row) if row else None), created


def get_submission(
    assignment_id: str, *, student_id: str | None = None, submission_id: str | None = None
) -> dict[str, Any] | None:
    where = ["s.assignment_id = ?"]
    args: list[Any] = [assignment_id]
    if student_id:
        where.append("s.student_id = ?")
        args.append(student_id)
    if submission_id:
        where.append("s.id = ?")
        args.append(submission_id)
    with _connect() as conn:
        row = conn.execute(_submission_select() + "WHERE " + " AND ".join(where), args).fetchone()
    return _submission_dict(row) if row else None


def list_submissions(assignment_id: str, *, status: str | None = None) -> list[dict[str, Any]]:
    where = ["s.assignment_id = ?"]
    args: list[Any] = [assignment_id]
    if status:
        where.append("s.status = ?")
        args.append(status)
    with _connect() as conn:
        rows = conn.execute(
            _submission_select() + "WHERE " + " AND ".join(where) + " ORDER BY s.updated_at DESC", args
        ).fetchall()
    return [_submission_dict(r) for r in rows]


def grade_submission(
    submission_id: str,
    grader_id: str,
    *,
    score: float | None = None,
    feedback: str = "",
    status: str = "graded",
) -> dict[str, Any] | None:
    if status not in ("graded", "returned", "submitted"):
        raise ValueError("invalid submission status")
    now = time.time()
    with _connect() as conn:
        row = conn.execute(
            _submission_select()
            + "WHERE s.id = ? AND EXISTS (SELECT 1 FROM assignments a2 WHERE a2.id = s.assignment_id "
            "AND a2.teacher_id = ?)",
            (submission_id, grader_id),
        ).fetchone()
        if not row:
            return None
        max_score = float(row["max_score"])
        if score is not None and (score < 0 or score > max_score):
            raise ValueError("score out of range")
        conn.execute(
            "UPDATE assignment_submissions SET score = ?, feedback = ?, status = ?, graded_at = ?, "
            "grader_id = ?, updated_at = ? WHERE id = ?",
            (
                float(score) if score is not None else None,
                feedback,
                status,
                now if status in ("graded", "returned") else None,
                grader_id if status in ("graded", "returned") else None,
                now,
                submission_id,
            ),
        )
        updated = conn.execute(_submission_select() + "WHERE s.id = ?", (submission_id,)).fetchone()
    return _submission_dict(updated) if updated else None


def auto_grade_submission(
    submission_id: str, *, score: float, feedback: str = ""
) -> dict[str, Any] | None:
    """Persist a score generated by the server's deterministic quiz grader.
    This deliberately does not accept a caller identity: the route only
    invokes it immediately after proving the student owns a published
    assignment with ``auto_grade`` enabled."""
    now = time.time()
    with _connect() as conn:
        row = conn.execute(_submission_select() + "WHERE s.id = ?", (submission_id,)).fetchone()
        if not row:
            return None
        max_score = float(row["max_score"])
        bounded = max(0.0, min(float(score), max_score))
        conn.execute(
            "UPDATE assignment_submissions SET score = ?, feedback = ?, status = 'graded', "
            "graded_at = ?, grader_id = NULL, updated_at = ? WHERE id = ?",
            (bounded, feedback, now, now, submission_id),
        )
        updated = conn.execute(_submission_select() + "WHERE s.id = ?", (submission_id,)).fetchone()
    return _submission_dict(updated) if updated else None


# ── LMS: teacher dashboard/reporting ──────────────────────────────────────


def _split_filter_values(value: str | list[str] | tuple[str, ...] | None) -> list[str]:
    """Return normalised comma-separated filter values.

    Query parameters arrive as strings in the HTTP route, while a few callers
    (including exports and tests) pass a list directly.  Keeping this helper in
    the persistence layer makes all report entry points use the same semantics
    and prevents accidental SQL interpolation of user supplied values.
    """
    if value is None:
        return []
    values: list[str] = []
    source = value if isinstance(value, (list, tuple)) else str(value).split(",")
    for item in source:
        for part in (item if isinstance(item, str) else str(item)).split(","):
            part = part.strip()
            if part and part not in values:
                values.append(part)
    return values


def _dashboard_status(row: dict[str, Any]) -> str:
    """Return persisted status, including roster rows with no submit.

    ``is_late`` remains an independent flag.  A late submission may already be
    graded, and replacing ``graded`` with ``late`` would hide that fact from a
    teacher's counters and CSV export.  The caller handles a ``late`` filter by
    checking this flag in addition to the persisted status.
    """
    if row.get("status") in (None, "", "missing"):
        return "missing"
    return str(row["status"])


def _dashboard_matches_status(row: dict[str, Any], statuses: set[str]) -> bool:
    """Match a status filter without collapsing late + graded states."""
    if not statuses:
        return True
    state = str(row.get("status") or "missing").casefold()
    if state in statuses:
        return True
    return "late" in statuses and bool(row.get("is_late"))


def _dashboard_sort_key(name: str | None) -> str:
    aliases = {
        "student": "student_name",
        "name": "student_name",
        "score": "score",
        "submitted": "submitted_at",
        "submittedAt": "submitted_at",
        "updated": "updated_at",
        "assignment": "assignment_title",
        "class": "class_name",
        "deadline": "due_at",
    }
    return aliases.get(str(name or "updated_at"), str(name or "updated_at"))


def get_teacher_dashboard(
    teacher_id: str,
    class_ids: str | list[str] | tuple[str, ...] | None = None,
    *,
    status: str | None = None,
    q: str | None = None,
    sort: str | None = None,
    order: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> dict[str, Any]:
    """Aggregate class, roster, lesson and assignment progress for a teacher.

    The existing ``/classes/{id}/report`` endpoint intentionally remains a
    compact per-class progress response.  This report is the richer, bounded
    view used by a teacher managing several classes: every member × assignment
    pair is represented, including ``missing`` rows for students that have not
    submitted yet.  ``class_ids``, ``status`` and ``q`` are applied before
    pagination; ``rows`` and ``submissions`` are aliases to ease consumption by
    existing dashboards.

    Only classes owned by ``teacher_id`` are ever selected.  Unknown IDs are
    ignored (rather than revealing whether another teacher owns one).
    """
    requested_classes = _split_filter_values(class_ids)
    statuses = {s.casefold() for s in _split_filter_values(status)}
    # Keep report filters forward-compatible with richer grading states used
    # by newer clients.  The current storage has draft/submitted/graded/
    # returned plus the derived missing/late states; these aliases map onto
    # the closest persisted state instead of making a harmless filter fail.
    if "not_started" in statuses:
        statuses.add("missing")
    if "in_progress" in statuses:
        statuses.add("draft")
    if "grading" in statuses:
        statuses.add("submitted")
    if "expired" in statuses:
        statuses.add("late")
    search = str(q or "").strip().casefold()
    sort_key = _dashboard_sort_key(sort)
    allowed_sort = {
        "student_name", "student_email", "class_name", "assignment_title",
        "status", "score", "submitted_at", "graded_at", "due_at", "updated_at",
        "attempt_no",
    }
    if sort_key not in allowed_sort:
        sort_key = "updated_at"
    descending = str(order or "desc").casefold() not in ("asc", "ascending", "up")
    try:
        row_limit = None if limit is None else max(0, min(int(limit), MAX_DASHBOARD_ROWS))
    except (TypeError, ValueError):
        row_limit = 100
    try:
        row_offset = max(0, int(offset))
    except (TypeError, ValueError):
        row_offset = 0

    with _connect() as conn:
        class_where = ["c.teacher_id = ?"]
        class_params: list[Any] = [teacher_id]
        if requested_classes:
            placeholders = ",".join("?" for _ in requested_classes)
            class_where.append(f"c.id IN ({placeholders})")
            class_params.extend(requested_classes)
        class_rows = conn.execute(
            "SELECT c.id, c.name, c.code, c.created_at "
            "FROM classes c WHERE " + " AND ".join(class_where) + " ORDER BY c.created_at DESC",
            class_params,
        ).fetchall()
        classes = [dict(row) for row in class_rows]
        selected_ids = [row["id"] for row in class_rows]
        if not selected_ids:
            return {
                "classes": [], "students": [], "assignments": [], "rows": [], "submissions": [],
                "total": 0, "summary": {
                    "class_count": 0, "student_count": 0, "assignment_count": 0,
                    "submission_count": 0, "submitted_count": 0, "graded_count": 0,
                    "missing_count": 0, "late_count": 0, "average_score": None,
                    "completion_rate": 0,
                },
                "filters": {
                    "class_ids": requested_classes, "status": sorted(statuses),
                    "q": q or "", "sort": sort_key, "order": "desc" if descending else "asc",
                },
                "pagination": {"offset": row_offset, "limit": row_limit, "total": 0},
            }

        ids_placeholder = ",".join("?" for _ in selected_ids)
        members = conn.execute(
            "SELECT m.class_id, u.id, u.name, u.email, m.joined_at "
            "FROM class_members m JOIN users u ON u.id = m.user_id "
            f"WHERE m.class_id IN ({ids_placeholder}) ORDER BY u.name COLLATE NOCASE, u.email",
            selected_ids,
        ).fetchall()
        assignments = conn.execute(
            _assignment_select()
            + f"WHERE a.class_id IN ({ids_placeholder}) ORDER BY a.created_at DESC",
            selected_ids,
        ).fetchall()
        submissions = conn.execute(
            _submission_select()
            + "WHERE a.class_id IN (" + ids_placeholder + ") ORDER BY s.updated_at DESC",
            selected_ids,
        ).fetchall()

        member_rows = [dict(row) for row in members]
        assignment_rows = [_assignment_dict(row) for row in assignments]
        assignment_by_id = {row["id"]: row for row in assignment_rows}
        class_by_id = {row["id"]: row for row in classes}
        members_by_class: dict[str, list[dict[str, Any]]] = {}
        for member in member_rows:
            members_by_class.setdefault(member["class_id"], []).append(member)

        # One latest row exists per assignment/student in the current schema.
        # Keep the dictionary keyed this way so the function remains compatible
        # with databases upgraded to a submission-history table later.
        submission_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for row in submissions:
            item = _submission_dict(row)
            submission_by_key[(item["assignment_id"], item["student_id"])] = item

        student_ids = sorted({member["id"] for member in member_rows})
        progress_counts: dict[str, int] = {}
        quiz_counts: dict[str, int] = {}
        if student_ids:
            student_placeholder = ",".join("?" for _ in student_ids)
            progress_counts = {
                row["user_id"]: int(row["count"])
                for row in conn.execute(
                    "SELECT user_id, COUNT(*) AS count FROM lesson_progress "
                    f"WHERE status = 'done' AND user_id IN ({student_placeholder}) GROUP BY user_id",
                    student_ids,
                )
            }
            quiz_counts = {
                row["user_id"]: int(row["count"])
                for row in conn.execute(
                    "SELECT user_id, COUNT(*) AS count FROM quiz_attempts "
                    f"WHERE user_id IN ({student_placeholder}) GROUP BY user_id",
                    student_ids,
                )
            }

    # Build complete roster × assignment rows outside the DB context.  Drafts
    # are included for teachers; students simply never receive this endpoint.
    all_rows: list[dict[str, Any]] = []
    for assignment in assignment_rows:
        class_meta = class_by_id.get(assignment["class_id"], {})
        for member in members_by_class.get(assignment["class_id"], []):
            submission = submission_by_key.get((assignment["id"], member["id"]))
            if submission:
                row = dict(submission)
            else:
                row = {
                    "id": None,
                    "assignment_id": assignment["id"],
                    "student_id": member["id"],
                    "student_name": member["name"],
                    "student_email": member["email"],
                    "content": "",
                    "answers": None,
                    "project_data": None,
                    "files": None,
                    "status": "missing",
                    "submitted": False,
                    "score": None,
                    "auto_score": None,
                    "max_score": assignment["max_score"],
                    "due_at": assignment["due_at"],
                    "is_late": False,
                    "feedback": "",
                    "submitted_at": None,
                    "graded_at": None,
                    "grader_id": None,
                    "attempt_no": 0,
                    "created_at": member["joined_at"],
                    "updated_at": member["joined_at"],
                }
            row.update(
                {
                    "class_id": assignment["class_id"],
                    "class_name": class_meta.get("name"),
                    "assignment_title": assignment["title"],
                    "assignment_type": assignment["assignment_type"],
                    "assignment_status": assignment["status"],
                    "lesson_id": assignment["lesson_id"],
                    "published_at": assignment["published_at"],
                }
            )
            row["status"] = _dashboard_status(row)
            if not _dashboard_matches_status(row, statuses):
                continue
            if search:
                haystack = " ".join(
                    str(row.get(key) or "")
                    for key in (
                        "student_name", "student_email", "class_name", "assignment_title",
                    )
                ).casefold()
                if search not in haystack:
                    continue
            # Omit large private payloads from a dashboard response.  Teachers
            # can still retrieve full content through the existing submission
            # endpoint; reports should remain fast and safe to export.
            for private_key in ("answers", "project_data", "files", "content", "grader_id"):
                row.pop(private_key, None)
            all_rows.append(row)
            if len(all_rows) >= MAX_DASHBOARD_ROWS:
                break
        if len(all_rows) >= MAX_DASHBOARD_ROWS:
            break

    def _sort_value(item: dict[str, Any]) -> tuple[int, Any]:
        value = item.get(sort_key)
        # SQLite NULL ordering is not useful in a dashboard.  Keep missing
        # values at the end for either direction and use a stable text tie-break
        # so pagination does not jump between requests.
        if value is None:
            return (1, "")
        if isinstance(value, str):
            return (0, value.casefold())
        return (0, value)

    all_rows.sort(key=lambda item: (_sort_value(item), str(item.get("id") or "")), reverse=descending)
    total_rows = len(all_rows)
    if row_limit is None:
        page_rows = all_rows[row_offset:]
    else:
        page_rows = all_rows[row_offset : row_offset + row_limit]

    # Per-student summary uses the filtered rows.  This makes q/status filters
    # useful for a teacher scanning a particular assignment or late work.
    student_summary: dict[str, dict[str, Any]] = {}
    for member in member_rows:
        student_summary.setdefault(
            member["id"],
            {
                "id": member["id"], "name": member["name"], "email": member["email"],
                "class_ids": [], "class_names": [], "joined_at": member["joined_at"],
                "assignment_count": 0, "submitted_count": 0, "graded_count": 0,
                "missing_count": 0, "late_count": 0, "average_score": None,
                "progress_count": progress_counts.get(member["id"], 0),
                "quiz_attempts": quiz_counts.get(member["id"], 0),
            },
        )
        item = student_summary[member["id"]]
        if member["class_id"] not in item["class_ids"]:
            item["class_ids"].append(member["class_id"])
            item["class_names"].append(class_by_id[member["class_id"]]["name"])
    scores_by_student: dict[str, list[float]] = {}
    for row in all_rows:
        item = student_summary.get(row["student_id"])
        if not item:
            continue
        item["assignment_count"] += 1
        state = row["status"]
        if state in ("submitted", "graded", "returned", "late"):
            item["submitted_count"] += 1
        if state in ("graded", "returned"):
            item["graded_count"] += 1
        if state == "missing":
            item["missing_count"] += 1
        if state == "late" or row.get("is_late"):
            item["late_count"] += 1
        if row.get("score") is not None:
            scores_by_student.setdefault(row["student_id"], []).append(float(row["score"]))
    for student_id, item in student_summary.items():
        scores = scores_by_student.get(student_id, [])
        item["average_score"] = round(sum(scores) / len(scores), 2) if scores else None
        item["completion_rate"] = round(
            100 * item["submitted_count"] / item["assignment_count"], 2
        ) if item["assignment_count"] else 0

    # Class-level counters are based on the same filtered rows.  Include member
    # counts from the complete roster so a class with no matching submissions is
    # still visible in the teacher's selector.
    class_summary: list[dict[str, Any]] = []
    for class_meta in classes:
        class_rows = [row for row in all_rows if row["class_id"] == class_meta["id"]]
        scores = [float(row["score"]) for row in class_rows if row.get("score") is not None]
        submitted_count = sum(row["status"] in ("submitted", "graded", "returned", "late") for row in class_rows)
        graded_count = sum(row["status"] in ("graded", "returned") for row in class_rows)
        item = dict(class_meta)
        item.update(
            {
                "member_count": len(members_by_class.get(class_meta["id"], [])),
                "assignment_count": len({row["assignment_id"] for row in class_rows}),
                "submission_count": submitted_count,
                "graded_count": graded_count,
                "missing_count": sum(row["status"] == "missing" for row in class_rows),
                "late_count": sum(row["status"] == "late" or row.get("is_late") for row in class_rows),
                "average_score": round(sum(scores) / len(scores), 2) if scores else None,
                "completion_rate": round(100 * submitted_count / len(class_rows), 2) if class_rows else 0,
            }
        )
        class_summary.append(item)

    submitted_rows = [row for row in all_rows if row["status"] != "missing"]
    score_values = [float(row["score"]) for row in all_rows if row.get("score") is not None]
    summary = {
        "class_count": len(classes),
        "student_count": len(member_rows),
        "assignment_count": len(assignment_rows),
        "submission_count": len(submitted_rows),
        "submitted_count": sum(row["status"] in ("submitted", "graded", "returned", "late") for row in all_rows),
        "graded_count": sum(row["status"] in ("graded", "returned") for row in all_rows),
        "missing_count": sum(row["status"] == "missing" for row in all_rows),
        "late_count": sum(row["status"] == "late" or row.get("is_late") for row in all_rows),
        "average_score": round(sum(score_values) / len(score_values), 2) if score_values else None,
        "completion_rate": round(
            100 * sum(row["status"] in ("submitted", "graded", "returned", "late") for row in all_rows)
            / len(all_rows), 2
        ) if all_rows else 0,
    }
    assignment_summary: list[dict[str, Any]] = []
    for assignment in assignment_rows:
        rows = [row for row in all_rows if row["assignment_id"] == assignment["id"]]
        # Start from the assignment aggregate (which includes submissions not
        # matching q/status), then expose filtered counters for the current view.
        item = dict(assignment)
        item.update(
            {
                "class_name": class_by_id.get(assignment["class_id"], {}).get("name"),
                "filtered_submission_count": sum(row["status"] != "missing" for row in rows),
                "filtered_graded_count": sum(row["status"] in ("graded", "returned") for row in rows),
                "filtered_missing_count": sum(row["status"] == "missing" for row in rows),
                "filtered_late_count": sum(row["status"] == "late" or row.get("is_late") for row in rows),
            }
        )
        assignment_summary.append(item)

    result_rows = page_rows
    return {
        "classes": class_summary,
        "students": list(student_summary.values()),
        "assignments": assignment_summary,
        "rows": result_rows,
        "submissions": result_rows,
        "total": total_rows,
        "summary": summary,
        "totals": {
            "students": summary["student_count"],
            "assignments": summary["assignment_count"],
            "submissions": summary["submission_count"],
            "completion_rate": summary["completion_rate"],
        },
        "filters": {
            "class_ids": selected_ids,
            "status": sorted(statuses),
            "q": q or "",
            "sort": sort_key,
            "order": "desc" if descending else "asc",
        },
        "pagination": {"offset": row_offset, "limit": row_limit, "total": total_rows},
    }


def get_teacher_submission_rows(
    teacher_id: str,
    class_ids: str | list[str] | tuple[str, ...] | None = None,
    *,
    status: str | None = None,
    q: str | None = None,
    sort: str | None = None,
    order: str | None = None,
) -> list[dict[str, Any]]:
    """Return unpaginated dashboard rows for CSV export.

    The export deliberately reuses dashboard filtering/sorting so what a
    teacher downloads is exactly what was visible in the report.  Payload-heavy
    fields were already removed by ``get_teacher_dashboard``.
    """
    report = get_teacher_dashboard(
        teacher_id,
        class_ids,
        status=status,
        q=q,
        sort=sort,
        order=order,
        limit=None,
        offset=0,
    )
    return list(report.get("rows", []))
