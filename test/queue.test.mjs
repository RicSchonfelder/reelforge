import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-test-"));
process.env.REELFORGE_DATA_DIR = tempRoot;

// Importa depois de definir o data dir (env.mjs resolve o caminho no import).
const { addJob, updateJob, cancelJob, loadQueue, recoverInterruptedJobs, resetForRetry, claimJob } = await import(
  "../src/queue.mjs"
);

before(() => {
  process.env.REELFORGE_DATA_DIR = tempRoot;
});

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("addJob valida data e legenda", () => {
  assert.throws(() => addJob({ filePath: "x.mp4", caption: "oi", publishAt: "não é data" }), /Horário inválido/);
  assert.throws(() => addJob({ filePath: "x.mp4", caption: "   ", publishAt: "2026-09-01T08:00:00-03:00" }), /legenda/);
});

test("addJob normaliza para ISO UTC", () => {
  const job = addJob({
    filePath: "D:/tmp/video.mp4",
    caption: "Legenda teste",
    publishAt: "2026-09-01T08:00:00-03:00",
  });
  assert.equal(new Date(job.publishAt).toISOString(), job.publishAt);
});

test("updateJob só aceita campos da whitelist", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-02T08:00:00-03:00" });
  const patched = updateJob(job.id, {
    status: "uploading",
    id: "hackeado",
    filePath: "C:/_WINDOWS/system.ini",
    attempts: 5,
    campoDesconhecido: "ignorado",
  });
  assert.equal(patched.status, "uploading");
  assert.notEqual(patched.id, "hackeado");
  assert.notEqual(patched.filePath, "C:/_WINDOWS/system.ini");
  assert.equal(patched.campoDesconhecido, undefined);
});

test("cancelJob recusa job fora da fila", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-03T08:00:00-03:00" });
  cancelJob(job.id);
  assert.throws(() => cancelJob(job.id), /canceladas/);
});

test("recoverInterruptedJobs devolve jobs travados para a fila", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-04T08:00:00-03:00" });
  updateJob(job.id, { status: "uploading" });
  const recovered = recoverInterruptedJobs();
  assert.ok(recovered >= 1);
  assert.equal(loadQueue().jobs.find((candidate) => candidate.id === job.id).status, "queued");
});

test("fila corrompida é posta em quarentena e reconstruída", () => {
  const dataFile = path.join(tempRoot, "queue.json");
  fs.writeFileSync(dataFile, "{ json quebrado proposital");
  const state = loadQueue();
  assert.deepEqual(state, { version: 1, jobs: [] });
  assert.ok(!fs.existsSync(dataFile), "arquivo corrompido deve ser renomeado");
  const corrupt = fs.readdirSync(tempRoot).find((name) => name.startsWith("queue.json.corrupt-"));
  assert.ok(corrupt, "quarentena criada");
});

test("resetForRetry limpa artefatos e ignora campos fora da whitelist", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-05T08:00:00-03:00" });
  updateJob(job.id, { status: "failed", error: "boom", apiPayload: { a: 1 } });
  const reset = resetForRetry(job.id);
  assert.equal(reset.status, "queued");
  assert.equal(reset.error, null);
  assert.equal(reset.apiPayload, null);
  assert.equal(reset.cancelledAt, null);
});

test("claimJob reivindica queued -> uploading e devolve null na disputa", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-06T08:00:00-03:00" });
  const claimed = claimJob(job.id);
  assert.equal(claimed.status, "uploading");
  assert.equal(claimed.attempts, 1);
  // Segundo processo: job não está mais queued -> null (sem publicação dupla).
  assert.equal(claimJob(job.id), null);
});

test("cancelamento nunca é sobrescrito por etapa de publicação", () => {
  const job = addJob({ filePath: "x.mp4", caption: "cap", publishAt: "2026-09-07T08:00:00-03:00" });
  cancelJob(job.id);
  // O publisher ainda não sabia do cancelamento e tenta subir o job:
  const after = updateJob(job.id, { status: "uploading" });
  assert.equal(after.status, "cancelled", "cancel vence a corrida");
});
