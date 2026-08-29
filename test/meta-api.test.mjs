import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { once } from "node:events";

const { InstagramClient, MetaApiError } = await import("../src/meta-api.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-meta-api-"));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function fakeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok, status, text: async () => JSON.stringify(payload) };
  };
  return { fetchImpl, calls };
}

function makeClient(fetchImpl) {
  return new InstagramClient({
    igUserId: "178912345",
    accessToken: "token-de-teste",
    apiVersion: "v25.0",
    fetchImpl,
  });
}

test("createReelContainer rejeita videoUrl sem https", async () => {
  const client = makeClient(async () => {
    throw new Error("a rede não deveria ser chamada para URL inválida");
  });

  await assert.rejects(
    client.createReelContainer({ videoUrl: "http://inseguro.example.com/video.mp4" }),
    (error) => {
      assert.ok(error instanceof MetaApiError);
      assert.match(error.message, /exige uma URL HTTPS/);
      return true;
    },
  );

  await assert.rejects(
    client.createReelContainer({ videoUrl: "" }),
    (error) => error instanceof MetaApiError,
  );
});

test("createReelContainer monta POST para o Graph e retorna containerId", async () => {
  const { fetchImpl, calls } = fakeFetch({ id: "CONTAINER_123" });
  const client = makeClient(fetchImpl);

  const { containerId } = await client.createReelContainer({
    videoUrl: "https://publico.example.com/video.mp4",
    caption: "legenda de teste",
  });

  assert.equal(containerId, "CONTAINER_123");
  assert.equal(calls.length, 1);

  const { url, options } = calls[0];
  assert.equal(url, "https://graph.instagram.com/v25.0/178912345/media");
  assert.equal(options.method, "POST");

  const body = new URLSearchParams(options.body);
  assert.equal(body.get("media_type"), "REELS");
  assert.equal(body.get("video_url"), "https://publico.example.com/video.mp4");
  assert.equal(body.get("caption"), "legenda de teste");
});

test("erro do Graph vira MetaApiError com a mensagem do payload e o status", async () => {
  const { fetchImpl } = fakeFetch(
    { error: { message: "O token de acesso é inválido" } },
    { ok: false, status: 401 },
  );
  const client = makeClient(fetchImpl);

  await assert.rejects(client.getContainerStatus("CONTAINER_123"), (error) => {
    assert.ok(error instanceof MetaApiError);
    assert.equal(error.message, "O token de acesso é inválido");
    assert.equal(error.status, 401);
    return true;
  });
});

test("publishContainer marca erro do Graph como ambíguo", async () => {
  const { fetchImpl } = fakeFetch(
    { error: { message: "falha interna" } },
    { ok: false, status: 500 },
  );
  const client = makeClient(fetchImpl);

  await assert.rejects(client.publishContainer("CONTAINER_123"), (error) => {
    assert.ok(error instanceof MetaApiError);
    assert.equal(error.ambiguous, true);
    return true;
  });
});

test("uploadVideo marca falha de rede como ambígua", async () => {
  const filePath = path.join(tempRoot, "video.mp4");
  fs.writeFileSync(filePath, Buffer.alloc(32, 1));

  const client = makeClient(async (_url, options) => {
    const stream = options.body;
    stream?.on("error", () => {});
    stream?.destroy();
    if (stream) await once(stream, "close");
    throw new Error("ECONNRESET");
  });

  await assert.rejects(
    client.uploadVideo({ uploadUri: "https://upload.instagram.com/rupload", filePath }),
    (error) => {
      assert.ok(error instanceof MetaApiError);
      assert.equal(error.ambiguous, true);
      return true;
    },
  );
});
