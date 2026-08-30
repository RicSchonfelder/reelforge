import assert from "node:assert/strict";
import { test } from "node:test";
import { planEditorialMoments, zoomPanExpression, assessEditorialPlan } from "../src/editorial-plan.mjs";

const CUES = [
  { start: 1.2, end: 2, text: "no dia 200 mil reais de faturamento" },
  { start: 6, end: 7, text: "quer saber como comentar" },
  { start: 12, end: 13.4, text: "a automação de conteúdo" },
  { start: 18, end: 19.6, text: "aumenta o roas" },
  { start: 24, end: 25.2, text: "segmentação correta" },
  { start: 30, end: 31, text: "finaliza o funil" },
  { start: 36, end: 37, text: "com vendas em escala" },
];

test("planEditorialMoments gera zooms, gráficos e sfx", () => {
  const plan = planEditorialMoments({ cues: CUES, duration: 40, templateMode: "fluxo-padrao" });
  assert.ok(plan.zooms.length >= 2 && plan.zooms.length <= 7);
  assert.ok(plan.graphics.length >= 2 && plan.graphics.length <= 5);
  assert.ok(plan.sfx.length >= 1);
  for (const graphic of plan.graphics) {
    assert.ok(graphic.end > graphic.start);
    assert.ok(graphic.end <= 40 - 0.2);
  }
  const assessment = assessEditorialPlan(plan, { duration: 40, templateMode: "fluxo-padrao" });
  assert.equal(assessment.ok, true);
});

test("planEditorialMoments degrada para plano vazio fora dos modos dinâmicos", () => {
  const plan = planEditorialMoments({ cues: CUES, duration: 40, templateMode: "natural" });
  assert.equal(plan.zooms.length, 0);
  assert.equal(plan.graphics.length, 0);
});

test("assessEditorialPlan escala os mínimos com vídeos curtos", () => {
  // Um Reel de 10s com 1 zoom e 1 gráfico é aceitável (não exige densidade de 60s).
  const short = assessEditorialPlan(
    { zooms: [{}], graphics: [{}], sfx: [{}], flashes: [] },
    { duration: 10, templateMode: "fluxo-padrao" },
  );
  assert.equal(short.ok, true);
  // Aos 40s os mínimos originais continuam valendo.
  const full = assessEditorialPlan(
    { zooms: [{}], graphics: [{}], sfx: [{}], flashes: [] },
    { duration: 40, templateMode: "fluxo-padrao" },
  );
  assert.equal(full.ok, false);
});

test("zoomPanExpression sanitiza entrada hostil", () => {
  const expression = zoomPanExpression([
    { start: "x'; cat /etc/passwd", end: NaN, magnification: "<script>" },
  ]);
  assert.ok(!expression.includes("cat"));
  assert.ok(!expression.includes("<script>"));
  assert.ok(!expression.includes("NaN"));
  assert.ok(expression.includes("if(between(on,0,"));
});
