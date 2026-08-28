import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "./env.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";

const dataPath = process.env.AGENT_CHAT_DATA_PATH
  ? path.resolve(process.env.AGENT_CHAT_DATA_PATH)
  : path.join(dataRoot, "agent-chat.json");
const commandStatuses = new Set([
  "queued",
  "running",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
]);

const welcomeMessage = {
  id: "welcome",
  role: "assistant",
  content: "Sou o operador do Reelforge. Você pode me avisar sobre novos vídeos no Editor Externo, pedir edições, consultar a fila ou preparar a agenda. Publicações continuam dependendo da aprovação da edição.",
  commandId: null,
  kind: "welcome",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const initialState = {
  version: 1,
  messages: [welcomeMessage],
  commands: [],
};

function ensureDataDirectory() {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
}

function writeState(state) {
  ensureDataDirectory();
  // Poda: o arquivo é reescrito inteiro a cada operação; sem limites, cresce para sempre.
  const MAX_MESSAGES = 500;
  const MAX_COMMANDS = 250;
  if (state.messages.length > MAX_MESSAGES) {
    state.messages = [
      welcomeMessage,
      ...state.messages.filter((message) => message.id !== "welcome").slice(-MAX_MESSAGES),
    ];
  }
  if (state.commands.length > MAX_COMMANDS) {
    state.commands = state.commands.slice(-MAX_COMMANDS);
  }
  const temporary = `${dataPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, dataPath);
}

export function inferAgentCommand(text) {
  const normalized = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const mentionsExternalEditor = /\b(editor externo|external-editor|externo)\b/.test(normalized);
  const mentionsEditing = /\b(edit|edita|editar|edicao|reedita|corta|cria|criar|monta|remix)\w*/.test(normalized);
  const mentionsScheduling = /\b(agenda|agendar|horario|pico|fila)\w*/.test(normalized);
  const mentionsPublishing = /\b(publica|publicar|posta|postar)\w*/.test(normalized);
  const mentionsReview = /\b(revisa|revisar|revisao|aprova|aprovado)\w*/.test(normalized);
  const countMatch = normalized.match(/\b(\d{1,3})\s+(?:novos?\s+)?videos?\b/);
  const templateMatch = [
    {
      test: /\b(template|modelo)\s*0?1\b|\btech editorial\b|\bpulse-tech\b/,
      id: "pulse-tech-editorial",
      name: "Template 01 · Tech Editorial",
    },
    {
      test: /\b(template|modelo)\s*0?2\b|\bmanifesto cinematografico\b/,
      id: "manifesto-cinematic-kinetic",
      name: "Template 02 · Manifesto Cinematográfico",
    },
    {
      test: /\b(template|modelo)\s*0?3\b/,
      id: "fluxo-padrao-dynamic",
      name: "Template 03 · Fluxo Padrão",
    },
    {
      test: /\b(template|modelo)\s*0?4\b|\bautoridade direta\b/,
      id: "authority-direct",
      name: "Template 04 · Autoridade Direta",
    },
    {
      test: /\b(template|modelo)\s*0?5\b|\bbastidores natural\b/,
      id: "natural-backstage",
      name: "Template 05 · Bastidores Natural",
    },
    {
      test: /\b(template|modelo)\s*0?6\b|\bremix\b|\btela dividida\b/,
      id: "remix-split-reaction",
      name: "Template 06 · Remix Tela Dividida",
    },
  ].find((template) => template.test.test(normalized));
  let intent = "general_operation";
  if (mentionsExternalEditor && mentionsEditing) intent = "external-editor_bulk_edit";
  else if (mentionsScheduling) intent = "schedule_planning";
  else if (mentionsEditing) intent = "editing_request";

  return {
    intent,
    expectedVideoCount: countMatch ? Number(countMatch[1]) : null,
    mentionsExternalEditor,
    includesEditing: mentionsEditing,
    includesScheduling: mentionsScheduling,
    includesPublishing: mentionsPublishing,
    includesReview: mentionsReview,
    editingTemplateId: templateMatch?.id || null,
    editingTemplateName: templateMatch?.name || null,
    approvalRequiredBeforePublishing: true,
  };
}

function normalizeState(parsed) {
  const valid =
    Boolean(parsed) &&
    parsed.version === 1 &&
    Array.isArray(parsed.messages) &&
    Array.isArray(parsed.commands);
  if (!valid) return null;
  if (!parsed.messages.some((message) => message.id === "welcome")) {
    parsed.messages.unshift(welcomeMessage);
  }
  return parsed;
}

export function loadAgentChatState() {
  ensureDataDirectory();
  const { value } = readJsonOrQuarantine(dataPath);
  const state = quarantineIfInvalid(dataPath, value, normalizeState);
  if (!state) return structuredClone(initialState);
  return state;
}

export function createAgentCommand(message) {
  const content = String(message || "").trim();
  if (content.length < 2) throw new Error("Escreva uma instrução para o agente.");
  if (content.length > 4000) throw new Error("A mensagem ultrapassa 4.000 caracteres.");

  const state = loadAgentChatState();
  const now = new Date().toISOString();
  const command = {
    id: randomUUID(),
    message: content,
    status: "queued",
    priority: /\b(agora|urgente|prioridade|imediatamente)\b/i.test(content),
    interpretation: inferAgentCommand(content),
    progress: "Aguardando o agente assumir a solicitação",
    response: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  state.commands.push(command);
  state.messages.push({
    id: randomUUID(),
    role: "user",
    content,
    commandId: command.id,
    kind: "request",
    createdAt: now,
  });
  state.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: command.interpretation.expectedVideoCount
      ? `Recebi. Coloquei a operação com ${command.interpretation.expectedVideoCount} vídeo(s) na fila do agente. Vou atualizar esta conversa conforme o trabalho avançar.`
      : "Recebi. A solicitação entrou na fila do agente e o andamento aparecerá aqui.",
    commandId: command.id,
    kind: "acknowledgement",
    createdAt: now,
  });
  writeState(state);
  return command;
}

export function getNextAgentCommand() {
  const state = loadAgentChatState();
  return state.commands
    .filter((command) => ["running", "queued"].includes(command.status))
    .sort((a, b) => {
      const runningDifference = Number(b.status === "running") - Number(a.status === "running");
      if (runningDifference) return runningDifference;
      const priorityDifference = Number(Boolean(b.priority)) - Number(Boolean(a.priority));
      if (priorityDifference) return priorityDifference;
      return new Date(a.createdAt) - new Date(b.createdAt);
    })[0] || null;
}

export function updateAgentCommand(id, patch = {}) {
  const state = loadAgentChatState();
  const index = state.commands.findIndex((command) => command.id === id);
  if (index === -1) throw new Error("Solicitação do agente não encontrada.");
  const current = state.commands[index];
  const now = new Date().toISOString();
  const nextStatus = patch.status || current.status;
  if (!commandStatuses.has(nextStatus)) throw new Error("Status da solicitação inválido.");

  const next = {
    ...current,
    status: nextStatus,
    progress: patch.progress === undefined
      ? current.progress
      : String(patch.progress || "").slice(0, 4000),
    response: patch.response === undefined
      ? current.response
      : String(patch.response || "").slice(0, 8000),
    updatedAt: now,
    startedAt: nextStatus === "running" && !current.startedAt ? now : current.startedAt,
    finishedAt: ["completed", "failed", "cancelled"].includes(nextStatus)
      ? now
      : current.finishedAt,
  };
  state.commands[index] = next;
  if (patch.response) {
    state.messages.push({
      id: randomUUID(),
      role: "assistant",
      content: String(patch.response).trim(),
      commandId: id,
      kind: nextStatus === "failed" ? "error" : "update",
      createdAt: now,
    });
  }
  writeState(state);
  return next;
}

export function appendAgentChatMessage(input = {}) {
  const content = String(input.content || "").trim();
  if (!content) throw new Error("A resposta do agente está vazia.");
  if (content.length > 8000) throw new Error("A resposta ultrapassa 8.000 caracteres.");
  const state = loadAgentChatState();
  const command = input.commandId
    ? state.commands.find((candidate) => candidate.id === input.commandId)
    : null;
  if (input.commandId && !command) throw new Error("Solicitação do agente não encontrada.");
  const message = {
    id: randomUUID(),
    role: "assistant",
    content,
    commandId: input.commandId || null,
    kind: ["update", "error", "welcome", "acknowledgement", "request"].includes(input.kind)
      ? input.kind
      : "update",
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  writeState(state);
  return message;
}

export function agentChatOverview() {
  const state = loadAgentChatState();
  const activeCommand = getNextAgentCommand();
  return {
    available: true,
    messages: state.messages.slice(-120),
    commands: state.commands.slice(-50).reverse(),
    activeCommand,
    counts: {
      queued: state.commands.filter((command) => command.status === "queued").length,
      running: state.commands.filter((command) => command.status === "running").length,
      waitingReview: state.commands.filter((command) => command.status === "waiting_review").length,
      completed: state.commands.filter((command) => command.status === "completed").length,
      failed: state.commands.filter((command) => command.status === "failed").length,
      cancelled: state.commands.filter((command) => command.status === "cancelled").length,
    },
    safeguards: {
      requiresApprovalBeforePublishing: true,
      chatCanPublishDirectly: false,
    },
  };
}
