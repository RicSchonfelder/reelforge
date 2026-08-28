#!/usr/bin/env bash
# Reelforge — inicia servidor + abre janela app no navegador (Linux desktop)
# Uso: bash scripts/start.sh
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PORT="${DASHBOARD_PORT:-4170}"
URL="http://127.0.0.1:$PORT"

if ! curl -fsS -o /dev/null --max-time 2 "$URL"; then
  mkdir -p data
  nohup node src/dashboard-server.mjs >data/dashboard-output.log 2>data/dashboard-error.log &
  for _ in $(seq 1 60); do
    sleep 0.5
    curl -fsS -o /dev/null --max-time 2 "$URL" && break
  done
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
elif command -v google-chrome >/dev/null 2>&1; then
  google-chrome --app="$URL" >/dev/null 2>&1 &
fi
