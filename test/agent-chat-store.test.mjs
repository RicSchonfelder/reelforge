import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reelforge-agent-chat-"));
const dataFile = path.join(tempRoot, "agent-chat.json");
process.env.AGENT_CHAT_DATA_PATH = dataFile;

// Importa depois de definir o caminho (o store resolve dataPath no import).
const {
  createAgentCommand,
  updateAgentCommand,
  appendAgentChatMessage,
  agentChatOverview,
} = await import("../src/agent-chat-store.mjs");

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("createAgentCommand valida tamanho entre 2 e 4000", () => {
  assert.throws(() => createAgentCommand("a"), /instrução/i);
  assert.throws(() => createAgentCommand("   "), /instrução/i);
  assert.throws(() => createAgentCommand("x".repeat(4001)), /4\.000/);
});

test("createAgentCommand cria comando queued com mensagem de reconhecimento", () => {
  const command = createAgentCommand("editar 2 vídeos novos agora");
  assert.ok(command.id);
  assert.equal(command.status, "queued");
  assert.equal(command.priority, true);
  assert.equal(command.interpretation.expectedVideoCount, 2);
  const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  const kinds = state.messages.filter((message) => message.commandId === command.id).map((m) => m.kind);
  assert.deepEqual(kinds, ["request", "acknowledgement"]);
});

test("updateAgentCommand valida status", () => {
  const command = createAgentCommand("comando para status inválido");
  assert.throws(() => updateAgentCommand(command.id, { status: "statusmaluco" }), /Status/);
  assert.throws(() => updateAgentCommand("id-inexistente", { status: "running" }), /não encontrada/);
});

test("updateAgentCommand trunca response acima de 8000 e marca startedAt", () => {
  const command = createAgentCommand("comando com resposta longa");
  const patched = updateAgentCommand(command.id, {
    status: "running",
    response: "r".repeat(9000),
  });
  assert.equal(patched.response.length, 8000);
  assert.ok(patched.startedAt, "startedAt deve ser marcado ao entrar em running");
  const finished = updateAgentCommand(command.id, { status: "completed" });
  assert.ok(finished.finishedAt, "finishedAt deve ser marcado ao concluir");
});

test("appendAgentChatMessage: kind desconhecido vira update e commandId é validado", () => {
  const command = createAgentCommand("comando para mensagem do agente");
  const message = appendAgentChatMessage({
    content: "Andamento parcial",
    kind: "kind-que-nao-existe",
    commandId: command.id,
  });
  assert.equal(message.kind, "update");
  assert.equal(message.commandId, command.id);

  assert.throws(
    () => appendAgentChatMessage({ content: "oi", commandId: "id-falso" }),
    /não encontrada/,
  );
  assert.throws(() => appendAgentChatMessage({ content: "   " }), /vazia/);

  const anonymous = appendAgentChatMessage({ content: "sem comando" });
  assert.equal(anonymous.commandId, null);
});

test("contadores de failed e cancelled no overview", () => {
  const failed = createAgentCommand("comando que falha");
  const cancelled = createAgentCommand("comando cancelado");
  const completed = createAgentCommand("comando concluído");
  updateAgentCommand(failed.id, { status: "failed" });
  updateAgentCommand(cancelled.id, { status: "cancelled" });
  updateAgentCommand(completed.id, { status: "completed" });
  const counts = agentChatOverview().counts;
  assert.ok(counts.failed >= 1);
  assert.ok(counts.cancelled >= 1);
  assert.ok(counts.completed >= 1);
});

test("poda: 600 comandos viram no máximo 250 comandos e 500 mensagens", () => {
  for (let index = 0; index < 600; index += 1) {
    createAgentCommand(`teste de poda ${index}`);
  }
  const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(state.commands.length, 250);
  assert.ok(state.messages.length <= 501, "mensagens devem ser podadas perto do cap");
  assert.equal(state.messages[0].id, "welcome", "mensagem de bem-vindo é preservada");
  assert.equal(state.commands.at(-1).message, "teste de poda 599", "comandos mais recentes são mantidos");
});
