import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import sharp from "sharp";
import { appRoot } from "./env.mjs";

const coversRoot = path.join(appRoot, "library", "covers");
const analysisVersion = 1;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function candidateTimes(durationSeconds) {
  const progressPoints = [
    0.04, 0.08, 0.12, 0.17, 0.22, 0.28, 0.35,
    0.43, 0.52, 0.61, 0.7, 0.79, 0.87,
  ];
  const minimum = Math.min(0.7, durationSeconds * 0.04);
  const maximum = Math.max(minimum, durationSeconds - Math.min(0.8, durationSeconds * 0.04));
  const unique = new Set(
    progressPoints.map((progress) =>
      Math.round(clamp(durationSeconds * progress, minimum, maximum) * 1000),
    ),
  );
  return [...unique];
}

function extractFrame(filePath, timeMs, outputPath, ffmpegPath) {
  const result = spawnSync(
    ffmpegPath || ffmpegStatic,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      (timeMs / 1000).toFixed(3),
      "-i",
      filePath,
      "-frames:v",
      "1",
      "-vf",
      "scale=360:-2:flags=lanczos",
      "-q:v",
      "3",
      "-y",
      outputPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error(
      `Não foi possível extrair o quadro em ${(timeMs / 1000).toFixed(1)}s: ${
        result.error?.message || result.stderr?.trim() || "falha desconhecida"
      }`,
    );
  }
}

function buildRationale(parts, progress) {
  const labels = [];
  if (parts.sharpness >= 0.72) labels.push("imagem nítida");
  if (parts.exposure >= 0.78) labels.push("luz equilibrada");
  if (parts.contrast >= 0.66) labels.push("bom contraste");
  if (parts.entropy >= 0.68) labels.push("boa riqueza visual");
  if (progress <= 0.35) labels.push("próximo do gancho");
  return labels.length
    ? labels.slice(0, 3).join(", ")
    : "quadro tecnicamente equilibrado";
}

async function scoreFrame(framePath, timeMs, durationSeconds) {
  const stats = await sharp(framePath).stats();
  const colorChannels = stats.channels.slice(0, 3);
  const mean = colorChannels.reduce((sum, channel) => sum + channel.mean, 0) / 3;
  const deviation =
    colorChannels.reduce((sum, channel) => sum + channel.stdev, 0) / 3;
  const channelMeans = colorChannels.map((channel) => channel.mean);
  const colorSpread = Math.max(...channelMeans) - Math.min(...channelMeans);
  const progress = timeMs / 1000 / durationSeconds;

  const parts = {
    sharpness: clamp((Number(stats.sharpness || 0) - 0.7) / 5.3),
    exposure: clamp(1 - Math.abs(mean - 142) / 128),
    contrast: clamp((deviation - 16) / 48),
    entropy: clamp((Number(stats.entropy || 0) - 3.2) / 4.5),
    colorBalance: clamp(1 - colorSpread / 120),
    hookProximity: clamp(1 - Math.abs(progress - 0.2) / 0.8),
  };
  const score = Math.round(
    100 *
      (
        parts.sharpness * 0.3 +
        parts.exposure * 0.18 +
        parts.contrast * 0.18 +
        parts.entropy * 0.14 +
        parts.colorBalance * 0.08 +
        parts.hookProximity * 0.12
      ),
  );

  return {
    score,
    rationale: buildRationale(parts, progress),
    signals: Object.fromEntries(
      Object.entries(parts).map(([key, value]) => [key, round(value)]),
    ),
  };
}

export async function generateCoverSuggestions({
  contentId,
  filePath,
  durationSeconds,
  ffmpegPath,
} = {}) {
  if (!contentId || !filePath || !fs.existsSync(filePath)) {
    throw new Error("O agente de capa precisa de um vídeo final disponível.");
  }
  if (!/^[\w-]+$/.test(String(contentId))) {
    throw new Error("Identificador de conteúdo inválido para o diretório de capas.");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1) {
    throw new Error("Não foi possível identificar a duração para analisar a capa.");
  }

  const directory = path.join(coversRoot, contentId);
  const resolvedRoot = path.resolve(coversRoot);
  const resolvedDirectory = path.resolve(directory);
  if (
    resolvedDirectory === resolvedRoot
    || !`${resolvedDirectory}${path.sep}`.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Diretório de capas inválido.");
  }
  if (fs.existsSync(resolvedDirectory)) {
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
  fs.mkdirSync(resolvedDirectory, { recursive: true });

  const candidates = [];
  for (const timeMs of candidateTimes(durationSeconds)) {
    const id = `frame-${timeMs}`;
    const framePath = path.join(resolvedDirectory, `${id}.jpg`);
    extractFrame(filePath, timeMs, framePath, ffmpegPath);
    const analysis = await scoreFrame(framePath, timeMs, durationSeconds);
    candidates.push({
      id,
      timeMs,
      timeLabel: new Date(timeMs).toISOString().slice(14, 19),
      previewUrl: `/cover-media/${contentId}/${id}.jpg`,
      ...analysis,
    });
  }

  candidates.sort((left, right) => right.score - left.score);
  const recommended = candidates[0];
  if (!recommended) throw new Error("O agente não encontrou nenhum quadro utilizável.");

  return {
    status: "ready",
    source: "cover-agent",
    analysisVersion,
    generatedAt: new Date().toISOString(),
    thumbOffsetMs: recommended.timeMs,
    selectedCandidateId: recommended.id,
    selectedPreviewUrl: recommended.previewUrl,
    score: recommended.score,
    rationale: `Escolha automática: ${recommended.rationale}.`,
    candidates,
  };
}

export function selectCoverCandidate(coverSelection, candidateId) {
  const candidate = coverSelection?.candidates?.find(
    (item) => item.id === candidateId,
  );
  if (!candidate) throw new Error("Quadro de capa não encontrado.");
  return {
    ...coverSelection,
    source: "manual-override",
    selectedAt: new Date().toISOString(),
    selectedCandidateId: candidate.id,
    selectedPreviewUrl: candidate.previewUrl,
    thumbOffsetMs: candidate.timeMs,
    score: candidate.score,
    rationale: `Escolha confirmada: ${candidate.rationale}.`,
  };
}

export function resolveCoverCandidatePath(contentId, filename) {
  if (!/^[\w-]+$/.test(String(contentId))) return null;
  if (!/^frame-\d+\.jpg$/.test(filename || "")) return null;
  const resolvedRoot = path.resolve(coversRoot);
  const expectedRoot = path.resolve(resolvedRoot, contentId);
  const candidatePath = path.resolve(expectedRoot, filename);
  if (
    candidatePath === resolvedRoot
    || !candidatePath.startsWith(`${expectedRoot}${path.sep}`)
    || !fs.existsSync(candidatePath)
  ) {
    return null;
  }
  return candidatePath;
}
