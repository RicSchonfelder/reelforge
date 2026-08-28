import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(moduleDir, "..");

// Permite isolar o diretório de dados (Docker, backups, testes).
export const dataRoot = process.env.REELFORGE_DATA_DIR?.trim()
  ? path.resolve(process.env.REELFORGE_DATA_DIR.trim())
  : path.join(appRoot, "data");

function parseEnv(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function loadEnv() {
  const envPath = path.join(appRoot, ".env");
  const fileValues = fs.existsSync(envPath)
    ? parseEnv(fs.readFileSync(envPath, "utf8"))
    : {};

  return { ...fileValues, ...process.env };
}

export function getConfig({ requireCredentials = false } = {}) {
  const env = loadEnv();
  const dailyPostLimit = Number(env.DAILY_POST_LIMIT || 4);
  const postingSlots = (env.POSTING_SLOTS || "08:00,12:30,18:30,21:00")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const config = {
    igUserId: env.IG_USER_ID?.trim() ?? "",
    accessToken: env.IG_ACCESS_TOKEN?.trim() ?? "",
    apiVersion: env.META_API_VERSION?.trim() || "v25.0",
    ffprobePath: env.FFPROBE_PATH?.trim() || "ffprobe",
    schedulerIntervalSeconds: Number(env.SCHEDULER_INTERVAL_SECONDS || 15),
    autoScheduleEnabled: env.AUTO_SCHEDULE_ENABLED?.trim().toLowerCase() !== "false",
    dailyPostLimit,
    postingSlots,
    timeZone: env.POSTING_TIME_ZONE?.trim() || "America/Sao_Paulo",
    cloudflaredPath: env.CLOUDFLARED_PATH?.trim() || "",
  };

  if (
    !Number.isFinite(config.schedulerIntervalSeconds) ||
    config.schedulerIntervalSeconds < 5
  ) {
    throw new Error("SCHEDULER_INTERVAL_SECONDS deve ser um número maior ou igual a 5.");
  }

  if (!Number.isInteger(config.dailyPostLimit) || config.dailyPostLimit < 1 || config.dailyPostLimit > 25) {
    throw new Error("DAILY_POST_LIMIT deve ser um número inteiro entre 1 e 25.");
  }

  if (requireCredentials) {
    const missing = [];
    if (!config.igUserId) missing.push("IG_USER_ID");
    if (!config.accessToken) missing.push("IG_ACCESS_TOKEN");
    if (missing.length) {
      throw new Error(`Configuração ausente: ${missing.join(", ")}.`);
    }
  }

  return config;
}
