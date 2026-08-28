import fs from "node:fs";
import path from "node:path";

function readOwner(lockPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return { pid: Number(raw.pid), at: Number(new Date(raw.startedAt).getTime()) };
  } catch {
    return { pid: NaN, at: NaN };
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Mutex entre processos via arquivo de lock, com recuperação de lock órfão:
 * se o processo dono não existe mais ou o lock excedeu staleMs, ele é descartado.
 * Código síncrono do mesmo processo nunca se bloqueia (o event loop é atômico por tick).
 */
export function withFileLock(lockPath, fn, { staleMs = 60_000, timeoutMs = 15_000 } = {}) {
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(
          handle,
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        );
      } finally {
        fs.closeSync(handle);
      }
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // outro processo pode ter recuperado um lock nosso órfão
        }
      }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readOwner(lockPath);
      if (owner.pid === process.pid) {
        // Reentrância síncrona no mesmo tick: seguro executar direto.
        return fn();
      }
      const stale = !isProcessAlive(owner.pid) || (Date.now() - owner.at > staleMs);
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // perdido na corrida; tenta novamente
        }
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Não foi possível obter o lock em ${lockPath} após ${timeoutMs}ms.`);
      }
      const wait = 20 + Math.floor(Math.random() * 30);
      const until = Date.now() + wait;
      while (Date.now() < until) {
        // espera ativa curta: as mutações são síncronas e rápidas
      }
    }
  }
}
