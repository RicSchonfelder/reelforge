import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { assessReelQuality, validateMedia } from "./media.mjs";
import { getContent, updateContent } from "./content-store.mjs";
import { appRoot } from "./env.mjs";
import {
  editorOutputDir,
  editorTempDir,
  getEditorJob,
  loadEditorState,
  updateEditorJob,
} from "./editor-store.mjs";
import { createTimedCaptions } from "./timed-captions.mjs";
import {
  assessEditorialPlan,
  planEditorialMoments,
  zoomPanExpression,
} from "./editorial-plan.mjs";
import { resolveSfxEvents } from "./editor-sfx.mjs";

const activeJobs = new Set();
const finalLibraryDir = path.join(appRoot, "library", "final");
fs.mkdirSync(finalLibraryDir, { recursive: true });

function probe(filePath) {
  const result = spawnSync(
    ffprobeStatic.path,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`Não foi possível analisar o vídeo: ${result.stderr?.trim() || "erro desconhecido"}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `Saída inválida do ffprobe: ${result.stdout?.slice(0, 200) || "vazia"}`,
    );
  }
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  const audio = data.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(data.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("O arquivo não contém um vídeo válido.");
  }
  return {
    duration,
    width: video.width,
    height: video.height,
    hasAudio: Boolean(audio),
  };
}

function runCapture(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function detectSilences(filePath, duration) {
  const result = runCapture(ffmpegPath, [
    "-hide_banner",
    "-nostdin",
    "-i",
    filePath,
    "-af",
    "silencedetect=n=-38dB:d=0.7",
    "-f",
    "null",
    "-",
  ]);
  const output = `${result.stdout}\n${result.stderr}`;
  const events = [];
  let openStart = null;
  for (const line of output.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) {
      openStart = Number(start[1]);
      continue;
    }
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && Number.isFinite(openStart)) {
      events.push({ start: openStart, end: Number(end[1]) });
      openStart = null;
    }
  }
  if (Number.isFinite(openStart)) events.push({ start: openStart, end: duration });
  return events;
}

function buildKeepSegments(duration, silences, enabled) {
  if (!enabled || !silences.length) return [{ start: 0, end: duration }];
  const padding = 0.14;
  const segments = [];
  let cursor = 0;
  for (const silence of silences) {
    const keepEnd = Math.min(duration, silence.start + padding);
    if (keepEnd - cursor >= 0.22) segments.push({ start: cursor, end: keepEnd });
    cursor = Math.max(cursor, silence.end - padding);
  }
  if (duration - cursor >= 0.22) segments.push({ start: cursor, end: duration });
  return segments.length ? segments : [{ start: 0, end: duration }];
}

function assColor(hex, alpha = "00") {
  const raw = String(hex || "#FFFFFF");
  if (!/^(?:#)?[0-9a-fA-F]{6}$/.test(raw)) {
    throw new Error(`Cor inválida para legendas: ${raw}`);
  }
  const clean = raw.replace("#", "");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`;
}

function assTime(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centiseconds = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

function escapeAss(value) {
  return String(value || "")
    .replaceAll("\\", "＼")
    .replaceAll("{", "（")
    .replaceAll("}", "）")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

function activeCaptionText(cue, activeIndex, accent) {
  return cue.words.map((word, index) => {
    const text = escapeAss(word.text);
    if (index === activeIndex) {
      return `{\\1c${assColor(accent)}\\bord5\\blur0.3}${text}{\\1c${assColor("#FFFFFF")}\\bord4\\blur0}`;
    }
    return text;
  }).join(" ");
}

function writeAssFile(job, effectiveDuration, settings, captionResult, editorialPlan) {
  const accent = settings.accentColor || "#B08968";
  const templateMode = settings.templateMode || "fluxo-padrao";
  const kinetic = ["pulse-tech", "manifesto-kinetic"].includes(templateMode);
  const captionY = Number(settings.templateRecipe?.captionY || (kinetic ? 960 : 1000));
  const captionFontSize = Math.min(
    92,
    Math.max(42, Number(settings.templateRecipe?.captionFontSize || 68)),
  );
  const headlineFontSize = Math.min(
    110,
    Math.max(28, Number(settings.headlineFontSize || 56)),
  );
  const headlineY = Math.min(
    1700,
    Math.max(100, Number(settings.headlineY || 180)),
  );
  const cues = captionResult?.cues || [];
  const graphicWindows = editorialPlan?.graphics || [];
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "ScaledBorderAndShadow: yes",
    "Collisions: Normal",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,Bahnschrift,${captionFontSize},${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000", "35")},-1,0,0,0,100,100,0,0,3,4,0,2,80,80,620,1`,
    `Style: Kinetic,Bahnschrift,${captionFontSize},${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000", "00")},-1,0,0,0,100,100,0,0,1,3,0,5,70,70,0,1`,
    `Style: KineticImpact,Bahnschrift,88,${assColor(accent)},${assColor(accent)},${assColor("#000000")},${assColor("#000000", "00")},-1,0,0,0,100,100,-1,0,1,2,0,5,55,55,0,1`,
    `Style: Manifesto,Georgia,92,${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#000000")},${assColor("#000000", "00")},-1,-1,0,0,100,100,0,0,1,0,0,5,60,60,0,1`,
    `Style: GraphicAccent,Bahnschrift,52,${assColor(accent)},${assColor(accent)},${assColor("#07110E")},${assColor("#07110E", "00")},-1,0,0,0,100,100,0,0,1,0,0,5,70,70,0,1`,
    `Style: GraphicPill,Bahnschrift,62,${assColor("#FFFFFF")},${assColor("#FFFFFF")},${assColor("#17352B")},${assColor("#07110E", "30")},-1,0,0,0,100,100,0,0,3,3,0,5,90,90,0,1`,
    `Style: Headline,Bahnschrift,${headlineFontSize},${assColor("#000000")},${assColor("#000000")},${assColor(accent)},${assColor(accent)},-1,0,0,0,100,100,1,0,3,2,0,8,70,70,150,1`,
    `Style: CTA,Bahnschrift,70,${assColor("#000000")},${assColor("#000000")},${assColor(accent)},${assColor(accent)},-1,0,0,0,100,100,0,0,3,3,0,5,90,90,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  if (settings.headline?.trim()) {
    const headlineStart = Math.max(0, Number(settings.headlineStart ?? 0.15));
    const headlineEnd = Math.min(
      effectiveDuration,
      Math.max(headlineStart + 0.2, Number(settings.headlineEnd ?? 3.4)),
    );
    lines.push(
      `Dialogue: 2,${assTime(headlineStart)},${assTime(headlineEnd)},Headline,,0,0,0,,{\\an8\\pos(540,${headlineY})}${escapeAss(settings.headline).toUpperCase()}`,
    );
  }

  if (settings.captions) {
    cues.forEach((cue, index) => {
      const chunk = cue.text;
      const chunkStart = cue.start;
      const chunkEnd = Math.min(effectiveDuration, cue.end);
      const impact = kinetic && (chunk.split(" ").length === 1 || index % 7 === 4);
      const style = templateMode === "manifesto-kinetic"
        ? (index % 4 === 0 ? "Manifesto" : impact ? "KineticImpact" : "Kinetic")
        : impact
          ? "KineticImpact"
          : kinetic
            ? "Kinetic"
            : "Caption";
      const animation = kinetic
        ? `{\\an5\\pos(540,${captionY})\\fscx86\\fscy86\\t(0,150,\\fscx100\\fscy100)}`
        : `{\\an2\\pos(540,${captionY})}`;
      const captionText = ["fluxo-padrao", "pulse-tech"].includes(templateMode)
        ? escapeAss(chunk).toUpperCase()
        : escapeAss(chunk);
      if (cue.words?.length > 1 && templateMode !== "manifesto-kinetic") {
        cue.words.forEach((word, wordIndex) => {
          const wordStart = Math.max(chunkStart, word.start);
          const nextStart = cue.words[wordIndex + 1]?.start;
          const wordEnd = Math.min(
            chunkEnd,
            Math.max(wordStart + 0.08, nextStart ?? word.end ?? chunkEnd),
          );
          lines.push(
            `Dialogue: 1,${assTime(wordStart)},${assTime(wordEnd)},${style},,0,0,0,,${animation}${activeCaptionText(cue, wordIndex, accent)}`,
          );
        });
      } else {
        lines.push(
          `Dialogue: 1,${assTime(chunkStart)},${assTime(chunkEnd)},${style},,0,0,0,,${animation}${captionText}`,
        );
      }
    });
  }

  graphicWindows.forEach((window) => {
    const graphicWords = String(window.text || "").split(/\s+/).filter(Boolean);
    const splitAt = Math.max(1, Math.ceil(graphicWords.length / 2));
    const primary = graphicWords.slice(0, splitAt).join(" ");
    const secondary = graphicWords.slice(splitAt).join(" ");
    const y = window.slot === "upper-middle" ? 560 : 310;
    if (window.type === "cta") {
      lines.push(
        `Dialogue: 6,${assTime(window.start)},${assTime(window.end)},GraphicAccent,,0,0,0,,{\\an5\\pos(540,${y - 70})\\fad(90,120)\\fscx84\\fscy84\\t(0,160,\\fscx100\\fscy100)}AÇÃO AGORA`,
        `Dialogue: 7,${assTime(window.start + 0.08)},${assTime(window.end)},CTA,,0,0,0,,{\\an5\\pos(540,${y + 55})\\fad(90,120)}${escapeAss(window.text).toUpperCase()}`,
      );
    } else if (["pulse-tech", "fluxo-padrao"].includes(templateMode)) {
      lines.push(
        `Dialogue: 5,${assTime(window.start)},${assTime(window.end)},GraphicAccent,,0,0,0,,{\\an5\\pos(540,${y - 55})\\fad(90,110)\\fscx80\\fscy80\\t(0,180,\\fscx100\\fscy100)}${window.type === "metric" ? "DADO-CHAVE" : "PONTO CENTRAL"}`,
        secondary
          ? `Dialogue: 6,${assTime(window.start + 0.08)},${assTime(window.end)},GraphicPill,,0,0,0,,{\\an5\\pos(540,${y + 60})\\fad(90,110)\\fscx88\\fscy88\\t(0,180,\\fscx100\\fscy100)}${escapeAss(`${primary} ${secondary}`).toUpperCase()}`
          : `Dialogue: 6,${assTime(window.start + 0.08)},${assTime(window.end)},GraphicPill,,0,0,0,,{\\an5\\pos(540,${y + 60})\\fad(90,110)}${escapeAss(primary).toUpperCase()}`,
      );
    } else {
      lines.push(
        `Dialogue: 5,${assTime(window.start)},${assTime(window.end)},Manifesto,,0,0,0,,{\\an5\\pos(540,900)\\frz-2\\fscx76\\fscy76\\t(0,220,\\fscx100\\fscy100)}${escapeAss(primary)}`,
        `Dialogue: 6,${assTime(window.start + 0.2)},${assTime(window.end)},Kinetic,,0,0,0,,{\\an5\\pos(540,1040)}${escapeAss(secondary)}`,
      );
    }
  });

  if (settings.ctaText?.trim()) {
    const end = Math.max(1, effectiveDuration - 0.2);
    const start = Math.max(0, end - 4.4);
    lines.push(
      `Dialogue: 8,${assTime(start)},${assTime(end)},CTA,,0,0,0,,{\\an5\\pos(540,390)\\fad(120,160)\\fscx88\\fscy88\\t(0,180,\\fscx100\\fscy100)}${escapeAss(settings.ctaText).toUpperCase()}`,
    );
  }

  const filePath = path.join(editorTempDir, `${job.id}.ass`);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return { filePath, graphicWindows, captionAudit: captionResult?.audit || null };
}

function escapeFilterPath(filePath) {
  return path.resolve(filePath)
    .replaceAll("\\", "/")
    .replaceAll(":", "\\:")
    .replaceAll("'", "\\'");
}

function buildFilterGraph({
  segments,
  hasAudio,
  speed,
  style,
  assPath,
  music,
  effectiveDuration,
  templateMode,
  graphicWindows = [],
  zooms = [],
  sfxInputs = [],
  flashes = [],
}) {
  const filters = [];
  const videoParts = [];
  const audioParts = [];

  segments.forEach((segment, index) => {
    filters.push(
      `[0:v]trim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},setpts=PTS-STARTPTS[v${index}]`,
    );
    videoParts.push(`[v${index}]`);
    if (hasAudio) {
      filters.push(
        `[0:a]atrim=start=${segment.start.toFixed(3)}:end=${segment.end.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`,
      );
      audioParts.push(`[a${index}]`);
    }
  });

  if (segments.length > 1) {
    filters.push(`${videoParts.join("")}concat=n=${segments.length}:v=1:a=0[cutv]`);
    if (hasAudio) filters.push(`${audioParts.join("")}concat=n=${segments.length}:v=0:a=1[cuta]`);
  } else {
    filters.push(`[v0]null[cutv]`);
    if (hasAudio) filters.push(`[a0]anull[cuta]`);
  }

  const colorFilter = style === "tech"
    ? "eq=contrast=1.08:saturation=1.12:brightness=-0.01,unsharp=5:5:0.45:5:5:0"
    : style === "authority"
      ? "eq=contrast=1.06:saturation=1.06,unsharp=5:5:0.25:5:5:0"
      : "eq=contrast=1.02:saturation=1.02";

  filters.push(`[cutv]setpts=PTS/${speed},split=2[bg][fg]`);
  filters.push("[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=26[bg2]");
  filters.push("[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fg2]");
  filters.push("[bg2][fg2]overlay=(W-w)/2:(H-h)/2[composed]");
  if (zooms.length) {
    const expression = zoomPanExpression(zooms, 30);
    filters.push(
      `[composed]zoompan=z='${expression}':x='iw*0.5-(iw/zoom/2)':y='ih*0.42-(ih/zoom/2)':d=1:s=1080x1920:fps=30[motion]`,
    );
  } else {
    filters.push("[composed]null[motion]");
  }
  const flashFilters = flashes.flatMap((flash) => {
    const at = Math.max(0, Number(flash.at || 0));
    const duration = Math.max(0.04, Number(flash.duration || 0.08));
    const strength = Math.min(0.4, Math.max(0.08, Number(flash.strength || 0.2)));
    const midpoint = at + duration * 0.42;
    return [
      `drawbox=x=0:y=0:w=iw:h=ih:color=white@${strength.toFixed(2)}:t=fill:enable='between(t,${at.toFixed(3)},${midpoint.toFixed(3)})'`,
      `drawbox=x=0:y=0:w=iw:h=ih:color=white@${(strength * 0.45).toFixed(2)}:t=fill:enable='between(t,${midpoint.toFixed(3)},${(at + duration).toFixed(3)})'`,
    ];
  });
  filters.push(`[motion]${[...flashFilters, colorFilter, "setsar=1", "fps=30"].join(",")}[styled]`);
  filters.push(`[styled]ass='${escapeFilterPath(assPath)}'[vout]`);

  if (hasAudio) {
    filters.push(`[cuta]atempo=${speed},loudnorm=I=-16:LRA=11:TP=-1.5,aresample=48000[voice]`);
  } else {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${effectiveDuration.toFixed(3)}[voice]`);
  }

  if (music) {
    filters.push("[voice]asplit=2[voice_sc][voice_mix]");
    filters.push(
      `[1:a]atrim=0:${effectiveDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=0.6,afade=t=out:st=${Math.max(0, effectiveDuration - 1.2).toFixed(3)}:d=1.2[music]`,
    );
    filters.push("[music][voice_sc]sidechaincompress=threshold=0.035:ratio=10:attack=20:release=500[ducked]");
    filters.push("[voice_mix][ducked]amix=inputs=2:duration=first:dropout_transition=0[baseaudio]");
  } else {
    filters.push("[voice]anull[baseaudio]");
  }

  if (sfxInputs.length) {
    sfxInputs.forEach((event, index) => {
      const delay = Math.max(0, Math.round(Number(event.at || 0) * 1000));
      filters.push(
        `[${event.inputIndex}:a]atrim=0:0.65,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${Math.min(1.5, Math.max(0.05, Number(event.volume) || 0.3)).toFixed(2)},adelay=${delay}|${delay}[sfx${index}]`,
      );
    });
    filters.push(
      `[baseaudio]${sfxInputs.map((event, index) => `[sfx${index}]`).join("")}amix=inputs=${sfxInputs.length + 1}:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]`,
    );
  } else {
    filters.push("[baseaudio]alimiter=limit=0.95[aout]");
  }

  return filters.join(";");
}

function renderWithProgress(job, args, duration) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errors = [];
    let progressBuffer = "";
    let lastUpdate = 0;
    child.stdout.on("data", (chunk) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/^out_time_ms=(\d+)/);
        if (!match) continue;
        const now = Date.now();
        if (now - lastUpdate < 700) continue;
        lastUpdate = now;
        // Duração inválida não pode gerar progress NaN; o piso 0.04 segura a barra.
        const totalSeconds = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
        const seconds = Math.min(Number(match[1]), Number.MAX_SAFE_INTEGER) / 1_000_000;
        updateEditorJob(job.id, {
          progress: Math.min(0.98, Math.max(0.04, seconds / totalSeconds)),
          step: job.settings?.previewMode
            ? "Renderizando prévia comparativa"
            : "Renderizando vídeo em alta qualidade",
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      // Guarda só as últimas ~8 KB: stderr verboso de vídeo longo não pode
      // crescer sem limite em memória.
      errors.push(chunk);
      while (errors.reduce((sum, part) => sum + part.length, 0) > 8192 && errors.length > 1) {
        errors.shift();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = Buffer.concat(errors).toString("utf8").trim();
      reject(new Error(message.slice(-6000) || `FFmpeg encerrou com código ${code}.`));
    });
  });
}

