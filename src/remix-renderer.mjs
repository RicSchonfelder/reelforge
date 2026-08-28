import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { assessReelQuality, validateMedia } from "./media.mjs";

function escapeFilterPath(filePath) {
  return path.resolve(filePath)
    .replaceAll("\\", "/")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

// Fonte configurável com fallbacks por plataforma (Windows e Linux).
function resolveDefaultFont() {
  const custom = process.env.REELFORGE_FONT_PATH?.trim();
  if (custom && fs.existsSync(custom)) return custom;
  const candidates = process.platform === "win32"
    ? [
      "C:/Windows/Fonts/arialbd.ttf",
      "C:/Windows/Fonts/seguisb.ttf",
    ]
    : [
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
      "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
      "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function escapeDrawText(text) {
  return String(text || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\:")
    .replaceAll("'", "’")
    .replaceAll("%", "\\%");
}

function durationOf(filePath) {
  const result = spawnSync(
    ffprobeStatic.path,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const duration = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("Não foi possível determinar a duração do Reel de referência.");
  }
  return duration;
}

export function buildRemixFilter({
  headline = "TÍTULO DO REMIX",
  duration,
  fontPath = resolveDefaultFont(),
}) {
  const safeDuration = Number(duration).toFixed(3);
  const safeFont = escapeFilterPath(fontPath);
  const safeHeadline = escapeDrawText(headline);
  return [
    `[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080,gblur=sigma=28[videoBg]`,
    `[0:v]scale=-2:1080:force_original_aspect_ratio=decrease[videoFg]`,
    `[videoBg][videoFg]overlay=(W-w)/2:(H-h)/2,eq=contrast=1.04:saturation=1.06,setsar=1[top]`,
    `[2:v]scale=1080:840:force_original_aspect_ratio=increase,crop=1080:840,eq=contrast=1.03:saturation=1.04[photo]`,
    `color=c=0x050706:s=1080x1920:d=${safeDuration}:r=30[canvas]`,
    `[canvas][top]overlay=0:0[tmp]`,
    `[tmp][photo]overlay=0:1080[split]`,
    `[split]drawbox=x=42:y=1012:w=996:h=142:color=0x050807@0.96:t=fill,drawbox=x=42:y=1146:w=996:h=8:color=0xB08968@1:t=fill,drawtext=fontfile='${safeFont}':text='${safeHeadline}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=1051:shadowcolor=black@0.65:shadowx=2:shadowy=3,fps=30,format=yuv420p[vout]`,
    `[1:a]loudnorm=I=-16:LRA=11:TP=-1.5,aresample=48000[aout]`,
  ].join(";");
}

export function renderSplitRemix({
  videoPath,
  audioPath,
  imagePath,
  outputPath,
  headline = "TÍTULO DO REMIX",
}) {
  for (const [label, filePath] of Object.entries({
    vídeo: videoPath,
    áudio: audioPath,
    foto: imagePath,
  })) {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Arquivo de ${label} não encontrado.`);
    }
  }
  const duration = Math.min(90, durationOf(videoPath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const filter = buildRemixFilter({ headline, duration });
  const args = [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-loop",
    "1",
    "-i",
    imagePath,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    duration.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-profile:v",
    "high",
    "-level",
    "4.1",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  const result = spawnSync(ffmpegPath, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim().slice(-1800) || "Falha ao renderizar o Remix.");
  }
  const validation = validateMedia(outputPath, { ffprobePath: ffprobeStatic.path });
  const quality = assessReelQuality(validation);
  if (!quality.ok) {
    throw new Error(`O Remix não passou no controle de qualidade: ${quality.errors.join(" ")}`);
  }
  return { outputPath, duration, validation, quality };
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const [videoPath, audioPath, imagePath, outputPath, headline] = process.argv.slice(2);
  const result = renderSplitRemix({
    videoPath,
    audioPath,
    imagePath,
    outputPath,
    headline,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
