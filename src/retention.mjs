import fs from "node:fs";
import path from "node:path";

const ONE_HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Tamanho total (bytes) de um arquivo ou árvore; itens ilegíveis contam como 0.
function measureTree(targetPath) {
  let stats;
  try {
    stats = fs.statSync(targetPath);
  } catch {
    return 0;
  }

  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;

  let entries = [];
  try {
    entries = fs.readdirSync(targetPath);
  } catch {
    return 0;
  }

  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += measureTree(path.join(targetPath, entry));
  }
  return totalBytes;
}

function removeEntry(entryPath) {
  try {
    fs.rmSync(entryPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Varre os diretórios de mídia e remove itens antigos:
 * - editor/temp: arquivos com mais de 1 hora (temporários de render).
 * - editor/outputs: arquivos .mp4 com mais de `days` dias.
 * - creative-matrix/temp: arquivos e pastas com mais de 1 hora.
 * Diretórios ausentes são ignorados; falhas individuais não interrompem o sweep.
 * removedFiles conta entradas removidas (uma pasta conta como 1) e
 * removedBytes soma o conteúdo apagado quando mensurável.
 */
export function runRetentionSweep({ appRoot, days = 14 } = {}) {
  const result = { removedFiles: 0, removedBytes: 0 };

  if (!Number.isFinite(days) || days <= 0 || !appRoot) {
    return result;
  }

  const now = Date.now();
  const sweepTargets = [
    {
      dir: path.join(appRoot, "editor", "temp"),
      cutoffMs: ONE_HOUR_MS,
      extensions: null,
      includeDirs: false,
    },
    {
      dir: path.join(appRoot, "editor", "outputs"),
      cutoffMs: days * DAY_MS,
      extensions: [".mp4"],
      includeDirs: false,
    },
    {
      dir: path.join(appRoot, "creative-matrix", "temp"),
      cutoffMs: ONE_HOUR_MS,
      extensions: null,
      includeDirs: true,
    },
  ];

  for (const target of sweepTargets) {
    let entries = [];
    try {
      entries = fs.readdirSync(target.dir);
    } catch {
      // Diretório ausente/inacessível: apenas ignora.
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(target.dir, entry);
      let stats;
      try {
        stats = fs.statSync(entryPath);
      } catch {
        continue;
      }

      const isDirectory = stats.isDirectory();
      if (!stats.isFile() && !(target.includeDirs && isDirectory)) continue;
      if (
        target.extensions &&
        !target.extensions.includes(path.extname(entry).toLowerCase())
      ) {
        continue;
      }
      if (stats.mtimeMs >= now - target.cutoffMs) continue;

      const bytes = isDirectory ? measureTree(entryPath) : stats.size;
      if (!removeEntry(entryPath)) continue;

      result.removedFiles += 1;
      result.removedBytes += bytes;
    }
  }

  return result;
}
