#!/usr/bin/env bash
# Restarts the backend for local verification.
#
# Tracks the child PID in a file rather than discovering it from the port:
# `ss`/`lsof` are not present in every container, and a pattern match on the
# process command line also matches the shell running this script, which makes
# the script kill itself. A PID file works everywhere.
set -euo pipefail

PORT="${BACKEND_PORT:-4100}"
LOG="${BACKEND_LOG:-/tmp/backend.log}"
PIDFILE="${BACKEND_PIDFILE:-/tmp/shelf-backend.pid}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

stop_existing() {
  [ -f "$PIDFILE" ] || return 0
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 0

  # Kill the whole process group: `npx` spawns node as a child, so signalling
  # only the recorded pid leaves the listener holding the port.
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  for _ in $(seq 1 24); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
}

stop_existing

cd "$ROOT"
setsid npx tsx backend/src/server.ts > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "backend ready on ${PORT} (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  # A crash is worth reporting immediately rather than after the full timeout.
  if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "backend exited during startup:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  sleep 0.5
done

echo "backend did not become ready; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
