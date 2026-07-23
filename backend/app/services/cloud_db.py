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
