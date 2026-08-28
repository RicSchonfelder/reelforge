export const DEFAULT_POSTING_SLOTS = ["08:00", "12:30", "18:30", "21:00"];

// needs_review também ocupa o dia: ao voltar para a fila o limite diário
// continua respeitado (evita overshoot após reenfileiramento).
const activeJobStatuses = new Set([
  "queued",
  "uploading",
  "processing",
  "publishing",
  "published",
  "needs_review",
]);

// Intl.DateTimeFormat é caro; cache por fuso (getNextAutoScheduleSlot chama
// zonedParts O(dias × jobs)).
const formatterCache = new Map();

function formatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  return formatterCache.get(timeZone);
}

function zonedParts(value, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(value));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function localDateKey(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function timeZoneOffsetMs(value, timeZone) {
  const date = new Date(value);
  const parts = zonedParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - date.getTime();
}

function localDateTimeToInstant(local, timeZone) {
  const localAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    0,
  );
  let instant = localAsUtc - timeZoneOffsetMs(localAsUtc, timeZone);
  instant = localAsUtc - timeZoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

function addLocalDays(local, days) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function slotMinutes(slot) {
  const [hour, minute] = slot.split(":").map(Number);
  return hour * 60 + minute;
}

export function normalizePostingSlots(slots = DEFAULT_POSTING_SLOTS, dailyLimit = 4) {
  const normalized = [...new Set(
    slots
      .map((slot) => String(slot).trim())
      .filter((slot) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(slot)),
  )]
    .sort((a, b) => slotMinutes(a) - slotMinutes(b))
    .slice(0, Math.max(1, dailyLimit));
  return normalized.length ? normalized : DEFAULT_POSTING_SLOTS.slice(0, dailyLimit);
}

export function recommendPostingSlots(
  media = [],
  {
    timeZone = "America/Sao_Paulo",
    defaultSlots = DEFAULT_POSTING_SLOTS,
    dailyLimit = 4,
  } = {},
) {
  const samples = media
    .filter((item) => item?.timestamp && !Number.isNaN(new Date(item.timestamp).getTime()))
    .map((item) => ({
      hour: zonedParts(item.timestamp, timeZone).hour,
      engagement: Number(item.like_count || 0) + Number(item.comments_count || 0),
    }));
  if (samples.length < 4) return normalizePostingSlots(defaultSlots, dailyLimit);

  const baseline = samples.reduce((sum, item) => sum + item.engagement, 0) / samples.length;
  const byHour = new Map();
  for (const sample of samples) {
    const current = byHour.get(sample.hour) || { engagement: 0, posts: 0 };
    current.engagement += sample.engagement;
    current.posts += 1;
    byHour.set(sample.hour, current);
  }

  const ranked = [...byHour.entries()]
    .map(([hour, value]) => ({
      hour,
      posts: value.posts,
      score: (value.engagement + baseline * 2) / (value.posts + 2),
    }))
    .sort((a, b) => b.score - a.score || b.posts - a.posts || a.hour - b.hour);

  const selectedMinutes = [];
  for (const entry of ranked) {
    const minutes = entry.hour * 60;
    if (selectedMinutes.every((candidate) => Math.abs(candidate - minutes) >= 120)) {
      selectedMinutes.push(minutes);
    }
    if (selectedMinutes.length >= dailyLimit) break;
  }
  for (const fallback of normalizePostingSlots(defaultSlots, dailyLimit)) {
    const minutes = slotMinutes(fallback);
    if (selectedMinutes.every((candidate) => Math.abs(candidate - minutes) >= 90)) {
      selectedMinutes.push(minutes);
    }
    if (selectedMinutes.length >= dailyLimit) break;
  }

  return selectedMinutes
    .slice(0, dailyLimit)
    .sort((a, b) => a - b)
    .map((minutes) =>
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`,
    );
}

export function getNextAutoScheduleSlot({
  jobs = [],
  now = new Date(),
  slots = DEFAULT_POSTING_SLOTS,
  dailyLimit = 4,
  timeZone = "America/Sao_Paulo",
  minimumLeadMinutes = 15,
} = {}) {
  const normalizedSlots = normalizePostingSlots(slots, dailyLimit);
  const current = new Date(now);
  const threshold = new Date(current.getTime() + minimumLeadMinutes * 60_000);
  const today = zonedParts(current, timeZone);
  const activeJobs = jobs.filter((job) =>
    activeJobStatuses.has(job.status) &&
    job.publishAt &&
    !Number.isNaN(new Date(job.publishAt).getTime()),
  );

  for (let dayOffset = 0; dayOffset < 120; dayOffset += 1) {
    const date = addLocalDays(today, dayOffset);
    const dateKey = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
    const jobsOnDay = activeJobs.filter(
      (job) => localDateKey(job.publishAt, timeZone) === dateKey,
    );
    if (jobsOnDay.length >= dailyLimit) continue;

    for (const slot of normalizedSlots) {
      const [hour, minute] = slot.split(":").map(Number);
      const candidate = localDateTimeToInstant({ ...date, hour, minute }, timeZone);
      if (candidate <= threshold) continue;
      const occupied = jobsOnDay.some(
        (job) => Math.abs(new Date(job.publishAt).getTime() - candidate.getTime()) < 10 * 60_000,
      );
      if (!occupied) {
        return {
          publishAt: candidate.toISOString(),
          localDate: dateKey,
          localTime: slot,
          timeZone,
        };
      }
    }
  }

  throw new Error("Não foi possível encontrar um horário automático nos próximos 120 dias.");
}

