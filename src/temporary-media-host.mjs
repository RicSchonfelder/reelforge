import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appRoot, getConfig } from "./env.mjs";

const tunnelUrlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function contentTypeFor(filePath) {
  return path.extname(filePath).toLowerCase() === ".mov"
    ? "video/quicktime"
    : "video/mp4";
}

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }

  return { start, end: Math.min(end, size - 1) };
}

export async function startLocalMediaServer({
  filePath,
  token = randomBytes(32).toString("hex"),
} = {}) {
  const resolvedPath = path.resolve(filePath || "");
  if (!filePath || !fs.existsSync(resolvedPath)) {
    throw new Error("O vídeo temporário não foi encontrado.");
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new Error("O caminho temporário não aponta para um arquivo.");

  const extension = path.extname(resolvedPath).toLowerCase() === ".mov" ? ".mov" : ".mp4";
  const routePath = `/media/${token}${extension}`;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (
      requestUrl.pathname !== routePath ||
      !["GET", "HEAD"].includes(request.method || "")
    ) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }

    const commonHeaders = {
      "Content-Type": contentTypeFor(resolvedPath),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const requestedRange = request.headers.range;
    if (requestedRange) {
      const range = parseRange(requestedRange, stat.size);
      if (!range) {
        response.writeHead(416, {
          ...commonHeaders,
          "Content-Range": `bytes */${stat.size}`,
        });
        response.end();
        return;
      }

      response.writeHead(206, {
        ...commonHeaders,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        fs.createReadStream(resolvedPath, range).pipe(response);
      }
      return;
    }

    response.writeHead(200, {
      ...commonHeaders,
      "Content-Length": stat.size,
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      fs.createReadStream(resolvedPath).pipe(response);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    server.close();
    throw new Error("Não foi possível abrir o servidor temporário do vídeo.");
  }

  let stopped = false;
  return {
    localUrl: `http://127.0.0.1:${port}${routePath}`,
    port,
    routePath,
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function waitForTunnelUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `O túnel HTTPS não iniciou em ${Math.round(timeoutMs / 1000)} segundos.`,
        ),
      );
    }, timeoutMs);

    const handleChunk = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
      const match = output.match(tunnelUrlPattern);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[0]);
    };
    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Falha ao iniciar o túnel HTTPS: ${error.message}`));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `O túnel HTTPS encerrou antes de ficar pronto (código ${code}).`,
        ),
      );
    });
  });
}

async function waitUntilPublic(videoUrl, { timeoutMs = 30_000 } = {}) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(videoUrl, {
        method: "HEAD",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error?.cause || error;
      try {
        const targetUrl = new URL(videoUrl);
        const dnsUrl = new URL("https://cloudflare-dns.com/dns-query");
        dnsUrl.searchParams.set("name", targetUrl.hostname);
        dnsUrl.searchParams.set("type", "A");
        const dnsResponse = await fetch(dnsUrl, {
          headers: { Accept: "application/dns-json" },
          signal: AbortSignal.timeout(5_000),
        });
        const dnsPayload = dnsResponse.ok ? await dnsResponse.json() : {};
        const address = dnsPayload.Answer?.find((answer) => answer.type === 1)?.data;
        if (address) {
          const status = await new Promise((resolve, reject) => {
            const request = https.request(
              targetUrl,
              {
                method: "HEAD",
                family: 4,
                lookup: (_hostname, _options, callback) =>
                  callback(null, address, 4),
              },
              (response) => {
                response.resume();
                resolve(response.statusCode || 0);
              },
            );
            request.setTimeout(5_000, () =>
              request.destroy(new Error("Tempo esgotado na verificação HTTPS.")),
            );
            request.once("error", reject);
            request.end();
          });
          if (status >= 200 && status < 400) return;
          lastError = new Error(`HTTP ${status} via DNS público`);
        }
      } catch (dnsError) {
        lastError = dnsError?.cause || dnsError;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `O vídeo temporário não ficou acessível pela internet: ${
      [lastError?.code, lastError?.message].filter(Boolean).join(" · ") ||
      "tempo esgotado"
    }.`,
  );
}

export async function startTemporaryMediaHost({
  filePath,
  tunnelTimeoutMs = 45_000,
  publicReadyTimeoutMs = 120_000,
} = {}) {
  const local = await startLocalMediaServer({ filePath });
  const config = getConfig();
  const executable =
    config.cloudflaredPath ||
    path.join(appRoot, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

  if (!fs.existsSync(executable)) {
    await local.stop();
    throw new Error(
      `Cloudflare Tunnel não encontrado em ${executable}. Configure CLOUDFLARED_PATH.`,
    );
  }

  const child = spawn(
    executable,
    [
      "tunnel",
      "--url",
      `http://127.0.0.1:${local.port}`,
      "--no-autoupdate",
      "--loglevel",
      "info",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!child.killed) child.kill();
    await local.stop();
  };

  try {
    const tunnelBaseUrl = await waitForTunnelUrl(child, tunnelTimeoutMs);
    const videoUrl = `${tunnelBaseUrl}${local.routePath}`;
    await waitUntilPublic(videoUrl, { timeoutMs: publicReadyTimeoutMs });
    return { videoUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
