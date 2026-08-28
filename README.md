# Reelforge

Estúdio local de produção e publicação de **Reels do Instagram** usando a **API oficial da Meta**. Upload do vídeo bruto, edição assistida (cortes de silêncio, legendas dinâmicas, zoom, motion graphics, música com ducking), transcrição local com Whisper, legenda automática, revisão humana, agendamento inteligente e publicação sem recompressão intermediária.

> Todo o conteúdo, credenciais e histórico ficam **no seu computador**. Nenhuma publicação acontece sem aprovação humana.

## Requisitos oficiais atendidos

- Conta profissional do Instagram (Business ou Creator)
- Permissões `instagram_business_basic` e `instagram_business_content_publish`
- Vídeo MP4/MOV, H.264 ou HEVC, áudio AAC 48 kHz, 23–60 FPS, 3 s–15 min, ≤ 1 GB, largura ≤ 1920 px, ≤ 25 Mbps
- Perfil de alta qualidade obrigatório para publicar: **1080×1920, H.264, ≥ 30 FPS, AAC 48 kHz**

## Instalação

### Windows (10/11, 64 bits)

1. Instale o [Node.js 22](https://nodejs.org);
2. Clone o repositório e, dentro da pasta:

```powershell
npm ci --omit=dev --no-audit --no-fund
npm run setup:cloudflared   # opcional: túnel para upload do vídeo à Meta
npm run dashboard           # abre o painel em http://127.0.0.1:4170
```

Atalhos prontos: `scripts/windows/Instalar-Reelforge.cmd` (instala em `%LOCALAPPDATA%\Reelforge` com Node privado e atalhos no menu Iniciar).

### Linux (Ubuntu/Debian)

```bash
bash scripts/install.sh
npm run dashboard
```

### Docker (recomendado para servidor)

```bash
cp .env.example .env   # preencha IG_USER_ID e IG_ACCESS_TOKEN
docker compose up -d   # painel em http://SEU_SERVIDOR:4170
```

Para rodar como serviço systemd sem Docker, use `scripts/reelforge.service`.

## Configuração

Copie `.env.example` para `.env` e preencha `IG_USER_ID` e `IG_ACCESS_TOKEN`. Principais variáveis:

| Variável | Padrão | Descrição |
|---|---|---|
| `META_API_VERSION` | `v25.0` | Versão da Graph API |
| `SCHEDULER_INTERVAL_SECONDS` | `15` | Intervalo do agendador (mín. 5) |
| `AUTO_SCHEDULE_ENABLED` | `true` | Aprovação escolhe o próximo horário livre |
| `DAILY_POST_LIMIT` | `4` | Publicações por dia (1–25) |
| `POSTING_TIME_ZONE` | `America/Sao_Paulo` | Fuso da agenda |
| `POSTING_SLOTS` | `08:00,12:30,18:30,21:00` | Horários da fila |
| `REELFORGE_TRANSCRIBER_MODEL` | `Xenova/whisper-base` | Modelo Whisper local (ONNX) |
| `REELFORGE_TOKEN` | *(vazio)* | Token opcional exigido nas mutações via API (recomendado quando `DASHBOARD_HOST=0.0.0.0`) |
| `CLOUDFLARED_PATH` | auto | Executável do cloudflared (túnel de upload) |

## Fluxo principal

1. **Envie o vídeo bruto** no painel (ou use o **Editor Externo** integrado);
2. A transcrição roda **localmente** (Whisper ONNX) e gera legenda + hashtags;
3. O **Editor IA** corta silêncios, aplica legendas dinâmicas, zooms, SFX e música;
4. **Revise** o vídeo e clique em **Aprovar** — o agendador escolhe o próximo horário livre respeitando o limite diário e prioriza horários com melhor engajamento (métricas oficiais da Meta);
5. A publicação vai direto à Meta pela API oficial, com **gate de qualidade** e proteção contra duplicação (estados ambíguos pausam a fila em `needs_review`).

## Áreas do painel

- **Esteira**: entrada → edição → revisão → agenda → publicado
- **Editor IA**: templates, timeline lite, transcrição, jobs de render
- **Matriz de Criativos**: produto cartesiano `ganchos × corpos × CTAs` com download individual ou em ZIP (sem publicação)
- **Chat do agente**: comandos persistentes para o operador (edição e agenda continuam dependentes de aprovação)
- **Insights**: métricas oficiais, melhores horários e briefing de gravação
- **Calendário** e **fila** com estados visíveis

## CLI

```bash
npm run doctor                          # verifica configuração (não imprime segredos)
node src/cli.mjs validate --file video.mp4
node src/cli.mjs add --file video.mp4 --caption-file legenda.txt --at "2026-09-01T08:00:00-03:00"
node src/cli.mjs list
npm run run-due                         # processa vencidos (uma vez)
npm run scheduler                       # daemon com lock (não use junto do painel aberto)
node src/cli.mjs retry <job-id>         # reenfileira após conferência
node src/cli.mjs cancel <job-id>
```

## Estados da fila

`queued → uploading → processing → publishing → published` · terminais: `failed`, `needs_review`, `cancelled`.

## Segurança

- Token da Meta **exclusivamente em headers** (nunca em query string, logs ou disco além do `.env` local);
- Todos os processos ffmpeg spawnados **sem shell**, com argumentos em array;
- Mutações via API exigem o header `X-Reelforge-Client: 1` (anti-CSRF); com `REELFORGE_TOKEN` definido, também exigem `Authorization: Bearer <token>`;
- Escritas atômicas (`tmp` + `rename`) e quarentena automática de JSON corrompido;
- Lock de arquivo entre processos para a fila de publicação (painel e scheduler podem coexistir sem perder atualizações);
- O upload do vídeo à Meta usa um servidor local efêmero atrás de um túnel Cloudflare com rota protegida por token de 32 bytes, ativo apenas durante o upload.

## Desenvolvimento

```bash
npm test        # testes dos módulos puros e da fila
node --check src/*.mjs   # checagem de sintaxe
```

## Licença

[MIT](LICENSE)
