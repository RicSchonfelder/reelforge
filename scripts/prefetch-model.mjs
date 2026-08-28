// Pré-baixa o modelo de transcrição configurado (evita download na primeira
// transcrição). Uso: npm run setup:model
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { appRoot } from "../src/env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelId = process.env.REELFORGE_TRANSCRIBER_MODEL?.trim() || "Xenova/whisper-base";
const dtype = process.env.REELFORGE_TRANSCRIBER_DTYPE?.trim() || "q8";

// Mesmo cache usado pelo local-transcriber
process.env.REELFORGE_TRANSCRIBER_MODEL = modelId;
process.env.REELFORGE_TRANSCRIBER_DTYPE = dtype;
const cacheDir = path.join(appRoot, "models", "transformers");
fs.mkdirSync(cacheDir, { recursive: true });

console.log(`Pré-baixando modelo ${modelId} (${dtype}) para ${cacheDir}…`);
const { pipeline, env } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;
env.useBrowserCache = false;
await pipeline("automatic-speech-recognition", modelId, { dtype });
console.log("Modelo pronto.");
