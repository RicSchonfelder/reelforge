import fs from "node:fs";
import path from "node:path";
import wavefile from "wavefile";
import { appRoot } from "./env.mjs";

const { WaveFile } = wavefile;

const SAMPLE_RATE = 48_000;
const sfxDirectory = path.join(appRoot, "editor", "sfx");

function clamp(value) {
  return Math.max(-1, Math.min(1, value));
}

function writeMonoWave(filePath, duration, sampleAt) {
  const total = Math.ceil(duration * SAMPLE_RATE);
  const samples = new Int16Array(total);
  for (let index = 0; index < total; index += 1) {
    const time = index / SAMPLE_RATE;
    samples[index] = Math.round(clamp(sampleAt(time, duration, index)) * 32_000);
  }
  const wave = new WaveFile();
  wave.fromScratch(1, SAMPLE_RATE, "16", samples);
  // Escrita atômica: crash no meio do write não deixa WAV truncado no disco.
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, wave.toBuffer());
  fs.renameSync(tempPath, filePath);
}

function deterministicNoise(index) {
  const value = Math.sin(index * 12.9898 + 78.233) * 43_758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function createImpact(filePath) {
  writeMonoWave(filePath, 0.38, (time, duration, index) => {
    const envelope = Math.exp(-time * 10.5) * Math.min(1, time / 0.008);
    const body = Math.sin(2 * Math.PI * (76 - time * 55) * time) * 0.78;
    const attack = deterministicNoise(index) * Math.exp(-time * 42) * 0.32;
    return (body + attack) * envelope * (1 - time / duration * 0.2);
  });
}

function createWhoosh(filePath) {
  writeMonoWave(filePath, 0.52, (time, duration, index) => {
    const phase = time / duration;
    const envelope = Math.sin(Math.PI * phase) ** 1.7;
    const noise = deterministicNoise(index) * 0.55;
    const sweep = Math.sin(2 * Math.PI * (240 + 1_350 * phase * phase) * time) * 0.28;
    return (noise + sweep) * envelope;
  });
}

function createTick(filePath) {
  writeMonoWave(filePath, 0.14, (time, duration, index) => {
    const envelope = Math.exp(-time * 32) * Math.min(1, time / 0.003);
    const tone = Math.sin(2 * Math.PI * 1_120 * time) * 0.65;
    const click = deterministicNoise(index) * Math.exp(-time * 70) * 0.3;
    return (tone + click) * envelope * (1 - time / duration * 0.15);
  });
}

export function ensureBuiltInSfx() {
  fs.mkdirSync(sfxDirectory, { recursive: true });
  const files = {
    impact: path.join(sfxDirectory, "impact.wav"),
    whoosh: path.join(sfxDirectory, "whoosh.wav"),
    tick: path.join(sfxDirectory, "tick.wav"),
  };
  if (!fs.existsSync(files.impact)) createImpact(files.impact);
  if (!fs.existsSync(files.whoosh)) createWhoosh(files.whoosh);
  if (!fs.existsSync(files.tick)) createTick(files.tick);
  return files;
}

export function resolveSfxEvents(plan, { music = false, effectiveDuration = Infinity } = {}) {
  const files = ensureBuiltInSfx();
  return (plan?.sfx || [])
    .filter((event) => files[event.type] && Number(event.at) < effectiveDuration - 0.08)
    .map((event, index) => {
      const fallbackVolume = event.type === "impact" ? 0.42 : 0.3;
      const rawVolume = Number(event.volume ?? event.gain);
      return {
        ...event,
        path: files[event.type],
        inputIndex: 1 + (music ? 1 : 0) + index,
        at: Math.max(0, Number(event.at) || 0),
        volume: Math.min(1.5, Math.max(0.05, Number.isFinite(rawVolume) ? rawVolume : fallbackVolume)),
      };
    });
}
