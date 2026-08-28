import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appRoot, dataRoot } from "./env.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";

const editorRoot = path.join(appRoot, "editor");
const dataPath = path.join(dataRoot, "editor.json");

export const editorOutputDir = path.join(editorRoot, "outputs");
export const editorTempDir = path.join(editorRoot, "temp");
export const editorMusicDir = path.join(editorRoot, "music");

const initialState = {
  version: 1,
  jobs: [],
  music: null,
};

function ensureDirectories() {
  for (const directory of [
    path.dirname(dataPath),
    editorOutputDir,
    editorTempDir,
    editorMusicDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

function writeState(state) {
  ensureDirectories();
  const temporary = `${dataPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, dataPath);
}

export function loadEditorState() {
  ensureDirectories();
  const { value } = readJsonOrQuarantine(dataPath);
  const state = quarantineIfInvalid(dataPath, value, (candidate) =>
    Boolean(candidate) && candidate.version === 1 && Array.isArray(candidate.jobs));
  if (!state) return structuredClone(initialState);
  if (!Object.hasOwn(state, "music")) state.music = null;
  return state;
}

export function createEditorJob(input) {
  const state = loadEditorState();
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    contentId: input.contentId,
    title: input.title,
    sourceFile: input.sourceFile,
    presetId: input.presetId,
    settings: input.settings,
    status: "queued",
    progress: 0,
    step: "Aguardando o motor de edição",
    warnings: [],
    outputFile: null,
    media: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  state.jobs.unshift(job);
  state.jobs = state.jobs.slice(0, 80);
  writeState(state);
  return job;
}

export function getEditorJob(id) {
  return loadEditorState().jobs.find((job) => job.id === id) || null;
}

export function updateEditorJob(id, patch) {
  const state = loadEditorState();
  const index = state.jobs.findIndex((job) => job.id === id);
  if (index === -1) throw new Error("Renderização do editor não encontrada.");
  const allowed = [
    "status",
    "progress",
    "step",
    "warnings",
    "outputFile",
    "media",
    "error",
    "startedAt",
    "finishedAt",
    "audit",
  ];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  state.jobs[index] = {
    ...state.jobs[index],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.jobs[index];
}

export function removeEditorJob(id) {
  const state = loadEditorState();
  const index = state.jobs.findIndex((job) => job.id === id);
  if (index === -1) throw new Error("Renderização do editor não encontrada.");
  const [removed] = state.jobs.splice(index, 1);
  writeState(state);
  return removed;
}

export function setEditorMusic(file) {
  if (!file?.path) throw new Error("Descriptor da música inválido.");
  const state = loadEditorState();
  const previous = state.music;
  state.music = file;
  writeState(state);
  return { current: state.music, previous };
}

export function editorOverview() {
  const state = loadEditorState();
  const active = state.jobs.filter((job) =>
    ["queued", "analyzing", "rendering"].includes(job.status),
  );
  return {
    jobs: state.jobs,
    music: state.music?.path && fs.existsSync(state.music.path) ? state.music : null,
    engine: {
      busy: active.length > 0,
      activeJobIds: active.map((job) => job.id),
    },
  };
}
