import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appRoot, dataRoot } from "./env.mjs";
import { withFileLock } from "./file-lock.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";

const dataDir = dataRoot;
const queuePath = path.join(dataDir, "queue.json");

// Campos internos que um patch pode alterar. Evita sobrescrita acidental
// de id/status/filePath por chamadores malformados.
const UPDATABLE_FIELDS = new Set([
  "status",
  "error",
  "apiPayload",
  "validation",
  "containerId",
  "uploadUri",
  "mediaId",
  "permalink",
  "publishedAt",
  "attempts",
  "publishAt",
  "shareToFeed",
  "thumbOffsetMs",
  "caption",
  "cancelledAt",
]);

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function atomicWrite(value) {
  ensureDataDir();
  const tempPath = `${queuePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, queuePath);
}

export function loadQueue() {
  ensureDataDir();
  const { value } = readJsonOrQuarantine(queuePath);
  const parsed = quarantineIfInvalid(queuePath, value, (state) =>
    Boolean(state) && state.version === 1 && Array.isArray(state.jobs));
  if (!parsed) return { version: 1, jobs: [] };
  return parsed;
}

export function saveQueue(queue) {
  atomicWrite(queue);
}

// Toda mutação passa por um lock de arquivo: o scheduler standalone e o
// painel podem rodar em processos distintos sem perder atualizações.
function mutateQueue(mutator) {
  return withFileLock(`${queuePath}.lock`, () => {
    const queue = loadQueue();
    const result = mutator(queue);
    saveQueue(queue);
    return result;
  });
}

export function addJob({
  filePath,
  caption,
  publishAt,
  shareToFeed = true,
  thumbOffsetMs,
  contentId = null,
}) {
  const text = typeof caption === "string" ? caption : "";
  const parsedDate = new Date(publishAt);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error("Horário inválido. Use ISO 8601, por exemplo 2026-07-25T08:00:00-03:00.");
  }
  if (!text.trim()) throw new Error("A legenda não pode estar vazia.");

  const job = {
    id: randomUUID(),
    filePath: path.resolve(filePath),
    caption: text.trim(),
    publishAt: parsedDate.toISOString(),
    shareToFeed: Boolean(shareToFeed),
    thumbOffsetMs: Number.isFinite(thumbOffsetMs) ? thumbOffsetMs : null,
    contentId,
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return mutateQueue((queue) => {
    queue.jobs.push(job);
    return job;
  });
}

export function cancelJob(id) {
  return mutateQueue((queue) => {
    const job = queue.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Trabalho não encontrado: ${id}`);
    if (job.status !== "queued") {
      throw new Error("Somente publicações ainda na fila podem ser canceladas.");
    }
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export function getDueJobs(now = new Date()) {
  return loadQueue().jobs
    .filter((job) => job.status === "queued" && new Date(job.publishAt) <= now)
    .sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
}

export function updateJob(id, patch) {
  const filtered = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (UPDATABLE_FIELDS.has(key)) filtered[key] = value;
  }
  return mutateQueue((queue) => {
    const index = queue.jobs.findIndex((job) => job.id === id);
    if (index === -1) throw new Error(`Trabalho não encontrado: ${id}`);
    queue.jobs[index] = {
      ...queue.jobs[index],
      ...filtered,
      updatedAt: new Date().toISOString(),
    };
    return queue.jobs[index];
  });
}

export function resetForRetry(id) {
  return mutateQueue((queue) => {
    const job = queue.jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Trabalho não encontrado: ${id}`);
    if (!["failed", "needs_review"].includes(job.status)) {
      throw new Error("Somente trabalhos com falha ou revisão pendente podem voltar para a fila.");
    }
    job.status = "queued";
    job.error = null;
    job.containerId = null;
    job.uploadUri = null;
    job.mediaId = null;
    job.permalink = null;
    job.apiPayload = null;
    job.cancelledAt = null;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export function recoverInterruptedJobs() {
  return mutateQueue((queue) => {
    const interruptedStatuses = new Set(["uploading", "processing", "publishing"]);
    let recovered = 0;
    queue.jobs = queue.jobs.map((job) => {
      if (!interruptedStatuses.has(job.status)) return job;
      recovered += 1;
      return {
        ...job,
        status: "queued",
        error: "O processo anterior foi interrompido; a publicação voltou para a fila automaticamente.",
        containerId: null,
        mediaId: null,
        permalink: null,
        updatedAt: new Date().toISOString(),
      };
    });
    return recovered;
  });
}
