import assert from "node:assert/strict";
import { test } from "node:test";

const { parseArgs, parseBoolean } = await import("../src/args.mjs");

test("parseArgs aceita --key=value", () => {
  const parsed = parseArgs(["publish", "--caption=Olá mundo", "--count=3"]);
  assert.equal(parsed.command, "publish");
  assert.equal(parsed.options.caption, "Olá mundo");
  assert.equal(parsed.options.count, "3");
});

test("parseArgs aceita --key valor", () => {
  const parsed = parseArgs(["run", "--limit", "5"]);
  assert.equal(parsed.options.limit, "5");
});

test("parseArgs trata flag solta como true", () => {
  const parsed = parseArgs(["run", "--dry-run"]);
  assert.equal(parsed.options["dry-run"], true);
  const adjacent = parseArgs(["run", "--flag", "--other", "x"]);
  assert.equal(adjacent.options.flag, true);
  assert.equal(adjacent.options.other, "x");
});

test("parseArgs coleta positionals", () => {
  const parsed = parseArgs(["remix", "video1.mp4", "video2.mp4"]);
  assert.deepEqual(parsed.positionals, ["video1.mp4", "video2.mp4"]);
});

test("parseArgs: após -- tudo é posicional", () => {
  const parsed = parseArgs(["run", "--flag", "--", "--nao-e-opcao", "valor"]);
  assert.equal(parsed.options.flag, true);
  assert.deepEqual(parsed.positionals, ["--nao-e-opcao", "valor"]);
  assert.equal(parsed.options["nao-e-opcao"], undefined);
});

test("parseBoolean aceita sim/não e variações", () => {
  assert.equal(parseBoolean("sim"), true);
  assert.equal(parseBoolean("SIM"), true);
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("1"), true);
  assert.equal(parseBoolean("não"), false);
  assert.equal(parseBoolean("nao"), false);
  assert.equal(parseBoolean("false"), false);
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean(true), true);
  assert.throws(() => parseBoolean("talvez"), /booleano inválido/i);
});
