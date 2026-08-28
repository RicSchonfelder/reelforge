const DEFAULT_GLOSSARY = [
  "Reelforge",
  "Editor Externo",
  "SaaS",
  "ROAS",
  "Meta Ads",
  "dashboard",
  "lead",
  "leads",
  "webinar",
  "funil",
  "CPA",
  "CTR",
  "ticket",
  "lançamento",
  "escala",
];

const ALWAYS_REPLACE = new Map([
  ["saas", ["SaaS"]],
  ["roas", ["ROAS"]],
  ["reelforge", ["Reelforge"]],
  ["mes restado", ["mesmo", "resultado"]],
  ["mês restado", ["mesmo", "resultado"]],
]);

const SUSPICIOUS_KEYS = new Map([
  ["restado", "Possível reconhecimento incorreto de “resultado”."],
]);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function transcriptTokenKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

function punctuationSuffix(value) {
  return String(value || "").match(/[^\p{L}\p{N}]+$/u)?.[0] || "";
}

function tokenWeight(value) {
  return Math.max(1, transcriptTokenKey(value).length);
}

function retimeReplacement(original, replacements) {
  if (!replacements.length) return [];
  const start = Math.max(0, finite(original[0]?.start));
  const end = Math.max(start + 0.06, finite(original.at(-1)?.end, start + 0.3));
  const suffix = punctuationSuffix(original.at(-1)?.text);
  const texts = replacements.map((text, index) =>
    index === replacements.length - 1 && suffix && !punctuationSuffix(text)
      ? `${text}${suffix}`
      : text,
  );
  const weights = texts.map(tokenWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  return texts.map((text, index) => {
    const duration = ((end - start) * weights[index]) / total;
    const word = { text, start: cursor, end: cursor + duration };
    cursor += duration;
    return word;
  });
}

function hasLeadContext(words, index) {
  const context = words
    .slice(Math.max(0, index - 8), index + 9)
    .map((word) => transcriptTokenKey(word.text));
  return context.some((key) => [
    "funil", "grupo", "grupos", "quantidade", "viraram", "chegando",
    "campanha", "campanhas", "conversao", "trafego",
  ].includes(key));
}

export function applyDomainCorrections(inputWords = []) {
  const words = (Array.isArray(inputWords) ? inputWords : [])
    .map((word) => ({
      text: String(word?.text || "").trim(),
      start: Math.max(0, finite(word?.start)),
      end: Math.max(0, finite(word?.end, word?.start)),
    }))
    .filter((word) => word.text);
  const corrected = [];
  const corrections = [];
  let index = 0;
  while (index < words.length) {
    const pair = `${transcriptTokenKey(words[index]?.text)} ${transcriptTokenKey(words[index + 1]?.text)}`.trim();
    const single = transcriptTokenKey(words[index]?.text);
    let span = 1;
    let replacement = ALWAYS_REPLACE.get(pair);
    if (replacement) span = 2;
    if (!replacement) replacement = ALWAYS_REPLACE.get(single);
    if (!replacement && single === "lideres" && hasLeadContext(words, index)) {
      replacement = ["leads"];
    }
    if (!replacement) {
      corrected.push(words[index]);
      index += 1;
      continue;
    }
    const source = words.slice(index, index + span);
    const output = retimeReplacement(source, replacement);
    corrected.push(...output);
    corrections.push({
      from: source.map((word) => word.text).join(" "),
      to: output.map((word) => word.text).join(" "),
      start: source[0].start,
      end: source.at(-1).end,
    });
    index += span;
  }
  return { words: corrected, corrections };
}

export function transcriptFromWords(words = []) {
  return (Array.isArray(words) ? words : [])
    .map((word) => String(word.text || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function segmentsFromWords(words = [], { maxWords = 14, maxGap = 0.7 } = {}) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      start: current[0].start,
      end: current.at(-1).end,
      text: transcriptFromWords(current),
    });
    current = [];
  };
  for (const word of Array.isArray(words) ? words : []) {
    const gap = current.length ? finite(word.start) - finite(current.at(-1).end) : 0;
    if (current.length && (current.length >= maxWords || gap > maxGap)) flush();
    current.push(word);
    if (/[.!?]$/.test(String(word.text || ""))) flush();
  }
  flush();
  return segments;
}

function punctuationRatio(words) {
  if (!words.length) return 0;
  const endings = words.filter((word) => /[.!?]$/.test(String(word.text || ""))).length;
  return endings / words.length;
}

