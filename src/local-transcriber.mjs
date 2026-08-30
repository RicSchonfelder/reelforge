import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import wavefile from "wavefile";
import { appRoot } from "./env.mjs";
import { getContent, loadContentState, updateContent } from "./content-store.mjs";
import {
  applyDomainCorrections,
  assessTranscriptQuality,
  segmentsFromWords,
  transcriptFromWords,
} from "./transcript-quality.mjs";

const modelId = process.env.REELFORGE_TRANSCRIBER_MODEL
  || "Xenova/whisper-base";
const modelDtype = process.env.REELFORGE_TRANSCRIBER_DTYPE
  || (/large-v3-turbo/i.test(modelId) ? "q4" : "q8");
const modelCacheDir = path.join(appRoot, "models", "transformers");
const audioTempDir = path.join(appRoot, "editor", "transcription");
const queued = [];
const active = new Set();
const { WaveFile } = wavefile;
let pipelinePromise = null;
let queueRunning = false;

function ensureDirectories() {
  fs.mkdirSync(modelCacheDir, { recursive: true });
  fs.mkdirSync(audioTempDir, { recursive: true });
}

async function getTranscriber() {
  ensureDirectories();
  if (!pipelinePromise) {
    pipelinePromise = import("@huggingface/transformers").then(async ({
      env,
      pipeline,
    }) => {
      env.cacheDir = modelCacheDir;
      env.useBrowserCache = false;
      return pipeline("automatic-speech-recognition", modelId, {
        dtype: modelDtype,
      });
    });
  }
  return pipelinePromise;
}

function extractAudio(filePath, contentId) {
  ensureDirectories();
  const outputPath = path.join(audioTempDir, `${contentId}.wav`);
  const result = spawnSync(
    ffmpegPath,
    [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !fs.existsSync(outputPath)) {
    throw new Error(
      result.stderr.trim().slice(-900)
      || "Não foi possível preparar o áudio para transcrição.",
    );
  }
  return outputPath;
}

function readAudioSamples(wavPath) {
  const wav = new WaveFile(fs.readFileSync(wavPath));
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  let samples = wav.getSamples();
  if (Array.isArray(samples)) samples = samples[0];
  return samples instanceof Float32Array
    ? samples
    : Float32Array.from(samples);
}

export function normalizeTranscriptResult(result) {
  const transcript = removeLoopingHallucination(String(result?.text || ""))
    .replace(/\s+/g, " ")
    .trim();
  const chunks = Array.isArray(result?.chunks) ? result.chunks : [];
  const words = chunks.flatMap((chunk) => {
    const text = removeLoopingHallucination(String(chunk.text || ""))
      .replace(/\s+/g, " ")
      .trim();
    const tokens = text.split(" ").filter(Boolean);
    if (!tokens.length) return [];
    const start = Number(chunk.timestamp?.[0] ?? 0);
    const rawEnd = Number(chunk.timestamp?.[1] ?? start + tokens.length * 0.28);
    const end = Math.max(start + 0.06, rawEnd);
    const weights = tokens.map((token) => Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, "").length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    return tokens.map((token, index) => {
      const duration = ((end - start) * weights[index]) / total;
      const word = { start: cursor, end: cursor + duration, text: token };
      cursor += duration;
      return word;
    });
  });
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current.at(-1).end,
      text: current.map((word) => word.text).join(" "),
    });
    current = [];
  };
  for (const word of words) {
    const gap = current.length ? word.start - current.at(-1).end : 0;
    if (current.length && (current.length >= 14 || gap > 0.7)) flush();
    current.push(word);
    if (/[.!?]$/.test(word.text)) flush();
  }
  flush();
  return { transcript, segments, words };
}

export function removeLoopingHallucination(value) {
  const text = String(value || "");
  const tokens = [...text.matchAll(/\S+/g)].map((match) => ({
    index: match.index,
    key: match[0]
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^\p{L}\p{N}]/gu, "")
      .toLowerCase(),
  }));
  for (let start = 0; start < tokens.length; start += 1) {
    for (let width = 2; width <= 8 && start + width * 4 <= tokens.length; width += 1) {
      const phrase = tokens
        .slice(start, start + width)
        .map((token) => token.key)
        .join(" ");
      if (!phrase.trim()) continue;
      let repeats = 1;
      while (start + width * (repeats + 1) <= tokens.length) {
        const candidate = tokens
          .slice(start + width * repeats, start + width * (repeats + 1))
          .map((token) => token.key)
          .join(" ");
        if (candidate !== phrase) break;
        repeats += 1;
      }
      if (repeats >= 4) {
        return text.slice(0, tokens[start].index).trim();
      }
    }
  }
  return text;
}

