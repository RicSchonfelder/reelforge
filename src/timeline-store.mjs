import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataRoot } from "./env.mjs";
import { readJsonOrQuarantine, quarantineIfInvalid } from "./json-recovery.mjs";
import { getContent } from "./content-store.mjs";
import { validateMedia } from "./media.mjs";

const timelinePath = path.join(dataRoot, "timelines.json");
const initialState = { version: 1, projects: [] };

function ensureDirectory() {
  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
}

function writeState(state) {
  ensureDirectory();
  const temporary = `${timelinePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, timelinePath);
}

export function loadTimelineState() {
  ensureDirectory();
  const { value } = readJsonOrQuarantine(timelinePath);
  const state = quarantineIfInvalid(timelinePath, value, (candidate) =>
    Boolean(candidate) && candidate.version === 1 && Array.isArray(candidate.projects));
  if (!state) return structuredClone(initialState);
  return state;
}

function durationFor(sourceFile) {
  const cached = Number(sourceFile?.validation?.details?.durationSeconds);
  if (Number.isFinite(cached) && cached > 0) return cached;
  const validation = validateMedia(sourceFile.path);
  const duration = Number(validation.details?.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Não foi possível determinar a duração do vídeo.");
  }
  return duration;
}

export function normalizeTimelineSegments(segments, duration) {
  const safe = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      id: String(segment.id || randomUUID()),
      start: Math.max(0, Math.min(duration, Number(segment.start || 0))),
      end: Math.max(0, Math.min(duration, Number(segment.end || 0))),
      enabled: segment.enabled !== false,
    }))
    .filter((segment) => segment.end - segment.start >= 0.08)
    .sort((a, b) => a.start - b.start);
  return safe.length
    ? safe
    : [{ id: randomUUID(), start: 0, end: duration, enabled: true }];
}

export function createTimelineProject(contentId) {
  const state = loadTimelineState();
  const existing = state.projects.find((project) => project.contentId === contentId);
  if (existing) return existing;
  const content = getContent(contentId);
  if (!content) throw new Error("Conteúdo não encontrado.");
  const sourceFile = content.rawFile || content.finalFile;
  if (!sourceFile?.path || !fs.existsSync(sourceFile.path)) {
    throw new Error("Envie um vídeo ao Reelforge antes de abrir a timeline.");
  }
  const duration = durationFor(sourceFile);
  const now = new Date().toISOString();
  const project = {
    id: randomUUID(),
    contentId,
    title: content.title,
    sourceFile,
    duration,
    segments: [{ id: randomUUID(), start: 0, end: duration, enabled: true }],
    settings: {
      speed: 1,
      style: "tech",
      accentColor: "#B08968",
      captions: Boolean(content.transcript?.trim()),
      music: false,
      headline: "",
      headlineY: 180,
      headlineFontSize: 56,
      headlineStart: 0.15,
      headlineEnd: Math.min(3.4, duration),
    },
    lastJobId: null,
    createdAt: now,
    updatedAt: now,
  };
  state.projects.unshift(project);
  writeState(state);
  return project;
}

export function getTimelineProject(id) {
  return loadTimelineState().projects.find((project) => project.id === id) || null;
}

export function updateTimelineProject(id, patch = {}) {
  const state = loadTimelineState();
  const index = state.projects.findIndex((project) => project.id === id);
  if (index === -1) throw new Error("Projeto da timeline não encontrado.");
  const current = state.projects[index];
  const rawAccent = typeof patch.settings?.accentColor === "string"
    ? patch.settings.accentColor
    : current.settings?.accentColor;
  const nextSettings = patch.settings
    ? {
      ...current.settings,
      ...patch.settings,
      speed: Math.min(1.4, Math.max(0.5, Number(patch.settings.speed ?? current.settings.speed))),
      headline: String(patch.settings.headline ?? current.settings.headline).slice(0, 140),
      headlineY: Math.min(1700, Math.max(100, Number(patch.settings.headlineY ?? current.settings.headlineY))),
      headlineFontSize: Math.min(110, Math.max(28, Number(patch.settings.headlineFontSize ?? current.settings.headlineFontSize))),
      accentColor: /^#[0-9a-fA-F]{6}$/.test(rawAccent || "") ? rawAccent : (current.settings?.accentColor || "#B08968"),
    }
    : current.settings;
  state.projects[index] = {
    ...current,
    segments: patch.segments
      ? normalizeTimelineSegments(patch.segments, current.duration)
      : current.segments,
    settings: nextSettings,
    lastJobId: patch.lastJobId ?? current.lastJobId,
    updatedAt: new Date().toISOString(),
  };
  writeState(state);
  return state.projects[index];
}

export function timelineOverview() {
  return {
    projects: loadTimelineState().projects.map((project) => ({
      ...project,
      mediaUrl: `/timeline-media/projects/${project.id}/source`,
    })),
  };
}
