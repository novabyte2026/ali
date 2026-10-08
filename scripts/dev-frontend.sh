#!/usr/bin/env bash
# Rebuilds and restarts the frontend for local verification.
#
# Always rebuilds before starting: `next start` serves whatever is in .next,
# so starting without a rebuild after a source change serves an HTML shell that
# references chunk filenames the new build no longer has, and every script tag
# 400s.
set -euo pipefail

PORT="${FRONTEND_PORT:-3100}"
API="${NEXT_PUBLIC_API_URL:-http://127.0.0.1:4100}"
LOG="${FRONTEND_LOG:-/tmp/frontend.log}"
PIDFILE="${FRONTEND_PIDFILE:-/tmp/shelf-frontend.pid}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$PIDFILE" ]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$pid" ]; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 24); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

cd "$ROOT/frontend"

if [ "${SKIP_BUILD:-false}" != "true" ]; then
  NEXT_PUBLIC_API_URL="$API" npx next build > "${LOG}.build" 2>&1 || {
    echo "frontend build failed:" >&2
    tail -30 "${LOG}.build" >&2
    exit 1
  }
fi

NEXT_PUBLIC_API_URL="$API" setsid npx next start -p "$PORT" > "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "frontend ready on ${PORT} (pid $(cat "$PIDFILE"))"
    exit 0
  fi
  sleep 0.5
done

echo "frontend did not become ready; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
