import assert from "node:assert/strict";
import { test } from "node:test";
import {
  transcriptTokenKey,
  applyDomainCorrections,
  transcriptFromWords,
  segmentsFromWords,
  assessTranscriptQuality,
  alignEditedTranscript,
} from "../src/transcript-quality.mjs";

test("transcriptTokenKey remove acentos e pontuação", () => {
  assert.equal(transcriptTokenKey("SaaS!"), "saas");
  assert.equal(transcriptTokenKey("é-pico"), "epico");
});

test("applyDomainCorrections corrige termos de domínio", () => {
  const words = [
    { text: "usando", start: 0, end: 0.5 },
    { text: "saas", start: 0.5, end: 1 },
    { text: "hoje", start: 1, end: 1.5 },
  ];
  const { words: corrected, corrections } = applyDomainCorrections(words);
  assert.equal(corrected[1].text, "SaaS");
  assert.equal(corrected[1].start, 0.5);
  assert.ok(corrections.length === 1);
});

test("transcriptFromWords normaliza pontuação", () => {
  assert.equal(transcriptFromWords([
    { text: "olá" },
    { text: "mundo," },
    { text: "bom" },
  ]), "olá mundo, bom");
});

test("segmentsFromWords quebra por gap", () => {
  const segments = segmentsFromWords([
    { text: "a", start: 0, end: 0.3 },
    { text: "b", start: 0.4, end: 0.6 },
    { text: "c", start: 3, end: 3.3 },
  ]);
  assert.equal(segments.length, 2);
});

test("assessTranscriptQuality retorna score e issues", () => {
  const words = Array.from({ length: 30 }, (_, index) => ({
    text: `palavra${index}`,
    start: index * 0.3,
    end: index * 0.3 + 0.28,
  }));
  const assessment = assessTranscriptQuality({
    words,
    transcript: transcriptFromWords(words),
    modelId: "Xenova/whisper-base",
    audioDuration: 10,
  });
  assert.ok(assessment.score >= 0 && assessment.score <= 100);
  assert.ok(Array.isArray(assessment.issues));
});

test("alignEditedTranscript ancora palavras e interpola inserções", () => {
  const original = [
    { text: "olá", start: 0.2, end: 0.6 },
    { text: "mundo", start: 1, end: 1.6 },
  ];
  const aligned = alignEditedTranscript(original, "olá, grande mundo");
  assert.ok(aligned.length === 3);
  // Palavras âncora preservam o timestamp da transcrição original.
  assert.equal(aligned[0].start, 0.2);
  assert.equal(aligned[2].start, 1);
  // Inserção interpolada entre âncoras.
  assert.ok(aligned[1].start > 0.2 && aligned[1].start < 1);
});