export function assessTranscriptQuality({
  words = [],
  transcript = "",
  modelId = "",
  audioDuration = 0,
  corrections = [],
  manualReviewedAt = null,
} = {}) {
  const safeWords = Array.isArray(words) ? words : [];
  const issues = [];
  safeWords.forEach((word, index) => {
    const key = transcriptTokenKey(word.text);
    const message = SUSPICIOUS_KEYS.get(key);
    if (message) issues.push({ severity: "blocking", word: word.text, index, message });
  });
  const normalizedTranscript = String(transcript || "").toLowerCase();
  if (/\bl[ií]deres\b/i.test(normalizedTranscript) && /\b(funil|grupos?|leads?)\b/i.test(normalizedTranscript)) {
    issues.push({
      severity: "warning",
      word: "líderes",
      message: "Confira se a fala original era “leads”.",
    });
  }
  for (let index = 1; index < safeWords.length; index += 1) {
    if (finite(safeWords[index].start) + 0.01 < finite(safeWords[index - 1].start)) {
      issues.push({ severity: "blocking", word: safeWords[index].text, message: "Timestamps fora de ordem." });
      break;
    }
  }
  const transcriptEnd = safeWords.reduce((max, word) => Math.max(max, finite(word.end)), 0);
  const timestampCoverage = audioDuration > 0 ? Math.min(1, transcriptEnd / audioDuration) : 0;
  if (audioDuration > 0 && timestampCoverage < 0.82) {
    issues.push({ severity: "blocking", message: "A transcrição não cobre o áudio completo." });
  }
  if (safeWords.length >= 40 && punctuationRatio(safeWords) < 0.006) {
    issues.push({ severity: "warning", message: "Pontuação insuficiente para formar legendas naturais." });
  }
  const precisionModel = /large-v3-turbo/i.test(modelId);
  if (!precisionModel) {
    issues.push({
      severity: "warning",
      message: "Transcrição criada com o modelo padrão; prefira o modo de alta precisão.",
    });
  }
  const blocking = issues.filter((issue) => issue.severity === "blocking");
  const semanticStatus = manualReviewedAt
    ? "reviewed"
    : blocking.length
      ? "needs_review"
      : "clean";
  const score = Math.max(
    0,
    100 - blocking.length * 28 - issues.filter((issue) => issue.severity === "warning").length * 5 - (precisionModel ? 0 : 8),
  );
  return {
    semanticStatus,
    score,
    issues,
    autoCorrections: corrections,
    glossary: DEFAULT_GLOSSARY,
    modelTier: precisionModel ? "precision" : "standard",
    timestampCoverage,
    manualReviewedAt,
  };
}

function lcsAnchors(originalKeys, editedKeys) {
  const rows = Array.from(
    { length: originalKeys.length + 1 },
    () => new Uint16Array(editedKeys.length + 1),
  );
  for (let i = 1; i <= originalKeys.length; i += 1) {
    for (let j = 1; j <= editedKeys.length; j += 1) {
      rows[i][j] = originalKeys[i - 1] === editedKeys[j - 1]
        ? rows[i - 1][j - 1] + 1
        : Math.max(rows[i - 1][j], rows[i][j - 1]);
    }
  }
  const anchors = [];
  let i = originalKeys.length;
  let j = editedKeys.length;
  while (i > 0 && j > 0) {
    if (originalKeys[i - 1] === editedKeys[j - 1]) {
      anchors.push({ original: i - 1, edited: j - 1 });
      i -= 1;
      j -= 1;
    } else if (rows[i - 1][j] >= rows[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return anchors.reverse();
}

export function alignEditedTranscript(originalWords = [], editedTranscript = "") {
  const originals = Array.isArray(originalWords) ? originalWords : [];
  const edited = String(editedTranscript || "").match(/\S+/g) || [];
  if (!originals.length || !edited.length) return [];
  const anchors = lcsAnchors(
    originals.map((word) => transcriptTokenKey(word.text)),
    edited.map(transcriptTokenKey),
  );
  const output = new Array(edited.length);
  anchors.forEach(({ original, edited: editedIndex }) => {
    output[editedIndex] = {
      text: edited[editedIndex],
      start: finite(originals[original].start),
      end: finite(originals[original].end, originals[original].start),
    };
  });
  const boundaries = [
    { original: -1, edited: -1 },
    ...anchors,
    { original: originals.length, edited: edited.length },
  ];
  for (let boundary = 0; boundary < boundaries.length - 1; boundary += 1) {
    const left = boundaries[boundary];
    const right = boundaries[boundary + 1];
    const from = left.edited + 1;
    const to = right.edited;
    if (to <= from) continue;
    const start = left.original >= 0
      ? finite(originals[left.original].end)
      : finite(originals[0].start);
    const end = right.original < originals.length
      ? finite(originals[right.original].start, start + 0.3)
      : finite(originals.at(-1).end, start + (to - from) * 0.28);
    const texts = edited.slice(from, to);
    const weights = texts.map(tokenWeight);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    texts.forEach((text, offset) => {
      const duration = Math.max(0.04, ((Math.max(end, start + 0.06) - start) * weights[offset]) / total);
      output[from + offset] = { text, start: cursor, end: cursor + duration };
      cursor += duration;
    });
  }
  return output.filter(Boolean);
}

