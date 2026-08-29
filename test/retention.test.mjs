import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

let runRetentionSweep;
try {
  ({ runRetentionSweep } = await import("../src/retention.mjs"));
} catch {
  // src/retention.mjs ainda não existe (sendo criado por outro agente).
}

const SKIP_MSG =
  "src/retention.mjs ainda não existe; execução depende do outro agente.";

const roots = [];

after(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeAppRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-retention-"));
  for (const dir of ["editor/temp", "editor/outputs", "creative-matrix/temp"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  roots.push(root);
  return root;
}

function age(target, hoursAgo) {
  const when = new Date(Date.now() - hoursAgo * 3_600_000);
  fs.utimesSync(target, when, when);
}

function writeAged(root, relPath, size, hoursAgo) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(size, 1));
  age(target, hoursAgo);
  return target;
}

test("remove itens vencidos, preserva recentes e soma arquivos/bytes", (t) => {
  if (!runRetentionSweep) return t.skip(SKIP_MSG);
  const root = makeAppRoot();

  const oldTemp = writeAged(root, "editor/temp/velho.mp4", 100, 2);
  const newTemp = writeAged(root, "editor/temp/novo.mp4", 10, 1 / 60);
  const oldOutput = writeAged(root, "editor/outputs/velho.mp4", 200, 24 * 30);
  const newOutput = writeAged(root, "editor/outputs/novo.mp4", 10, 1 / 60);
  const oldTxt = writeAged(root, "editor/outputs/velho.txt", 30, 24 * 30);
  const oldMatrix = writeAged(root, "creative-matrix/temp/velho.json", 50, 2);
  const newMatrix = writeAged(root, "creative-matrix/temp/novo.json", 10, 1 / 60);

  const result = runRetentionSweep({ appRoot: root });

  assert.deepEqual(result, { removedFiles: 3, removedBytes: 350 });
  assert.ok(!fs.existsSync(oldTemp), "editor/temp velho deve ser removido");
  assert.ok(!fs.existsSync(oldOutput), "editor/outputs .mp4 velho deve ser removido");
  assert.ok(!fs.existsSync(oldMatrix), "creative-matrix/temp velho deve ser removido");
  assert.ok(fs.existsSync(newTemp), "editor/temp recente deve ser preservado");
  assert.ok(fs.existsSync(newOutput), "editor/outputs recente deve ser preservado");
  assert.ok(
    fs.existsSync(oldTxt),
    "editor/outputs só remove .mp4; .txt velho deve ser preservado",
  );
  assert.ok(fs.existsSync(newMatrix), "creative-matrix/temp recente deve ser preservado");
});

test("remove pasta antiga em creative-matrix/temp", (t) => {
  if (!runRetentionSweep) return t.skip(SKIP_MSG);
  const root = makeAppRoot();

  const oldDir = path.join(root, "creative-matrix", "temp", "antigo");
  writeAged(root, "creative-matrix/temp/antigo/clip.mp4", 40, 2);
  age(oldDir, 2);

  const newDir = path.join(root, "creative-matrix", "temp", "recente");
  writeAged(root, "creative-matrix/temp/recente/clip.mp4", 40, 1 / 60);
  age(newDir, 1 / 60);

  runRetentionSweep({ appRoot: root });

  assert.ok(!fs.existsSync(oldDir), "pasta antiga deve ser removida");
  assert.ok(fs.existsSync(newDir), "pasta recente deve ser preservada");
});

test("days=0 não remove nada", (t) => {
  if (!runRetentionSweep) return t.skip(SKIP_MSG);
  const root = makeAppRoot();

  const oldTemp = writeAged(root, "editor/temp/velho.mp4", 100, 2);
  const oldOutput = writeAged(root, "editor/outputs/velho.mp4", 200, 24 * 30);
  const oldMatrix = writeAged(root, "creative-matrix/temp/velho.json", 50, 2);

  const result = runRetentionSweep({ appRoot: root, days: 0 });

  assert.deepEqual(result, { removedFiles: 0, removedBytes: 0 });
  assert.ok(fs.existsSync(oldTemp));
  assert.ok(fs.existsSync(oldOutput));
  assert.ok(fs.existsSync(oldMatrix));
});
