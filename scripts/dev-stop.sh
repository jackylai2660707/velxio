#!/usr/bin/env bash
# Stops the detached dev servers started by dev-start.sh.
set -u
cd "$(dirname "$0")/.."
LOGS="$PWD/.devlogs"

stopped=""
for name in backend frontend; do
  pidfile="$LOGS/$name.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null
      stopped="$stopped $name"
    fi
    rm -f "$pidfile"
  fi
done

# Belt & suspenders: catch instances started outside the pid files
pkill -f 'uvicorn app.main:app --host 0.0.0.0 --port 8001' 2>/dev/null && stopped="$stopped backend(pattern)"
pkill -f 'vite --host 0.0.0.0' 2>/dev/null && stopped="$stopped frontend(pattern)"

echo "[dev] stopped:${stopped:- nothing was running}"
