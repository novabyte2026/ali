#!/usr/bin/env bash
# Restarts the backend on its configured port for local verification.
#
# Finds the listener by port rather than by command-line pattern: a pattern
# match on the server path also matches the shell running this script, which
# makes the script kill itself.
set -euo pipefail

PORT="${BACKEND_PORT:-4100}"
LOG="${BACKEND_LOG:-/tmp/backend.log}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

existing="$(ss -lptnH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "$existing" ]; then
  kill "$existing" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$existing" 2>/dev/null || break
    sleep 0.25
  done
  kill -9 "$existing" 2>/dev/null || true
fi

cd "$ROOT"
setsid npx tsx backend/src/server.ts > "$LOG" 2>&1 < /dev/null &

for _ in $(seq 1 40); do
  if curl -sf --noproxy '*' "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "backend ready on ${PORT}"
    exit 0
  fi
  sleep 0.5
done

echo "backend did not become ready; last log lines:" >&2
tail -20 "$LOG" >&2
exit 1
