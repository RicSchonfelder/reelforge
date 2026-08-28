import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_POSTING_SLOTS,
  normalizePostingSlots,
  recommendPostingSlots,
  getNextAutoScheduleSlot,
} from "../src/auto-schedule.mjs";

test("normalizePostingSlots valida, deduplica e ordena", () => {
  const slots = normalizePostingSlots(["21:00", "08:00", "08:00", "99:99", "12:30"], 4);
  assert.deepEqual(slots, ["08:00", "12:30", "21:00"]);
});

test("normalizePostingSlots cai no padrão com entrada vazia", () => {
  assert.deepEqual(normalizePostingSlots([], 4), DEFAULT_POSTING_SLOTS.slice(0, 4));
});

test("recommendPostingSlots prioriza horas com engajamento", () => {
  const media = [];
  for (let i = 0; i < 5; i += 1) {
    media.push({ timestamp: `2026-08-01T18:30:00-03:00`, like_count: 500, comments_count: 50 });
    media.push({ timestamp: `2026-08-01T04:30:00-03:00`, like_count: 5, comments_count: 0 });
  }
  const slots = recommendPostingSlots(media, { dailyLimit: 4 });
  assert.ok(Array.isArray(slots) && slots.length >= 1 && slots.length <= 4);
  assert.ok(slots.includes("18:00") || slots.includes("19:00"));
});

test("getNextAutoScheduleSlot respeita lead mínimo e limite diário", () => {
  const now = new Date("2026-08-20T07:00:00-03:00");
  const slots = ["08:00", "12:30", "18:30", "21:00"];
  const first = getNextAutoScheduleSlot({ jobs: [], now, slots, dailyLimit: 1, timeZone: "America/Sao_Paulo" });
  assert.equal(first.localTime, "08:00");

  // Dia lotado (limite diário 1, job já naquele dia) → pula para o dia seguinte.
  const busy = getNextAutoScheduleSlot({
    jobs: [{ id: "a", status: "queued", publishAt: "2026-08-20T11:00:00Z" }],
    now,
    slots,
    dailyLimit: 1,
    timeZone: "America/Sao_Paulo",
  });
  assert.equal(busy.localDate, "2026-08-21");
  assert.equal(busy.localTime, "08:00");
});

test("getNextAutoScheduleSlot conta needs_review no limite diário", () => {
  const now = new Date("2026-08-20T07:00:00-03:00");
  const result = getNextAutoScheduleSlot({
    jobs: [{ id: "a", status: "needs_review", publishAt: "2026-08-20T11:00:00Z" }],
    now,
    slots: ["08:00", "12:30"],
    dailyLimit: 1,
    timeZone: "America/Sao_Paulo",
  });
  assert.equal(result.localDate, "2026-08-21");
});
