import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const { startLocalMediaServer } = await import("../src/temporary-media-host.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-media-host-"));
const videoPath = path.join(tempRoot, "video.mp4");
const videoBytes = Buffer.concat([
  Buffer.from("REELFORGE-FAKE-MP4-CABECALHO-"),
  Buffer.alloc(64, 7),
]);
fs.writeFileSync(videoPath, videoBytes);

const host = await startLocalMediaServer({ filePath: videoPath });

after(async () => {
  await host.stop();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("GET na rota correta devolve 200 com o conteúdo do arquivo", async () => {
  const response = await fetch(host.localUrl);

  assert.equal(response.status, 200);
  assert.equal(
    Buffer.compare(Buffer.from(await response.arrayBuffer()), videoBytes),
    0,
  );
  assert.equal(response.headers.get("content-type"), "video/mp4");
});

test("GET com Range bytes=0-9 devolve 206 com 10 bytes e Content-Range", async () => {
  const response = await fetch(host.localUrl, {
    headers: { Range: "bytes=0-9" },
  });

  assert.equal(response.status, 206);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 10);
  assert.equal(Buffer.compare(body, videoBytes.subarray(0, 10)), 0);
  assert.equal(
    response.headers.get("content-range"),
    `bytes 0-9/${videoBytes.length}`,
  );
});

test("GET em rota errada devolve 404 e HEAD devolve 200 sem corpo", async () => {
  const wrongRoute = new URL("/media/token-errado.mp4", host.localUrl);
  assert.equal((await fetch(wrongRoute)).status, 404);

  const head = await fetch(host.localUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);
  assert.equal(head.headers.get("content-length"), String(videoBytes.length));
});

test("stop() fecha a porta e novas conexões falham", async () => {
  await host.stop();

  let refused = false;
  for (let attempt = 0; attempt < 20 && !refused; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${host.port}/`, {
        signal: AbortSignal.timeout(250),
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      refused = true;
    }
  }

  assert.ok(refused, "a porta deveria recusar conexões após stop()");
});
