// Baixa o cloudflared oficial para a plataforma atual em bin/.
// Uso: npm run setup:cloudflared
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(root, "bin");
const require = createRequire(import.meta.url);

let fetchImpl = globalThis.fetch;
try {
  // Node >= 18 tem fetch nativo; o require só valida o runtime.
  require("node:http");
} catch {
  // ambiente sem node:http é improvável; segue com fetch nativo
}

const platform = process.platform;
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const assets = {
  "win32": `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`,
  "linux": `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`,
  "darwin": `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`,
};

if (!assets[platform]) {
  console.error(`Plataforma não suportada pelo instalador automático: ${platform}. Baixe manualmente em https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ e defina CLOUDFLARED_PATH.`);
  process.exit(1);
}

fs.mkdirSync(binDir, { recursive: true });
const target = path.join(binDir, platform === "win32" ? "cloudflared.exe" : "cloudflared");

console.log(`Baixando cloudflared (${platform}-${arch})…`);
const response = await fetchImpl(assets[platform], { redirect: "follow" });
if (!response.ok) {
  console.error(`Download falhou: HTTP ${response.status}`);
  process.exit(1);
}
const buffer = Buffer.from(await response.arrayBuffer());

if (platform === "darwin") {
  const tgz = path.join(binDir, "cloudflared.tgz");
  fs.writeFileSync(tgz, buffer);
  const tar = spawnSync("tar", ["-xzf", tgz, "-C", binDir, "cloudflared"], { stdio: "inherit" });
  fs.rmSync(tgz, { force: true });
  if (tar.status !== 0 || !fs.existsSync(target)) {
    console.error("Não foi possível extrair o pacote do macOS.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(target, buffer);
}

if (platform !== "win32") fs.chmodSync(target, 0o755);
console.log(`cloudflared instalado em ${target}`);
