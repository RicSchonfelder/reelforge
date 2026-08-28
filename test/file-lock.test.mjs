import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test, after } from "node:test";

const { withFileLock } = await import("../src/file-lock.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-file-lock-"));

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function lockPath(name) {
  return path.join(tempRoot, `${name}.lock`);
}

function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  assert.fail(`arquivo ${file} não apareceu em ${timeoutMs}ms`);
}

test("withFileLock executa a fn, devolve o valor e remove o lock", () => {
  const target = lockPath("basico");
  const resultado = withFileLock(target, () => {
    assert.ok(fs.existsSync(target), "lock deve existir durante a execução");
    return 42;
  });
  assert.equal(resultado, 42);
  assert.ok(!fs.existsSync(target), "lock deve ser removido após a execução");
});

test("withFileLock é reentrante no mesmo processo", () => {
  const target = lockPath("reentrante");
  const resultado = withFileLock(target, () => {
    return withFileLock(target, () => "interno");
  });
  assert.equal(resultado, "interno");
  assert.ok(!fs.existsSync(target));
});

test("lock órfão (pid inexistente) é recuperado", () => {
  const target = lockPath("orfao");
  const pidOrfao = 999999999;
  // Garante que o pid escolhido realmente não existe.
  assert.throws(() => process.kill(pidOrfao, 0));
  fs.writeFileSync(target, JSON.stringify({ pid: pidOrfao, startedAt: new Date().toISOString() }));
  const resultado = withFileLock(target, () => "recuperado");
  assert.equal(resultado, "recuperado");
  assert.ok(!fs.existsSync(target));
});

test("timeout quando outro processo vivo segura o lock", () => {
  const target = lockPath("vivo");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('fs');" +
        "fs.writeFileSync(process.argv[1], JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));" +
        "setTimeout(()=>{}, 4000);",
      target,
    ],
    { stdio: "ignore" },
  );
  child.unref();
  try {
    waitForFile(target);
    assert.throws(
      () => withFileLock(target, () => 1, { timeoutMs: 150 }),
      /Não foi possível obter o lock/,
    );
  } finally {
    try {
      child.kill();
    } catch {
      // child já saiu
    }
  }
});
