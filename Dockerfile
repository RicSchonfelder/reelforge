# Reelforge — estúdio de Reels (servidor)
FROM node:22-slim

# ffmpeg do sistema complementa os binários estáticos; fontconfig + fontes
# resolvem o drawtext/ASS em Linux.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl ffmpeg fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    DASHBOARD_HOST=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY dashboard ./dashboard
COPY scripts ./scripts

# Diretórios persistentes (montar como volumes)
RUN mkdir -p data library/raw library/final library/covers \
  editor/music editor/outputs editor/proof editor/temp editor/transcription editor/sfx \
  creative-matrix/normalized creative-matrix/outputs creative-matrix/pieces creative-matrix/temp \
  remix/sources models/transformers \
  && chown -R node:node /app

# Nunca como root: os volumes contêm dados e credenciais do operador.
USER node

EXPOSE 4170
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://127.0.0.1:4170/ >/dev/null || exit 1

CMD ["node", "src/dashboard-server.mjs"]
