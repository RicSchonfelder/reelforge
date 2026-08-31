import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "./env.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";

const dataDir = dataRoot;
const contentPath = path.join(dataDir, "content.json");

const initialState = {
  version: 1,
  items: [],
  references: [],
  externalProjects: [],
};

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function writeState(state) {
  ensureDataDir();
  const temporary = `${contentPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, contentPath);
}

export function loadContentState() {
  ensureDataDir();
  const { value } = readJsonOrQuarantine(contentPath);
  const parsed = quarantineIfInvalid(
    contentPath,
    value,
    (state) =>
      Boolean(state) &&
      state.version === 1 &&
      Array.isArray(state.items) &&
      Array.isArray(state.references),
  );
  if (!parsed) return structuredClone(initialState);
  if (!Array.isArray(parsed.externalProjects)) parsed.externalProjects = [];
  return parsed;
}

export function createContent(input = {}) {
  const state = loadContentState();
  const now = new Date().toISOString();
  const item = {
    id: randomUUID(),
    title: input.title?.trim() || "Conteúdo sem título",
    series: input.series?.trim() || "Fluxo Padrão",
    stage: input.stage || "inbox",
    rawFile: input.rawFile || null,
    finalFile: input.finalFile || null,
    caption: input.caption?.trim() || "",
    hashtags: Array.isArray(input.hashtags) ? input.hashtags : [],
    notes: input.notes?.trim() || "",
    editingPreset: input.editingPreset || "fluxo-padrao",
    automationMode: input.automationMode !== false,
    sourceMode: input.sourceMode || (input.rawFile ? "local" : null),
    sourceAssetId: input.sourceAssetId || null,
    sourceAssetName: input.sourceAssetName?.trim() || "",
    transcript: input.transcript || "",
    transcriptSource: input.transcriptSource || null,
    transcriptAssetId: input.transcriptAssetId || null,
    transcriptUpdatedAt: input.transcriptUpdatedAt || null,
    transcriptSegments: Array.isArray(input.transcriptSegments) ? input.transcriptSegments : [],
    transcriptWords: Array.isArray(input.transcriptWords) ? input.transcriptWords : [],
    transcriptQuality: input.transcriptQuality || null,
    transcriptStatus: input.transcriptStatus || (input.transcript ? "ready" : "idle"),
    transcriptProgress: Number(input.transcriptProgress || (input.transcript ? 1 : 0)),
    transcriptError: input.transcriptError || null,
    captionSource: input.captionSource || null,
    agentStatus: input.agentStatus || null,
    agentPriority: Boolean(input.agentPriority),
    queuedAt: input.queuedAt || null,
    externalProjectId: input.externalProjectId || null,
    externalEditorUrl: input.externalEditorUrl || null,
    scheduledJobId: null,
    coverSelection: input.coverSelection || null,
    createdAt: now,
    updatedAt: now,
  };
  state.items.unshift(item);
  writeState(state);
  return item;
}

export function updateContent(id, patch) {
  const state = loadContentState();
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Conteúdo não encontrado.");
  const allowed = [
    "title",
    "series",
    "stage",
    "rawFile",
    "finalFile",
    "caption",
    "hashtags",
    "notes",
    "externalProjectId",
    "externalEditorUrl",
    "scheduledJobId",
    "coverSelection",
    "scheduleMode",
    "scheduleSlot",
    "publishedMediaId",
    "publishedPermalink",
    "revisionRequest",
    "revisionCount",
    "approvedAt",
    "editingPreset",
    "automationMode",
    "sourceMode",
    "sourceAssetId",
    "sourceAssetName",
    "transcript",
    "transcriptSource",
    "transcriptAssetId",
    "transcriptUpdatedAt",
    "transcriptSegments",
    "transcriptWords",
    "transcriptQuality",
    "transcriptStatus",
    "transcriptRequestedModel",
    "transcriptProgress",
    "transcriptError",
    "captionSource",
    "agentStatus",
    "agentPriority",
    "queuedAt",
    "exportedAt",
    "editAudit",
    "lastPublishError",
  ];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  state.items[index] = {
    ...state.items[index],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.items[index];
}

export function getContent(id) {
  return loadContentState().items.find((item) => item.id === id) || null;
}

export function removeContent(id) {
  const state = loadContentState();
  const index = state.items.findIndex((item) => item.id === id);
  if (index === -1) throw new Error("Conteúdo não encontrado.");
  const [removed] = state.items.splice(index, 1);
  writeState(state);
  return removed;
}

export function listExternalEditorProjects() {
  return loadContentState().externalProjects;
}

export function replaceExternalEditorProjects(projects) {
  const state = loadContentState();
  state.externalProjects = projects.map((project) => ({
    projectId: String(project.projectId),
    name: String(project.name || "Projeto Editor Externo"),
    description: String(project.description || ""),
    thumbnailUrl: project.thumbnailUrl ? String(project.thumbnailUrl) : null,
    editorUrl: String(project.editorUrl),
    syncedAt: new Date().toISOString(),
  }));
  writeState(state);
  return state.externalProjects;
}

export function addReference(input) {
  const state = loadContentState();
  if (!input.url?.trim()) throw new Error("Informe a URL da referência.");
  let parsedUrl;
  try {
    parsedUrl = new URL(input.url.trim());
  } catch {
    throw new Error("Informe um link válido do Instagram.");
  }
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    !/(^|\.)instagram\.com$/i.test(parsedUrl.hostname)
  ) {
    throw new Error("Use um link de Reel ou publicação do Instagram.");
  }
  const learnStyle = input.learnStyle !== false && input.learnStyle !== "false";
  const now = new Date().toISOString();
  const reference = {
    id: randomUUID(),
    title: input.title?.trim() || "Referência",
    url: parsedUrl.toString(),
    notes: input.notes?.trim() || "",
    learnStyle,
    analysisStatus: learnStyle ? "queued" : "saved",
    analysis: null,
    analysisError: null,
    styleName: input.styleName?.trim() || "",
    createdAt: now,
    updatedAt: now,
  };
  state.references.unshift(reference);
  writeState(state);
  return reference;
}

export function getReference(id) {
  return loadContentState().references.find((reference) => reference.id === id) || null;
}

export function updateReference(id, patch = {}) {
  const state = loadContentState();
  const index = state.references.findIndex((reference) => reference.id === id);
  if (index === -1) throw new Error("Referência não encontrada.");
  const allowed = [
    "title",
    "notes",
    "learnStyle",
    "analysisStatus",
    "analysis",
    "analysisError",
    "styleName",
  ];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  const validStatuses = new Set(["saved", "queued", "analyzing", "ready", "error"]);
  if (
    safePatch.analysisStatus &&
    !validStatuses.has(safePatch.analysisStatus)
  ) {
    throw new Error("Status de análise inválido.");
  }
  if (
    safePatch.analysisStatus === "ready" &&
    !String(safePatch.analysis?.brief || state.references[index].analysis?.brief || "").trim()
  ) {
    throw new Error("O padrão aprendido precisa de um briefing de edição.");
  }
  state.references[index] = {
    ...state.references[index],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.references[index];
}

export function queueReferenceAnalysis(id) {
  return updateReference(id, {
    learnStyle: true,
    analysisStatus: "queued",
    analysisError: null,
  });
}

export function removeReference(id) {
  const state = loadContentState();
  const next = state.references.filter((reference) => reference.id !== id);
  if (next.length === state.references.length) {
    throw new Error("Referência não encontrada.");
  }
  state.references = next;
  writeState(state);
}

export function syncPublishedContent(queueJobs) {
  const state = loadContentState();
  let changed = false;
  for (const item of state.items) {
    if (!item.scheduledJobId) continue;
    const job = queueJobs.find((candidate) => candidate.id === item.scheduledJobId);
    if (!job) continue;
    const nextStage =
      job.status === "published"
        ? "published"
        : ["failed", "needs_review"].includes(job.status)
          ? "attention"
          : job.status === "cancelled"
            ? "ready"
            : job.status === "queued"
              ? "scheduled"
              : "publishing";
    if (
      item.stage !== nextStage ||
      item.publishedPermalink !== (job.permalink || null)
    ) {
      item.stage = nextStage;
      item.publishedMediaId = job.mediaId || null;
      item.publishedPermalink = job.permalink || null;
      item.lastPublishError = job.error || null;
      item.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeState(state);
  return state;
}
