import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const { readJsonOrQuarantine, quarantineIfInvalid } = await import("../src/json-recovery.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-json-recovery-"));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function findQuarantined(prefix) {
  return fs.readdirSync(tempRoot).find((name) => name.startsWith(`${prefix}.corrupt-`));
}

test("arquivo inexistente devolve null sem quarentena", () => {
  const file = path.join(tempRoot, "inexistente.json");
  const result = readJsonOrQuarantine(file);
  assert.deepEqual(result, { value: null, recovered: false });
  assert.ok(!fs.existsSync(file));
});

test("JSON válido é lido sem quarentena", () => {
  const file = path.join(tempRoot, "valido.json");
  fs.writeFileSync(file, JSON.stringify({ a: 1, lista: [1, 2] }));
  const result = readJsonOrQuarantine(file);
  assert.deepEqual(result, { value: { a: 1, lista: [1, 2] }, recovered: false });
  assert.ok(fs.existsSync(file), "arquivo válido deve permanecer");
});

test("JSON quebrado vai para quarentena e devolve null", () => {
  const file = path.join(tempRoot, "quebrado.json");
  fs.writeFileSync(file, "{ json quebrado proposital");
  const result = readJsonOrQuarantine(file);
  assert.equal(result.value, null);
  assert.equal(result.recovered, true);
  assert.ok(!fs.existsSync(file), "arquivo corrompido deve ser renomeado");
  const quarantined = findQuarantined("quebrado.json");
  assert.ok(quarantined, "quarentena criada");
  assert.equal(fs.readFileSync(path.join(tempRoot, quarantined), "utf8"), "{ json quebrado proposital");
});

test("quarantineIfInvalid mantém estado válido", () => {
  const file = path.join(tempRoot, "estado-valido.json");
  const value = { version: 1, items: [] };
  fs.writeFileSync(file, JSON.stringify(value));
  const returned = quarantineIfInvalid(file, value, (candidate) => candidate.version === 1);
  assert.equal(returned, value);
  assert.ok(fs.existsSync(file), "arquivo válido não deve ser tocado");
});

test("quarantineIfInvalid põe estado inválido em quarentena", () => {
  const file = path.join(tempRoot, "estado-invalido.json");
  fs.writeFileSync(file, JSON.stringify({ version: 999 }));
  const returned = quarantineIfInvalid(file, { version: 999 }, (candidate) => candidate.version === 1);
  assert.equal(returned, null);
  assert.ok(!fs.existsSync(file), "arquivo inválido deve ser renomeado");
  assert.ok(findQuarantined("estado-invalido.json"), "quarentena criada");
});

test("quarantineIfInvalid com value null retorna null sem tocar o arquivo", () => {
  const file = path.join(tempRoot, "estado-null.json");
  fs.writeFileSync(file, "conteúdo qualquer");
  const returned = quarantineIfInvalid(file, null, () => false);
  assert.equal(returned, null);
  assert.ok(fs.existsSync(file), "arquivo não deve ser renomeado quando value é null");
});
