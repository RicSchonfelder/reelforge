import fs from "node:fs";
import path from "node:path";
import { parseArgs, parseBoolean } from "./args.mjs";
import { getConfig, appRoot } from "./env.mjs";
import { validateMedia } from "./media.mjs";
import {
  addJob,
  cancelJob,
  getDueJobs,
  loadQueue,
  resetForRetry,
} from "./queue.mjs";
import { processJob } from "./publisher.mjs";

function usage() {
  console.log(`
Reelforge

Comandos:
  doctor
  validate --file "C:\\caminho\\video.mp4"
  add --file "C:\\caminho\\video.mp4" --caption-file "legenda.txt" --at "2026-07-25T08:00:00-03:00"
  list
  run-due
  retry <job-id>
  cancel <job-id>

Opções do add:
  --share-to-feed true|false   Padrão: true
  --thumb-offset-ms 1000      Quadro de capa em milissegundos
`);
}

function printJob(job) {
  console.log(
    [
      job.id,
      job.status.padEnd(12),
      new Date(job.publishAt).toLocaleString("pt-BR"),
      path.basename(job.filePath),
      job.permalink || job.error || "",
    ].join(" | "),
  );
}

async function main() {
  const { command, options, positionals } = parseArgs(process.argv.slice(2));

  if (!command || ["help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }

  if (command === "doctor") {
    const config = getConfig();
    const envExists = fs.existsSync(path.join(appRoot, ".env"));
    console.log(`.env: ${envExists ? "encontrado" : "ausente"}`);
    console.log(`IG_USER_ID: ${config.igUserId ? "configurado" : "ausente"}`);
    console.log(`IG_ACCESS_TOKEN: ${config.accessToken ? "configurado" : "ausente"}`);
    console.log(`META_API_VERSION: ${config.apiVersion}`);
    console.log(`FFPROBE_PATH: ${config.ffprobePath}`);
    return;
  }

  if (command === "validate") {
    if (!options.file) throw new Error("Informe --file.");
    const config = getConfig();
    const result = validateMedia(options.file, { ffprobePath: config.ffprobePath });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "add") {
    if (!options.file || !options["caption-file"] || !options.at) {
      throw new Error("Informe --file, --caption-file e --at.");
    }
    const caption = fs.readFileSync(path.resolve(options["caption-file"]), "utf8");
    const job = addJob({
      filePath: options.file,
      caption,
      publishAt: options.at,
      shareToFeed: parseBoolean(options["share-to-feed"], true),
      thumbOffsetMs: options["thumb-offset-ms"]
        ? Number(options["thumb-offset-ms"])
        : undefined,
    });
    console.log(`Adicionado à fila: ${job.id}`);
    printJob(job);
    return;
  }

  if (command === "list") {
    const jobs = loadQueue().jobs;
    if (!jobs.length) {
      console.log("Fila vazia.");
      return;
    }
    jobs.forEach(printJob);
    return;
  }

  if (command === "run-due") {
    getConfig({ requireCredentials: true });
    const jobs = getDueJobs();
    if (!jobs.length) {
      console.log("Nenhuma publicação vencida.");
      return;
    }
    for (const job of jobs) {
      console.log(`Processando ${job.id}: ${path.basename(job.filePath)}`);
      const result = await processJob(job);
      printJob(result);
    }
    return;
  }

  if (command === "retry") {
    if (!positionals[0]) throw new Error("Informe o ID do trabalho.");
    printJob(resetForRetry(positionals[0]));
    return;
  }

  if (command === "cancel") {
    if (!positionals[0]) throw new Error("Informe o ID do trabalho.");
    printJob(cancelJob(positionals[0]));
    return;
  }

  throw new Error(`Comando desconhecido: ${command}`);
}

main().catch((error) => {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
});
