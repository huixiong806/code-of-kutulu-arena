#!/usr/bin/env sh
# Kutulu Arena launcher (Linux / macOS)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found — install Node.js 18+" >&2
  exit 1
fi

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
echo "Kutulu Arena → http://localhost:${PORT}"
exec env PORT="$PORT" HOST="$HOST" node server/index.js
