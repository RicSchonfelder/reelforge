import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffprobeStatic from "ffprobe-static";

const MAX_BYTES = 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov"]);
const ALLOWED_VIDEO_CODECS = new Set(["h264", "hevc"]);

function round(value, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function runFfprobe(filePath, ffprobePath) {
  const executable = ffprobePath === "ffprobe" ? ffprobeStatic.path : ffprobePath;
  const result = spawnSync(
    executable,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,bit_rate",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  if (result.error?.code === "ENOENT") return null;
  if (result.status !== 0) {
    throw new Error(`ffprobe não conseguiu analisar o vídeo: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `ffprobe retornou uma resposta inválida: ${result.stderr?.trim() || "saída vazia"}`,
    );
  }
}

export function assessReelQuality(validation) {
  const details = validation?.details || {};
  const errors = [...(validation?.errors || [])];

  if (!details.videoCodec) {
    errors.push(
      details.hasVideoStream === false
        ? "O arquivo não contém uma faixa de vídeo utilizável."
        : "Não foi possível analisar o codec e as dimensões do vídeo.",
    );
  } else {
    if (details.width !== 1080 || details.height !== 1920) {
      errors.push(`Alta qualidade exige 1080x1920; detectado ${details.width || "?"}x${details.height || "?"}.`);
    }
    if (details.videoCodec !== "h264") {
      errors.push(`Alta qualidade padronizada exige vídeo H.264; detectado ${details.videoCodec}.`);
    }
    if (!Number.isFinite(details.frameRate) || details.frameRate < 30) {
      errors.push(`Alta qualidade exige pelo menos 30 FPS; detectado ${details.frameRate || "?"}.`);
    }
    if (details.audioCodec && details.audioCodec !== "aac") {
      errors.push(`O áudio precisa estar em AAC; detectado ${details.audioCodec}.`);
    }
    if (details.audioCodec && details.audioSampleRate !== 48_000) {
      errors.push(`O áudio precisa estar em 48 kHz; detectado ${details.audioSampleRate || "?"} Hz.`);
    }
  }

  return {
    ok: Boolean(validation?.ok) && errors.length === 0,
    profile: "Reel HQ · 1080x1920 · H.264 · 30–60 FPS · AAC 48 kHz",
    errors: [...new Set(errors)],
  };
}

function parseFrameRate(value) {
  if (!value) return null;
  const [numerator, denominator = "1"] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

export function validateMedia(filePath, { ffprobePath = "ffprobe" } = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Arquivo não encontrado: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error("O caminho informado não é um arquivo.");

  const errors = [];
  const warnings = [];
  const extension = path.extname(resolvedPath).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    errors.push("O arquivo precisa estar em MP4 ou MOV.");
  }
  if (stat.size > MAX_BYTES) {
    errors.push("O arquivo ultrapassa o limite oficial de 1 GB para Reels pela API.");
  }

  let probe = null;
  try {
    probe = runFfprobe(resolvedPath, ffprobePath);
  } catch (error) {
    warnings.push(error.message);
  }

  const details = {
    filePath: resolvedPath,
    fileName: path.basename(resolvedPath),
    sizeBytes: stat.size,
    sizeMb: round(stat.size / 1024 / 1024),
  };

  if (!probe) {
    warnings.push(
      "Validação profunda indisponível: configure FFPROBE_PATH para conferir codec, FPS, áudio e dimensões.",
    );
    return { ok: errors.length === 0, errors, warnings, details };
  }

  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  const frameRate = parseFrameRate(video?.r_frame_rate);
  const videoBitrate = Number(video?.bit_rate || probe.format?.bit_rate);

  Object.assign(details, {
    durationSeconds: Number.isFinite(duration) ? round(duration) : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    frameRate: Number.isFinite(frameRate) ? round(frameRate) : null,
    videoBitrateMbps: Number.isFinite(videoBitrate)
      ? round(videoBitrate / 1_000_000)
      : null,
    hasVideoStream: Boolean(video),
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  });

  if (!video) errors.push("Nenhuma faixa de vídeo foi encontrada.");
  if (video?.codec_name && !ALLOWED_VIDEO_CODECS.has(video.codec_name)) {
    errors.push("O codec de vídeo precisa ser H.264 ou HEVC.");
  }
  if (audio?.codec_name && audio.codec_name !== "aac") {
    errors.push("O codec de áudio precisa ser AAC.");
  }
  if (audio?.sample_rate && Number(audio.sample_rate) !== 48_000) {
    warnings.push("A Meta recomenda áudio AAC em 48 kHz.");
  }
  if (Number.isFinite(duration) && (duration < 3 || duration > 15 * 60)) {
    errors.push("A duração precisa ficar entre 3 segundos e 15 minutos.");
  }
  if (Number.isFinite(frameRate) && (frameRate < 23 || frameRate > 60)) {
    errors.push("A taxa de quadros precisa ficar entre 23 e 60 FPS.");
  }
  if (video?.width > 1920) {
    errors.push("A dimensão horizontal não pode ultrapassar 1920 pixels.");
  }
  if (Number.isFinite(videoBitrate) && videoBitrate > 25_000_000) {
    errors.push("O bitrate do vídeo ultrapassa o máximo oficial de 25 Mbps.");
  }

  if (video?.width !== 1080 || video?.height !== 1920) {
    warnings.push(
      `Para Reel vertical de melhor qualidade, prefira 1080x1920; detectado ${video?.width ?? "?"}x${video?.height ?? "?"}.`,
    );
  }
  if (Number.isFinite(frameRate) && frameRate < 30) {
    warnings.push("Para Reels, prefira pelo menos 30 FPS.");
  }

  return { ok: errors.length === 0, errors, warnings, details };
}