async function transcribeContent(contentId) {
  const content = getContent(contentId);
  const sourceFile = content?.rawFile || content?.finalFile;
  if (!sourceFile?.path || !fs.existsSync(sourceFile.path)) {
    throw new Error("O vídeo local não está disponível para transcrição.");
  }

  active.add(contentId);
  updateContent(contentId, {
    transcriptStatus: "preparing",
    transcriptProgress: 0.08,
    transcriptError: null,
  });
  let wavPath = null;
  try {
    wavPath = extractAudio(sourceFile.path, contentId);
    updateContent(contentId, {
      transcriptStatus: "loading_model",
      transcriptProgress: 0.2,
    });
    const transcriber = await getTranscriber();
    updateContent(contentId, {
      transcriptStatus: "transcribing",
      transcriptProgress: 0.45,
    });
    const audio = readAudioSamples(wavPath);
    const raw = await transcriber(audio, {
      language: "portuguese",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: "word",
    });
    const normalized = normalizeTranscriptResult(raw);
    const correctionResult = applyDomainCorrections(normalized.words);
    const words = correctionResult.words;
    const transcript = transcriptFromWords(words);
    const segments = segmentsFromWords(words);
    if (transcript.length < 12) {
      throw new Error("O áudio não produziu uma transcrição utilizável.");
    }
    const updatedAt = new Date().toISOString();
    const generated = await import("./caption-generator.mjs").then(({ generateCaption }) =>
      generateCaption({ ...content, transcript }, "direct"),
    );
    const transcriptQuality = {
      modelId,
      modelDtype,
      syncMode: "word-timestamps",
      wordCount: words.length,
      audioDuration: audio.length / 16000,
      timestampCoverage: words.length
        ? Math.min(1, words.at(-1).end / (audio.length / 16000))
        : 0,
      ...assessTranscriptQuality({
        words,
        transcript,
        modelId,
        audioDuration: audio.length / 16000,
        corrections: correctionResult.corrections,
      }),
    };
    updateContent(contentId, {
      transcript,
      transcriptSegments: segments,
      transcriptWords: words,
      transcriptQuality,
      transcriptSource: "reelforge-local",
      transcriptAssetId: null,
      transcriptUpdatedAt: updatedAt,
      transcriptStatus: "ready",
      transcriptProgress: 1,
      transcriptError: null,
      caption: content.caption?.trim() ? content.caption : generated.caption,
      hashtags: content.hashtags?.length ? content.hashtags : generated.hashtags,
      captionSource: content.caption?.trim() ? content.captionSource : "transcript",
    });
  } catch (error) {
    pipelinePromise = null;
    updateContent(contentId, {
      transcriptStatus: "failed",
      transcriptProgress: 0,
      transcriptError: error.message,
    });
  } finally {
    active.delete(contentId);
    if (wavPath && fs.existsSync(wavPath)) fs.rmSync(wavPath, { force: true });
  }
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queued.length) {
      const contentId = queued.shift();
      await transcribeContent(contentId);
    }
  } finally {
    queueRunning = false;
  }
}

export function startLocalTranscription(contentId, { force = false } = {}) {
  const content = getContent(contentId);
  if (!content) throw new Error("Conteúdo não encontrado.");
  if (
    !force &&
    (
      content.transcriptStatus === "ready"
      || active.has(contentId)
      || queued.includes(contentId)
    )
  ) {
    return content;
  }
  updateContent(contentId, {
    transcriptStatus: "queued",
    transcriptProgress: 0.02,
    transcriptError: null,
  });
  queued.push(contentId);
  setTimeout(() => {
    runQueue().catch(() => {});
  }, 0);
  return getContent(contentId);
}

/**
 * A fila de transcrição vive em memória: se o processo reiniciar no meio
 * (deploy, crash, container recriado), os itens ficam presos em
 * "transcribing" para sempre. No boot, reenfileira quem tem vídeo disponível
 * e marca falha para quem não tem.
 */
export function recoverInterruptedTranscriptions() {
  const stuckStatuses = new Set(["queued", "preparing", "loading_model", "transcribing"]);
  const state = loadContentState();
  const toRequeue = [];
  for (const item of state.items) {
    if (!stuckStatuses.has(item.transcriptStatus)) continue;
    const source = item.rawFile?.path || item.finalFile?.path;
    if (source && fs.existsSync(source)) {
      toRequeue.push(item.id);
    } else {
      updateContent(item.id, {
        transcriptStatus: "failed",
        transcriptProgress: 0,
        transcriptError: "O processo foi reiniciado e o vídeo não está mais disponível.",
      });
    }
  }
  for (const id of toRequeue) {
    try {
      startLocalTranscription(id, { force: true });
    } catch {
      // item removido concorrentemente: segue
    }
  }
  return toRequeue.length;
}

export function localTranscriptionOverview() {
  return {
    modelId,
    modelDtype,
    qualityMode: /large-v3-turbo/i.test(modelId) ? "precision" : "standard",
    cost: "local",
    activeContentIds: [...active],
    queuedContentIds: [...queued],
    busy: queueRunning || active.size > 0 || queued.length > 0,
    cacheDir: modelCacheDir,
  };
}
