import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOutputTimeline,
  mapWordsToOutput,
  groupCaptionCues,
  createTimedCaptions,
} from "../src/timed-captions.mjs";

const SEGMENTS = [
  { start: 0, end: 2 },
  { start: 3, end: 5 },
];

test("buildOutputTimeline aplica velocidade e teto", () => {
  const timeline = buildOutputTimeline(SEGMENTS, 2, 10);
  // Segmento 1: fonte 0–2 @2x → saída 0–1; segmento 2: fonte 3–5 → saída 1–2.
  assert.equal(timeline[0].outputEnd, 1);
  assert.equal(timeline[1].outputStart, 1);
  assert.ok(timeline.every((entry) => entry.outputEnd >= entry.outputStart));

  const capped = buildOutputTimeline([{ start: 0, end: 20 }], 1, 5);
  assert.ok(capped.length >= 1);
  assert.ok(capped[capped.length - 1].outputEnd <= 5.0001);
});

test("mapWordsToOutput descarta palavras cortadas", () => {
  const words = [
    { text: "antes", start: 0.5, end: 1 },
    { text: "cortada", start: 2.2, end: 2.8 },
    { text: "depois", start: 4, end: 4.8 },
  ];
  const timeline = buildOutputTimeline(SEGMENTS, 1, Infinity);
  const output = mapWordsToOutput(words, timeline);
  const texts = output.map((word) => word.text);
  assert.deepEqual(texts, ["antes", "depois"]);
});

test("groupCaptionCues respeita limite de palavras", () => {
  const words = Array.from({ length: 10 }, (_, index) => ({
    text: `palavra${index}`,
    start: index * 0.2,
    end: index * 0.2 + 0.18,
  }));
  const cues = groupCaptionCues(words, { maxWords: 3 });
  assert.ok(cues.length >= 4);
  for (const cue of cues) {
    assert.ok(cue.words.length <= 3);
    assert.ok(cue.end >= cue.start);
  }
});

test("createTimedCaptions calcula cobertura", () => {
  const result = createTimedCaptions({
    transcriptWords: [
      { text: "olá", start: 0.1, end: 0.5 },
      { text: "mundo", start: 3.2, end: 4.5 },
    ],
    transcriptSegments: [],
    sourceSegments: SEGMENTS,
    speed: 1,
    maxOutputSeconds: 90,
  });
  assert.ok(result.cues.length >= 1);
  // Última palavra termina em 4,5; trecho final mantido vai até 5.
  assert.equal(Math.round(result.audit.coverageRatio * 100) / 100, 0.9);
});
