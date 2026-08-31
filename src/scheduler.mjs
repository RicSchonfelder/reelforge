import fs from "node:fs";
import path from "node:path";
import { dataRoot, getConfig } from "./env.mjs";
import { getDueJobs, recoverInterruptedJobs, updateJob } from "./queue.mjs";
import { notifyEvent } from "./notify.mjs";
import { processJob } from "./publisher.mjs";

const lockPath = path.join(dataRoot, "scheduler.lock");
let lockHandle;
let running = false;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      lockHandle = fs.openSync(lockPath, "wx");
      fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, startedAt: new Date() }));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Lock órfão (crash, kill -9, energia): descarta se o dono não existe mais.
      let ownerPid = NaN;
      try {
        ownerPid = Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid);
      } catch {
        // lock ilegível: trata como órfão
      }
      if (!isProcessAlive(ownerPid)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // corrida com outro processo; recomeça o loop
        }
        continue;
      }
      throw new Error(
        `Já existe um agendador ativo (PID ${ownerPid}) em ${lockPath}.`,
      );
    }
  }
}

function releaseLock() {
  try {
    if (lockHandle !== undefined) fs.closeSync(lockHandle);
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch {
    // A saída do processo não deve criar uma segunda falha.
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    for (const job of getDueJobs()) {
      try {
        console.log(`[${new Date().toISOString()}] Publicando ${job.id}`);
        const result = await processJob(job);
        console.log(
          `[${new Date().toISOString()}] ${job.id}: ${result.status} ${result.permalink || result.error || ""}`,
        );
      } catch (jobError) {
        // Falha inesperada em um job não pode derrubar o daemon.
        const mensagem = jobError?.message || jobError;
        console.error(
          `[${new Date().toISOString()}] ${job.id}: erro inesperado: ${mensagem}`,
        );
        notifyEvent({
          type: "failed",
          jobId: job.id,
          title: job?.filePath ? path.basename(job.filePath) : undefined,
          detail: mensagem,
        }).catch(() => {});
        try {
          updateJob(job.id, {
            status: "failed",
            error: `Erro inesperado no agendador: ${mensagem}`,
          });
        } catch {
          // fila indisponível: registra e segue
        }
      }
    }
  } finally {
    running = false;
  }
}

const config = getConfig({ requireCredentials: true });
acquireLock();
process.once("SIGINT", () => {
  releaseLock();
  process.exit(0);
});
process.once("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});
process.once("exit", releaseLock);

console.log(
  `Agendador iniciado. Verificação a cada ${config.schedulerIntervalSeconds}s.`,
);
recoverInterruptedJobs();
await tick();
setInterval(() => {
  tick().catch((error) => {
    console.error(`[${new Date().toISOString()}] Falha no ciclo do agendador: ${error?.message || error}`);
  });
}, config.schedulerIntervalSeconds * 1000);
