import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appRoot, dataRoot } from "./env.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";

export const creativeMatrixRoot = path.join(appRoot, "creative-matrix");
export const creativePiecesDir = path.join(creativeMatrixRoot, "pieces");
export const creativeNormalizedDir = path.join(creativeMatrixRoot, "normalized");
export const creativeOutputsDir = path.join(creativeMatrixRoot, "outputs");
export const creativeTempDir = path.join(creativeMatrixRoot, "temp");

const dataPath = path.join(dataRoot, "creative-matrix.json");
const roles = new Set(["hook", "body", "cta"]);
const initialState = { version: 1, pieces: [], batches: [] };

function ensureDirectories() {
  for (const directory of [
    path.dirname(dataPath),
    creativePiecesDir,
    creativeNormalizedDir,
    creativeOutputsDir,
    creativeTempDir,
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

export function loadCreativeMatrixState() {
  ensureDirectories();
  const { value } = readJsonOrQuarantine(dataPath);
  const state = quarantineIfInvalid(dataPath, value, (candidate) =>
    Boolean(candidate)
    && candidate.version === 1
    && Array.isArray(candidate.pieces)
    && Array.isArray(candidate.batches));
  if (!state) return structuredClone(initialState);
  return state;
}

/**
 * Após um crash, lotes travados em "generating" são reprocessáveis: reseta
 * contadores e reaproveita saídas que já existem no disco.
 */
export function recoverInterruptedBatches() {
  const state = loadCreativeMatrixState();
  const stuck = state.batches.filter((batch) => batch.status === "generating");
  let changed = false;
  for (const batch of stuck) {
    resetCreativeBatch(batch.id);
    changed = true;
  }
  return stuck.length;
}

export function addCreativePiece(input) {
  if (!roles.has(input.role)) throw new Error("Tipo de peça inválido.");
  const state = loadCreativeMatrixState();
  const now = new Date().toISOString();
  const piece = {
    id: randomUUID(),
    role: input.role,
    name: String(input.name || input.file?.name || "Peça criativa").trim(),
    file: input.file,
    normalizedFile: null,
    media: input.media || null,
    status: "ready",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  state.pieces.unshift(piece);
  writeState(state);
  return piece;
}

export function updateCreativePiece(id, patch) {
  const state = loadCreativeMatrixState();
  const index = state.pieces.findIndex((piece) => piece.id === id);
  if (index === -1) throw new Error("Peça criativa não encontrada.");
  const allowed = ["name", "normalizedFile", "media", "status", "error"];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  state.pieces[index] = {
    ...state.pieces[index],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.pieces[index];
}

export function removeCreativePiece(id) {
  const state = loadCreativeMatrixState();
  const index = state.pieces.findIndex((piece) => piece.id === id);
  if (index === -1) throw new Error("Peça criativa não encontrada.");
  const isInActiveBatch = state.batches.some((batch) =>
    ["queued", "generating"].includes(batch.status) &&
    batch.combinations.some((combination) =>
      [combination.hookId, combination.bodyId, combination.ctaId].includes(id),
    ),
  );
  if (isInActiveBatch) {
    throw new Error("Esta peça está sendo usada por um lote em geração.");
  }
  const [removed] = state.pieces.splice(index, 1);
  writeState(state);
  return removed;
}

export function buildCreativeCombinations(pieces, selectedPieceIds = null) {
  const selected = Array.isArray(selectedPieceIds) && selectedPieceIds.length
    ? pieces.filter((piece) => selectedPieceIds.includes(piece.id))
    : pieces;
  const hooks = selected.filter((piece) => piece.role === "hook");
  const bodies = selected.filter((piece) => piece.role === "body");
  const ctas = selected.filter((piece) => piece.role === "cta");
  if (!hooks.length || !bodies.length || !ctas.length) {
    throw new Error("Adicione pelo menos um Gancho, um Corpo e um CTA.");
  }
  return hooks.flatMap((hook, hookIndex) =>
    bodies.flatMap((body, bodyIndex) =>
      ctas.map((cta, ctaIndex) => ({
        id: randomUUID(),
        hookId: hook.id,
        bodyId: body.id,
        ctaId: cta.id,
        label: `G${String(hookIndex + 1).padStart(2, "0")} · C${String(bodyIndex + 1).padStart(2, "0")} · CTA${String(ctaIndex + 1).padStart(2, "0")}`,
        status: "queued",
        outputFile: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    ),
  );
}

export function createCreativeBatch(input = {}) {
  const state = loadCreativeMatrixState();
  const combinations = buildCreativeCombinations(state.pieces, input.pieceIds);
  if (combinations.length > 120) {
    throw new Error("O lote ultrapassa 120 combinações. Remova algumas peças antes de gerar.");
  }
  const now = new Date().toISOString();
  const batch = {
    id: randomUUID(),
    name: String(input.name || `Lote ${state.batches.length + 1}`).trim(),
    status: "queued",
    combinations,
    total: combinations.length,
    completed: 0,
    failed: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  state.batches.unshift(batch);
  writeState(state);
  return batch;
}

export function getCreativeBatch(id) {
  return loadCreativeMatrixState().batches.find((batch) => batch.id === id) || null;
}

export function updateCreativeBatch(id, patch) {
  const state = loadCreativeMatrixState();
  const index = state.batches.findIndex((batch) => batch.id === id);
  if (index === -1) throw new Error("Lote criativo não encontrado.");
  const allowed = [
    "name",
    "status",
    "completed",
    "failed",
    "error",
    "startedAt",
    "finishedAt",
  ];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  state.batches[index] = {
    ...state.batches[index],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.batches[index];
}

export function updateCreativeCombination(batchId, combinationId, patch) {
  const state = loadCreativeMatrixState();
  const batchIndex = state.batches.findIndex((batch) => batch.id === batchId);
  if (batchIndex === -1) throw new Error("Lote criativo não encontrado.");
  const combinationIndex = state.batches[batchIndex].combinations.findIndex(
    (combination) => combination.id === combinationId,
  );
  if (combinationIndex === -1) throw new Error("Variação criativa não encontrada.");
  const allowed = ["status", "outputFile", "error"];
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([key]) => allowed.includes(key)),
  );
  state.batches[batchIndex].combinations[combinationIndex] = {
    ...state.batches[batchIndex].combinations[combinationIndex],
    ...safePatch,
    updatedAt: new Date().toISOString(),
  };
  state.batches[batchIndex].updatedAt = new Date().toISOString();
  writeState(state);
  return state.batches[batchIndex].combinations[combinationIndex];
}

export function resetCreativeBatch(id) {
  const state = loadCreativeMatrixState();
  const index = state.batches.findIndex((batch) => batch.id === id);
  if (index === -1) throw new Error("Lote criativo não encontrado.");
  const now = new Date().toISOString();
  state.batches[index] = {
    ...state.batches[index],
    status: "queued",
    completed: 0,
    failed: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    combinations: state.batches[index].combinations.map((combination) => ({
      ...combination,
      status: combination.outputFile?.path && fs.existsSync(combination.outputFile.path)
        ? "ready"
        : "queued",
      error: null,
      updatedAt: now,
    })),
  };
  state.batches[index].completed = state.batches[index].combinations.filter(
    (combination) => combination.status === "ready",
  ).length;
  writeState(state);
  return state.batches[index];
}

export function removeCreativeBatch(id) {
  const state = loadCreativeMatrixState();
  const index = state.batches.findIndex((batch) => batch.id === id);
  if (index === -1) throw new Error("Lote criativo não encontrado.");
  if (state.batches[index].status === "generating") {
    throw new Error("Aguarde a geração terminar antes de excluir o lote.");
  }
  const [removed] = state.batches.splice(index, 1);
  writeState(state);
  return removed;
}
