function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tokenWeight(token) {
  return Math.max(1, cleanText(token).replace(/[^\p{L}\p{N}]/gu, "").length);
}

export function buildOutputTimeline(sourceSegments, speed = 1, maxOutputSeconds = Infinity) {
  const rate = Math.max(0.1, finite(speed, 1));
  const limit = Math.max(0, finite(maxOutputSeconds, Infinity));
  const normalized = (Array.isArray(sourceSegments) ? sourceSegments : [])
    .map((segment) => ({
      sourceStart: Math.max(0, finite(segment.start)),
      sourceEnd: Math.max(0, finite(segment.end)),
    }))
    .filter((segment) => segment.sourceEnd > segment.sourceStart)
    .sort((a, b) => a.sourceStart - b.sourceStart);

  let outputCursor = 0;
  const timeline = [];
  for (const segment of normalized) {
    if (outputCursor >= limit) break;
    const fullOutputDuration = (segment.sourceEnd - segment.sourceStart) / rate;
    const outputDuration = Math.min(fullOutputDuration, limit - outputCursor);
    if (outputDuration <= 0) break;
    timeline.push({
      ...segment,
      sourceEnd: segment.sourceStart + outputDuration * rate,
      outputStart: outputCursor,
      outputEnd: outputCursor + outputDuration,
      speed: rate,
    });
    outputCursor += outputDuration;
  }
  return timeline;
}

export function sourceTimeToOutput(timeline, sourceTime) {
  const time = finite(sourceTime, -1);
  const segment = (Array.isArray(timeline) ? timeline : []).find(
    (candidate) => time >= candidate.sourceStart && time <= candidate.sourceEnd,
  );
  if (!segment) return null;
  return segment.outputStart + (time - segment.sourceStart) / segment.speed;
}

function wordsFromSegment(segment) {
  const tokens = cleanText(segment.text).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const start = Math.max(0, finite(segment.start));
  const fallbackDuration = Math.max(0.32, tokens.length * 0.28);
  const end = Math.max(start + 0.08, finite(segment.end, start + fallbackDuration));
  const weights = tokens.map(tokenWeight);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = start;
  return tokens.map((text, index) => {
    const duration = ((end - start) * weights[index]) / totalWeight;
    const word = { text, start: cursor, end: cursor + duration };
    cursor += duration;
    return word;
  });
}

export function normalizeTimedWords({ transcriptWords = [], transcriptSegments = [] } = {}) {
  const suppliedWords = (Array.isArray(transcriptWords) ? transcriptWords : [])
    .map((word) => ({
      text: cleanText(word.text),
      start: Math.max(0, finite(word.start)),
      end: Math.max(0, finite(word.end, word.start)),
    }))
    .filter((word) => word.text && word.end >= word.start);
  if (suppliedWords.length) return suppliedWords;

  return (Array.isArray(transcriptSegments) ? transcriptSegments : [])
    .flatMap(wordsFromSegment)
    .sort((a, b) => a.start - b.start);
}

export function mapWordsToOutput(words, timeline) {
  const mapped = [];
  for (const word of Array.isArray(words) ? words : []) {
    const midpoint = (finite(word.start) + finite(word.end, word.start)) / 2;
    const segment = (Array.isArray(timeline) ? timeline : []).find(
      (candidate) => midpoint >= candidate.sourceStart && midpoint <= candidate.sourceEnd,
    );
    if (!segment) continue;
    const clippedStart = Math.max(segment.sourceStart, finite(word.start));
    const clippedEnd = Math.min(segment.sourceEnd, Math.max(clippedStart, finite(word.end, clippedStart)));
    const start = segment.outputStart + (clippedStart - segment.sourceStart) / segment.speed;
    const end = segment.outputStart + (clippedEnd - segment.sourceStart) / segment.speed;
    mapped.push({
      text: cleanText(word.text),
      start,
      end: Math.max(start + 0.06, end),
      sourceStart: finite(word.start),
      sourceEnd: finite(word.end, word.start),
    });
  }
  return mapped;
}

function punctuationBoundary(text) {
  return /[.!?;:]$/.test(cleanText(text));
}

export function groupCaptionCues(words, {
  minWords = 1,
  maxWords = 4,
  maxDuration = 1.65,
  maxGap = 0.5,
} = {}) {
  const cues = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const start = Math.max(0, current[0].start - 0.035);
    const rawEnd = current.at(-1).end + 0.08;
    cues.push({
      start,
      end: Math.max(start + 0.18, rawEnd),
      text: current.map((word) => word.text).join(" "),
      words: current,
    });
    current = [];
  };

  for (const word of Array.isArray(words) ? words : []) {
    const previous = current.at(-1);
    const gap = previous ? word.start - previous.end : 0;
    const proposedDuration = current.length ? word.end - current[0].start : 0;
    if (
      current.length
      && (
        current.length >= maxWords
        || gap > maxGap
        || proposedDuration > maxDuration
        || (current.length >= minWords && punctuationBoundary(previous.text))
      )
    ) flush();
    current.push(word);
    if (current.length >= minWords && punctuationBoundary(word.text)) flush();
  }
  flush();

  for (let index = 0; index < cues.length - 1; index += 1) {
    cues[index].end = Math.min(cues[index].end, cues[index + 1].start - 0.01);
    cues[index].end = Math.max(cues[index].start + 0.12, cues[index].end);
  }
  return cues;
}

export function createTimedCaptions({
  transcriptWords,
  transcriptSegments,
  sourceSegments,
  speed,
  maxOutputSeconds,
  wordsPerPage,
  templateMode,
} = {}) {
  const timeline = buildOutputTimeline(sourceSegments, speed, maxOutputSeconds);
  const words = normalizeTimedWords({ transcriptWords, transcriptSegments });
  const outputWords = mapWordsToOutput(words, timeline);
  const kinetic = ["pulse-tech", "manifesto-kinetic"].includes(templateMode);
  const minWords = Math.max(1, finite(wordsPerPage?.[0], kinetic ? 1 : 3));
  const maxWords = Math.max(minWords, finite(wordsPerPage?.[1], kinetic ? 3 : 4));
  const cues = groupCaptionCues(outputWords, {
    minWords,
    maxWords,
    maxDuration: kinetic ? 1.15 : 1.65,
    maxGap: 0.48,
  });
  const transcriptEnd = words.reduce((max, word) => Math.max(max, word.end), 0);
  const requiredSourceEnd = timeline.reduce((max, segment) => Math.max(max, segment.sourceEnd), 0);
  const coverageRatio = requiredSourceEnd > 0
    ? Math.min(1, transcriptEnd / requiredSourceEnd)
    : 0;
  return {
    timeline,
    words,
    outputWords,
    cues,
    audit: {
      syncMode: transcriptWords?.length ? "word-timestamps" : "segment-timestamps",
      captionCueCount: cues.length,
      timedWordCount: outputWords.length,
      transcriptEnd,
      requiredSourceEnd,
      coverageRatio,
    },
  };
}

