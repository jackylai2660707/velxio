#!/usr/bin/env bash
# One-shot dev launcher: starts the FastAPI backend (8001) and the Vite dev
# server (5173) DETACHED (setsid + nohup), so they keep running after the
# terminal closes. Logs go to .devlogs/, PIDs to .devlogs/*.pid.
#
#   ./scripts/dev-start.sh          # start (restarts anything already running)
#   ./scripts/dev-stop.sh           # stop both
#   tail -f .devlogs/backend.log    # watch logs
#
# Backend env (API relay config etc.) is read from backend/.env.agent when
# present — see docs/wiki/ai-assistant.md.

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.devlogs"
mkdir -p "$LOGS"

stop_one() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      # negative pid = whole setsid process group (uvicorn workers, vite children)
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
    fi
    rm -f "$pidfile"
  fi
}

echo "[dev] stopping any previous instances…"
stop_one "$LOGS/backend.pid"
stop_one "$LOGS/frontend.pid"
sleep 1

echo "[dev] starting backend on :8001…"
(
  cd "$ROOT/backend"
  if [ -f .env.agent ]; then
    set -a
    # shellcheck disable=SC1091
    source .env.agent
    set +a
  fi
  exec setsid nohup uvicorn app.main:app --host 0.0.0.0 --port 8001 \
    > "$LOGS/backend.log" 2>&1
) &
disown
# the subshell's child is the setsid leader; find it via the port below

echo "[dev] starting frontend on :5173…"
(
  cd "$ROOT/frontend"
  export NODE_PATH="$PWD/node_modules"   # generate-metadata needs it (see CLAUDE.md)
  exec setsid nohup npm run dev -- --host 0.0.0.0 \
    > "$LOGS/frontend.log" 2>&1
) &
disown

echo "[dev] waiting for readiness…"
ok_backend=""
ok_frontend=""
for _ in $(seq 1 60); do
  [ -z "$ok_backend" ] && curl -sf -m 2 -o /dev/null http://localhost:8001/api/agent/config && ok_backend=1 \
    && pgrep -f 'uvicorn app.main:app --host 0.0.0.0 --port 8001' | head -1 > "$LOGS/backend.pid"
  [ -z "$ok_frontend" ] && curl -sf -m 2 -o /dev/null http://localhost:5173/ && ok_frontend=1 \
    && pgrep -f 'vite --host 0.0.0.0' | head -1 > "$LOGS/frontend.pid"
  [ -n "$ok_backend" ] && [ -n "$ok_frontend" ] && break
  sleep 2
done

if [ -n "$ok_backend" ] && [ -n "$ok_frontend" ]; then
  echo "[dev] ✅ up:  http://localhost:5173  (backend :8001)"
  echo "[dev] logs: $LOGS/backend.log · $LOGS/frontend.log"
else
  [ -z "$ok_backend" ] && echo "[dev] ❌ backend not ready — tail $LOGS/backend.log"
  [ -z "$ok_frontend" ] && echo "[dev] ❌ frontend not ready — tail $LOGS/frontend.log"
  exit 1
fi