function outputDescriptor(outputPath, title) {
  const stat = fs.statSync(outputPath);
  return {
    path: outputPath,
    name: `${title} — Reelforge Editor.mp4`,
    storedName: path.basename(outputPath),
    sizeBytes: stat.size,
    uploadedAt: new Date().toISOString(),
  };
}

export async function renderEditorJob(jobId) {
  if (activeJobs.has(jobId)) return getEditorJob(jobId);
  activeJobs.add(jobId);
  let assPath = null;
  try {
    let job = getEditorJob(jobId);
    if (!job) throw new Error("Renderização do editor não encontrada.");
    const content = getContent(job.contentId);
    if (!content) throw new Error("O conteúdo vinculado foi removido.");
    if (!fs.existsSync(job.sourceFile.path)) throw new Error("O vídeo de origem não está mais disponível.");

    updateEditorJob(jobId, {
      status: "analyzing",
      progress: 0.02,
      step: job.settings.previewMode
        ? "Montando uma prévia comparativa"
        : "Analisando enquadramento, áudio e pausas",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    if (!job.settings.previewMode) {
      updateContent(content.id, {
        stage: "editing",
        agentStatus: "Renderizando agora no Reelforge Editor",
        agentPriority: false,
      });
    }

    const source = probe(job.sourceFile.path);
    const silences = source.hasAudio
      ? detectSilences(job.sourceFile.path, source.duration)
      : [];
    const manualSegments = Array.isArray(job.settings.manualSegments)
      ? job.settings.manualSegments
        .map((segment) => ({
          start: Math.max(0, Math.min(source.duration, Number(segment.start || 0))),
          end: Math.max(0, Math.min(source.duration, Number(segment.end || 0))),
        }))
        .filter((segment) => segment.end - segment.start >= 0.08)
        .sort((a, b) => a.start - b.start)
        // Corta trechos sobrepostos em vez de renderizar conteúdo duplicado.
        .reduce((unique, segment) => {
          const start = Math.max(segment.start, unique.at(-1)?.end ?? 0);
          if (segment.end - start >= 0.08) unique.push({ start, end: segment.end });
          return unique;
        }, [])
      : [];
    const segments = manualSegments.length
      ? manualSegments
      : buildKeepSegments(
        source.duration,
        silences,
        Boolean(job.settings.removeSilence),
      );
    const cutDuration = segments.reduce(
      (sum, segment) => sum + segment.end - segment.start,
      0,
    );
    const maxSeconds = job.settings.previewMode
      ? Number(job.settings.previewSeconds || 16)
      : Number(job.settings.maxSeconds || 90);
    const speed = Math.min(1.4, Math.max(1, Number(job.settings.speed || 1.3)));
    const uncappedDuration = cutDuration / speed;
    const effectiveDuration = Math.min(maxSeconds, uncappedDuration);
    const warnings = [];
    if (uncappedDuration > maxSeconds) {
      warnings.push(
        `O conteúdo ultrapassava ${maxSeconds}s após os cortes; a saída foi limitada para respeitar o padrão.`,
      );
    }
    const captionResult = job.settings.captions
      ? createTimedCaptions({
        transcriptWords: job.settings.transcriptWords,
        transcriptSegments: job.settings.transcriptSegments,
        sourceSegments: segments,
        speed,
        maxOutputSeconds: effectiveDuration,
        wordsPerPage: job.settings.templateRecipe?.wordsPerPage,
        templateMode: job.settings.templateMode,
      })
      : { cues: [], audit: { syncMode: "disabled", captionCueCount: 0 } };
    if (job.settings.captions && !captionResult.cues.length) {
      throw new Error(
        "A renderização foi bloqueada: não há timestamps confiáveis para sincronizar as legendas.",
      );
    }
    if (job.settings.captions && captionResult.audit.coverageRatio < 0.72) {
      throw new Error(
        `A renderização foi bloqueada: a transcrição cobre apenas ${Math.round(captionResult.audit.coverageRatio * 100)}% do trecho editado. Transcreva novamente antes de publicar.`,
      );
    }
    if (job.settings.captions) {
      const semanticStatus = job.settings.transcriptQuality?.semanticStatus;
      const precisionReady = job.settings.transcriptQuality?.modelTier === "precision"
        || semanticStatus === "reviewed";
      if (!["clean", "reviewed"].includes(semanticStatus)) {
        throw new Error(
          "A renderização foi bloqueada: a transcrição contém palavras suspeitas. Revise o texto ou transcreva novamente em alta precisão.",
        );
      }
      if (!precisionReady) {
        throw new Error(
          "A renderização foi bloqueada: use a transcrição de alta precisão ou revise manualmente o texto antes de criar as legendas.",
        );
      }
    }

    const editorialPlan = planEditorialMoments({
      cues: captionResult.cues,
      duration: effectiveDuration,
      templateMode: job.settings.templateMode,
    });
    const editorialQuality = assessEditorialPlan(editorialPlan, {
      duration: effectiveDuration,
      templateMode: job.settings.templateMode,
    });
    if (!editorialQuality.ok) {
      throw new Error(`A renderização foi bloqueada: ${editorialQuality.issues.join(", ")}.`);
    }

    job = getEditorJob(jobId);
    const assResult = writeAssFile(job, effectiveDuration, {
      ...job.settings,
      captions: Boolean(job.settings.captions && captionResult.cues.length),
    }, captionResult, editorialPlan);
    assPath = assResult.filePath;
    const outputDirectory = job.settings.previewMode
      ? editorOutputDir
      : finalLibraryDir;
    fs.mkdirSync(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `${job.id}.mp4`);
    const musicState = loadEditorState().music;
    const music = job.settings.music && musicState?.path && fs.existsSync(musicState.path)
      ? musicState
      : null;
    if (job.settings.music && !music) {
      throw new Error(
        "A renderização foi bloqueada: o modelo pediu música, mas a música padrão não está configurada.",
      );
    }
    const sfxInputs = resolveSfxEvents(editorialPlan, {
      music: Boolean(music),
      effectiveDuration,
    });
    const filter = buildFilterGraph({
      segments,
      hasAudio: source.hasAudio,
      speed,
      style: job.settings.style,
      assPath,
      music,
      effectiveDuration,
      templateMode: job.settings.templateMode,
      graphicWindows: assResult.graphicWindows,
      zooms: editorialPlan.zooms,
      sfxInputs,
      flashes: editorialPlan.flashes,
    });
    const editAudit = {
      ...captionResult.audit,
      sourceDuration: source.duration,
      outputDuration: effectiveDuration,
      speed,
      cutCount: segments.length,
      musicApplied: Boolean(music),
      transcriptSemanticStatus: job.settings.transcriptQuality?.semanticStatus || "disabled",
      motionPlan: editorialPlan,
      editorialQuality,
      sfxApplied: sfxInputs.map(({ type, at, volume }) => ({ type, at, volume })),
      qualityGate: "semantic-motion-v3",
    };
    const args = [
      "-y",
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-progress",
      "pipe:1",
      "-i",
      job.sourceFile.path,
    ];
    if (music) args.push("-stream_loop", "-1", "-i", music.path);
    sfxInputs.forEach((event) => args.push("-i", event.path));
    args.push(
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-t",
      effectiveDuration.toFixed(3),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-maxrate",
      "16M",
      "-bufsize",
      "32M",
      "-profile:v",
      "high",
      "-level",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    );
    updateEditorJob(jobId, {
      status: "rendering",
      progress: 0.04,
      step: job.settings.previewMode
        ? "Renderizando prévia comparativa"
        : "Renderizando vídeo em alta qualidade",
      warnings,
      audit: editAudit,
    });
    await renderWithProgress(job, args, effectiveDuration);

    const descriptor = outputDescriptor(outputPath, content.title);
    const validation = validateMedia(outputPath, { ffprobePath: ffprobeStatic.path });
    const quality = assessReelQuality(validation);
    if (!quality.ok) {
      throw new Error(`A saída não passou no controle de qualidade: ${quality.errors.join(" ")}`);
    }
    const finalFile = { ...descriptor, validation, quality };
    if (!job.settings.previewMode) {
      updateContent(content.id, {
        finalFile,
        stage: "review",
        editingPreset: job.presetId,
        automationMode: true,
        agentStatus: "Pronto para sua revisão · criado no Reelforge Editor",
        exportedAt: new Date().toISOString(),
        approvedAt: null,
        revisionRequest: null,
        editAudit: {
          ...editAudit,
          passedAt: new Date().toISOString(),
        },
      });
    }
    return updateEditorJob(jobId, {
      status: "ready",
      progress: 1,
      step: job.settings.previewMode
        ? "Prévia pronta para comparar"
        : "Pronto para revisão",
      warnings,
      audit: editAudit,
      outputFile: descriptor,
      media: validation.details,
      error: null,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    const job = getEditorJob(jobId);
    if (job?.contentId && !job.settings?.previewMode) {
      updateContent(job.contentId, {
        stage: "attention",
        agentStatus: `Reelforge Editor: ${error.message.slice(0, 180)}`,
      });
    }
    updateEditorJob(jobId, {
      status: "failed",
      step: "A edição precisa de atenção",
      error: error.message.slice(-6000),
      finishedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    activeJobs.delete(jobId);
    if (assPath) fs.rmSync(assPath, { force: true });
  }
}

export function startEditorJob(jobId) {
  setTimeout(() => {
    renderEditorJob(jobId).catch((error) => {
      console.error(`[editor] render ${jobId} falhou: ${error?.message || error}`);
    });
  }, 0);
}

export function editorEngineStatus() {
  return {
    busy: activeJobs.size > 0,
    activeJobIds: [...activeJobs],
    ffmpegAvailable: Boolean(ffmpegPath && fs.existsSync(ffmpegPath)),
  };
}
