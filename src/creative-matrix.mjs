import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import {
  creativeNormalizedDir,
  creativeOutputsDir,
  creativeTempDir,
  getCreativeBatch,
  loadCreativeMatrixState,
  updateCreativeBatch,
  updateCreativeCombination,
  updateCreativePiece,
} from "./creative-matrix-store.mjs";

const activeBatches = new Set();

const MAX_PIECE_BYTES = 1024 * 1024 * 1024;

// Normalização de peças em andamento: evita dois lotes rodando ffmpeg -y
// no mesmo normalized/{id}.mp4 (corrupção/EPERM no Windows).
const normalizingPieces = new Map();

async function runNormalizedPieceExclusively(pieceId, task) {
  const existing = normalizingPieces.get(pieceId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await task();
    } finally {
      normalizingPieces.delete(pieceId);
    }
  })();
  normalizingPieces.set(pieceId, promise);
  return promise;
}

function runProcess(executable, args, { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`O FFmpeg excedeu o tempo limite de ${Math.round(timeoutMs / 60_000)} minutos.`));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const message = Buffer.concat(errors).toString("utf8").trim();
      reject(new Error(message || `FFmpeg encerrou com código ${code}.`));
    });
  });
}

export function probeCreativeMedia(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo da peça não encontrado: ${filePath}`);
  }
  if (fs.statSync(filePath).size > MAX_PIECE_BYTES) {
    throw new Error("A peça ultrapassa o limite de 1 GB por arquivo.");
  }
  const result = spawnSync(
    ffprobeStatic.path,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`Não foi possível analisar a peça: ${result.stderr?.trim() || "erro desconhecido"}`);
  }
  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `ffprobe retornou uma resposta inválida para a peça: ${result.stderr?.trim() || "saída vazia"}`,
    );
  }
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(probe.format?.duration);
  if (!video) throw new Error("A peça não possui uma faixa de vídeo.");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("A duração da peça é inválida.");
  }
  return {
    durationSeconds: Math.round(durationSeconds * 100) / 100,
    width: video.width || null,
    height: video.height || null,
    videoCodec: video.codec_name || null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name || null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}

async function ensureNormalizedPiece(piece) {
  return runNormalizedPieceExclusively(piece.id, () => ensureNormalizedPieceInner(piece));
}

async function ensureNormalizedPieceInner(piece) {
  const currentPiece = loadCreativeMatrixState().pieces.find((item) => item.id === piece.id);
  if (currentPiece) piece = currentPiece;
  if (piece.normalizedFile?.path && fs.existsSync(piece.normalizedFile.path)) {
    return piece.normalizedFile.path;
  }
  fs.mkdirSync(creativeNormalizedDir, { recursive: true });
  const outputPath = path.join(creativeNormalizedDir, `${piece.id}.mp4`);
  const media = piece.media || probeCreativeMedia(piece.file.path);
  updateCreativePiece(piece.id, { status: "normalizing", media, error: null });

  const videoFilter = [
    "[0:v]split=2[bg][fg]",
    "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=28[bg2]",
    "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2]",
    "[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v]",
  ];
  const args = ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", piece.file.path];

  if (media.hasAudio) {
    videoFilter.push(
      "[0:a:0]loudnorm=I=-16:LRA=11:TP=-1.5,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]",
    );
  } else {
    args.push(
      "-f",
      "lavfi",
      "-t",
      String(media.durationSeconds),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
    );
    videoFilter.push("[1:a:0]aformat=sample_fmts=fltp:channel_layouts=stereo[a]");
  }

  args.push(
    "-filter_complex",
    videoFilter.join(";"),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
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
    "-shortest",
    outputPath,
  );

  try {
    // Renderiza em .tmp e renomeia no sucesso: um crash/timeout no meio não
    // pode deixar um MP4 parcial que o cache reutilizaria para sempre.
    const tempOutput = `${outputPath}.${process.pid}.tmp`;
    await runProcess(ffmpegPath, [...args.slice(0, -1), tempOutput]);
    fs.renameSync(tempOutput, outputPath);
    const stat = fs.statSync(outputPath);
    updateCreativePiece(piece.id, {
      status: "ready",
      error: null,
      normalizedFile: {
        path: outputPath,
        name: `${piece.name}.mp4`,
        sizeBytes: stat.size,
        createdAt: new Date().toISOString(),
      },
    });
    return outputPath;
  } catch (error) {
    try {
      fs.rmSync(`${outputPath}.${process.pid}.tmp`, { force: true });
    } catch {
      // arquivo parcial: retention o alcança depois
    }
    updateCreativePiece(piece.id, { status: "failed", error: error.message });
    throw error;
  }
}

function concatLine(filePath) {
  const normalized = path.resolve(filePath).replaceAll("\\", "/").replaceAll("'", "'\\''");
  return `file '${normalized}'`;
}

async function renderCombination(batch, combination, piecesById, index) {
  const pieceIds = [combination.hookId, combination.bodyId, combination.ctaId];
  const pieces = pieceIds.map((id) => piecesById.get(id));
  if (pieces.some((piece) => !piece)) throw new Error("Uma das peças deste criativo foi removida.");

  const normalizedPaths = [];
  for (const piece of pieces) {
    normalizedPaths.push(await ensureNormalizedPiece(piece));
  }

  const batchDir = path.join(creativeOutputsDir, batch.id);
  const tempDir = path.join(creativeTempDir, batch.id);
  fs.mkdirSync(batchDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const baseName = `${String(index + 1).padStart(3, "0")}-${combination.label.replaceAll(" · ", "-")}`;
  const outputPath = path.join(batchDir, `${baseName}.mp4`);
  const listPath = path.join(tempDir, `${combination.id}.txt`);
  fs.writeFileSync(listPath, `${normalizedPaths.map(concatLine).join("\n")}\n`, "utf8");

  await runProcess(ffmpegPath, [
    "-y",
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
  fs.rmSync(listPath, { force: true });
  const stat = fs.statSync(outputPath);
  return {
    path: outputPath,
    name: `${baseName}.mp4`,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
  };
}

export async function generateCreativeBatch(batchId) {
  if (activeBatches.has(batchId)) return getCreativeBatch(batchId);
  activeBatches.add(batchId);
  try {
    let batch = getCreativeBatch(batchId);
    if (!batch) throw new Error("Lote criativo não encontrado.");
    updateCreativeBatch(batchId, {
      status: "generating",
      error: null,
      startedAt: batch.startedAt || new Date().toISOString(),
      finishedAt: null,
    });

    const piecesById = new Map(
      loadCreativeMatrixState().pieces.map((piece) => [piece.id, piece]),
    );
    for (let index = 0; index < batch.combinations.length; index += 1) {
      const combination = batch.combinations[index];
      if (combination.outputFile?.path && fs.existsSync(combination.outputFile.path)) continue;
      updateCreativeCombination(batchId, combination.id, {
        status: "rendering",
        error: null,
      });
      try {
        const outputFile = await renderCombination(batch, combination, piecesById, index);
        updateCreativeCombination(batchId, combination.id, {
          status: "ready",
          outputFile,
          error: null,
        });
      } catch (error) {
        updateCreativeCombination(batchId, combination.id, {
          status: "failed",
          error: error.message.slice(0, 800),
        });
      }
      batch = getCreativeBatch(batchId);
      const completed = batch.combinations.filter((item) => item.status === "ready").length;
      const failed = batch.combinations.filter((item) => item.status === "failed").length;
      updateCreativeBatch(batchId, { completed, failed });
    }

    batch = getCreativeBatch(batchId);
    const completed = batch.combinations.filter((item) => item.status === "ready").length;
    const failed = batch.combinations.filter((item) => item.status === "failed").length;
    const status = completed === batch.total
      ? "ready"
      : completed > 0
        ? "partial"
        : "failed";
    return updateCreativeBatch(batchId, {
      status,
      completed,
      failed,
      error: failed ? `${failed} variação(ões) não puderam ser geradas.` : null,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    activeBatches.delete(batchId);
  }
}

export function startCreativeBatch(batchId) {
  setTimeout(() => {
    generateCreativeBatch(batchId).catch((error) => {
      updateCreativeBatch(batchId, {
        status: "failed",
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
    });
  }, 0);
}

export function creativeEngineStatus() {
  return {
    busy: activeBatches.size > 0,
    activeBatchIds: [...activeBatches],
    ffmpegAvailable: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
  };
}
