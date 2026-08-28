#!/usr/bin/env bash
# Reelforge — instalação em Linux (Ubuntu/Debian)
# Uso: bash scripts/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "==> Reelforge em $APP_DIR"

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  echo "==> Instalando Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> Dependências do sistema (ffmpeg/fontes)"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y --no-install-recommends ca-certificates curl ffmpeg fontconfig fonts-dejavu-core
fi

echo "==> Dependências do projeto"
npm ci --omit=dev --no-audit --no-fund

mkdir -p data library/raw library/final library/covers \
  editor/music editor/outputs editor/proof editor/temp editor/transcription editor/sfx \
  creative-matrix/normalized creative-matrix/outputs creative-matrix/pieces creative-matrix/temp \
  remix/sources models/transformers

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> .env criado a partir de .env.example — preencha IG_USER_ID e IG_ACCESS_TOKEN."
fi

if [ ! -x bin/cloudflared ] && [ -z "${CLOUDFLARED_PATH:-}" ]; then
  echo "==> Baixando cloudflared"
  npm run setup:cloudflared || echo "   (opcional) falhou — instale cloudflared manualmente ou defina CLOUDFLARED_PATH."
fi

echo "==> Concluído. Para executar: npm run dashboard  (ou docker compose up -d)"
