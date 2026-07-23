# Cloud accounts & storage (fork feature)

Self-contained accounts + server-side persistence for this fork: user
profiles, **projects** (full workspace snapshots) and **AI chat sessions**
live in a single SQLite file on your own backend. Upstream OSS Velxio is
deliberately stateless (its auth lives in the private velxio-prod overlay);
this fork ships a minimal, dependency-free replacement.

## What you get

- **Sign up / sign in** from the header (top right). Sessions are 30-day
  HMAC tokens stored in the browser.
- **Projects in the cloud** — the editor's Save button opens the cloud
  projects modal when signed in: save (overwrite or as-new), open, delete.
  Payloads are the same `VlxPayload` snapshots as `.vlx` files (a local
  `.vlx` download button stays in the modal). When anonymous, Save opens
  the sign-in modal instead.
- **AI chat sessions in the cloud** — while signed in, the current
  conversation auto-syncs (3s debounce, ☁ indicator in the panel header).
  The panel's clock icon opens the history view: switch between sessions,
  start a new one, delete old ones. Sessions follow you across devices.

## Storage & security model

- Data: `$VELXIO_DATA_DIR/velxio-cloud.db` (default `backend/data/`, which
  is inside the Docker volume `/app/data` in the standalone image).
- Passwords: PBKDF2-HMAC-SHA256 (200k iterations, per-user salt).
  Tokens: HMAC-signed, secret auto-generated at
  `$VELXIO_DATA_DIR/secret_key` (or `VELXIO_SECRET_KEY` env).
- Quotas: 100 projects / 100 chats per user; 2 MB per project,
  1.5 MB per chat.
- Intended for **self-hosted classroom / personal instances**. There is no
  email verification, password reset, or rate limiting — put a reverse
  proxy with TLS (and a limiter, if public) in front before exposing it to
  the internet, and tell users not to reuse important passwords.

## Endpoints

- `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/auth/me`
- `GET|POST /api/cloud/projects` · `GET|PUT|DELETE /api/cloud/projects/{id}`
- `GET|POST /api/cloud/chats` (POST upserts by id) · `GET|DELETE /api/cloud/chats/{id}`

## Key files

- `backend/app/services/cloud_db.py` — SQLite schema + stdlib crypto
- `backend/app/api/routes/auth.py`, `cloud.py` — endpoints
- `frontend/src/cloud/` — `cloudApi.ts`, `useCloudStore.ts`, header widget,
  auth/projects modals, `install.ts` (hooks into proSession/proSaveAction)
- Chat history view: `AgentChatPanel.tsx` (`HistoryView`)
- Tests: `test/backend/unit/test_cloud_storage.py`
