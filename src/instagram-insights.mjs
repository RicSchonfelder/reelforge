import fs from "node:fs";
import path from "node:path";
import { appRoot, dataRoot, getConfig } from "./env.mjs";
import { recommendPostingSlots } from "./auto-schedule.mjs";

const cachePath = path.join(dataRoot, "metrics-cache.json");
const CACHE_TTL_MS = 10 * 60_000;
const COMMON_METRICS = [
  "reach",
  "shares",
  "saved",
  "total_interactions",
];
// "views" não existe para IMAGE/CAROUSEL em várias versões: pedimos apenas
// para vídeos, onde também entram as métricas de retenção.
const VIDEO_METRICS = [
  ...COMMON_METRICS,
  "views",
];
const REEL_METRICS = [
  ...VIDEO_METRICS,
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
];
const BRAZIL_TIME_ZONE = "America/Sao_Paulo";

const TOPIC_GROUPS = [
  {
    label: "IA e automação",
    pattern: /\b(ia|intelig[eê]ncia artificial|agente|automa[cç][aã]o|chatgpt)\b/i,
  },
  {
    label: "vendas e funil",
    pattern: /\b(venda|vender|funil|an[uú]ncio|cliente|crm|faturamento|produto)\b/i,
  },
  {
    label: "bastidores e jornada",
    pattern: /\b(bastidor|jornada|s[eé]rie|processo|teste|epis[oó]dio|construindo)\b/i,
  },
  {
    label: "história pessoal",
    pattern: /\b(fam[ií]lia|amor|casamento|filho|esposa|gratid[aã]o|minha hist[oó]ria)\b/i,
  },
  {
    label: "empreendedorismo",
    pattern: /\b(empreendedor|neg[oó]cio|empresa|crescer|escalar|resultado)\b/i,
  },
  {
    label: "fé e propósito",
    pattern: /\b(deus|f[eé]|prop[oó]sito|b[eê]n[cç][aã]o|ora[cç][aã]o)\b/i,
  },
];

function readCache() {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS) {
      return cache;
    }
  } catch {
    // Cache opcional.
  }
  return null;
}

function writeCache(value) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function request(pathname, token) {
  const config = getConfig({ requireCredentials: true });
  const fetchOnce = async () =>
    fetch(`https://graph.instagram.com/${config.apiVersion}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  let response = await fetchOnce();
  // Rate limit da Meta (HTTP 429 ou error code 4/#80004): espera e tenta uma vez.
  let payload = await response.json().catch(() => ({}));
  const rateLimited =
    response.status === 429 ||
    payload?.error?.code === 4 ||
    payload?.error?.code === "#80004";
  if (rateLimited) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    response = await fetchOnce();
    payload = await response.json().catch(() => ({}));
  }
  if (!response.ok) {
    throw new Error(
      payload?.error?.error_user_msg ||
        payload?.error?.message ||
        `Instagram respondeu ${response.status}.`,
    );
  }
  return payload;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMetricPayload(payload) {
  return Object.fromEntries(
    (payload?.data || []).map((metric) => [
      metric.name,
      number(metric.values?.[0]?.value ?? metric.total_value?.value),
    ]),
  );
}

async function fetchMediaMetrics(item, token) {
  const metricNames = item.media_type === "VIDEO" ? REEL_METRICS : COMMON_METRICS;
  try {
    const payload = await request(
      `/${item.id}/insights?metric=${metricNames.join(",")}`,
      token,
    );
    return { insights: parseMetricPayload(payload), insightsError: null };
  } catch (metricError) {
    if (item.media_type !== "VIDEO") {
      return { insights: {}, insightsError: metricError.message };
    }
    try {
      const fallback = await request(
        `/${item.id}/insights?metric=${COMMON_METRICS.join(",")}`,
        token,
      );
      return {
        insights: parseMetricPayload(fallback),
        insightsError: "As métricas avançadas de retenção não estão disponíveis para este vídeo.",
      };
    } catch (fallbackError) {
      return { insights: {}, insightsError: fallbackError.message };
    }
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return output;
}

function localHour(timestamp) {
  const value = new Intl.DateTimeFormat("pt-BR", {
    timeZone: BRAZIL_TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestamp)).find((part) => part.type === "hour")?.value;
  return Number(value || 0) % 24;
}

function normalizedRank(values, current) {
  const available = values.filter((value) => value > 0);
  if (!available.length || current <= 0) return 0;
  return Math.round(
    (available.filter((value) => value <= current).length / available.length) * 100,
  );
}

function addPerformanceScores(items) {
  const metricWeights = [
    ["views", 24],
    ["reach", 18],
    ["shares", 20],
    ["saves", 16],
    ["comments", 12],
    ["averageWatchTimeMs", 6],
    ["likes", 4],
  ];
  const valuesByMetric = Object.fromEntries(
    metricWeights.map(([metric]) => [metric, items.map((item) => item[metric])]),
  );
  return items.map((item) => {
    let weightedScore = 0;
    let activeWeight = 0;
    for (const [metric, weight] of metricWeights) {
      if (!valuesByMetric[metric].some((value) => value > 0)) continue;
      weightedScore += normalizedRank(valuesByMetric[metric], item[metric]) * weight;
      activeWeight += weight;
    }
    return {
      ...item,
      performanceScore: activeWeight
        ? Math.round(weightedScore / activeWeight)
        : 0,
    };
  });
}

function extractHook(caption = "") {
  const clean = String(caption)
    .replace(/\s+/g, " ")
    .trim();
  const sentence = clean.split(/[.!?\n]/)[0];
  return sentence.length > 92 ? `${sentence.slice(0, 89).trim()}…` : sentence;
}

function classifyHook(caption = "") {
  const hook = extractHook(caption);
  if (/\b(r\$\s?[\d.,]+|\d+[%x]|\d[\d.,]*\s*(mil|milh[aã]o|dias?|anos?))\b/i.test(hook)) {
    return "número ou resultado concreto";
  }
  if (/\b(n[aã]o|erro|ningu[eé]m|pare de|verdade|maluco|segredo)\b/i.test(hook)) {
    return "contraste ou provocação";
  }
  if (String(caption).slice(0, 140).includes("?") || /^(como|por que|o que|qual|voc[eê])\b/i.test(hook)) {
    return "pergunta direta";
  }
  if (/\b(eu|minha|meu|anos ao seu lado|primeira vez|aconteceu comigo)\b/i.test(hook)) {
    return "história em primeira pessoa";
  }
  return "promessa direta";
}

function inferTopics(items) {
  const scores = TOPIC_GROUPS.map((topic) => ({
    label: topic.label,
    score: items.reduce(
      (sum, item) => sum + (topic.pattern.test(item.caption || "") ? Math.max(item.performanceScore, 1) : 0),
      0,
    ),
  }))
    .filter((topic) => topic.score > 0)
    .sort((a, b) => b.score - a.score);
  return scores.slice(0, 3).map((topic) => topic.label);
}

function average(values) {
  const available = values.filter((value) => Number.isFinite(value) && value > 0);
  return available.length
    ? available.reduce((sum, value) => sum + value, 0) / available.length
    : 0;
}

export function buildPerformanceAgent(media = []) {
  const videos = media
    .filter((item) => item.media_type === "VIDEO")
    .sort((a, b) => b.performanceScore - a.performanceScore);
  const maturityCutoff = Date.now() - 24 * 60 * 60_000;
  const matureVideos = videos.filter(
    (item) => new Date(item.timestamp).getTime() <= maturityCutoff,
  );
  const sample = matureVideos.length >= 6
    ? matureVideos
    : videos.length
      ? videos
      : [...media].sort((a, b) => b.performanceScore - a.performanceScore);
  const analyzedWithInsights = sample.filter((item) => item.views > 0 || item.reach > 0);
  const strongest = sample[0] || null;
  const hookGroups = new Map();
  for (const item of sample.slice(0, 12)) {
    const label = classifyHook(item.caption);
    const current = hookGroups.get(label) || { total: 0, count: 0, examples: [] };
    current.total += item.performanceScore;
    current.count += 1;
    if (current.examples.length < 2) current.examples.push(extractHook(item.caption));
    hookGroups.set(label, current);
  }
  const winningHookEntry = [...hookGroups.entries()]
    .map(([label, value]) => ({
      label,
      averageScore: Math.round(value.total / value.count),
      example: value.examples.find(Boolean) || "",
      posts: value.count,
      confidenceScore:
        (value.total / value.count) * 0.75 +
        (Math.min(value.count, 4) / 4) * 25,
    }))
    .sort((a, b) => b.confidenceScore - a.confidenceScore)[0] || null;
  const topics = inferTopics(sample.slice(0, 12));
  const totalReach = sample.reduce((sum, item) => sum + item.reach, 0);
  const totalShares = sample.reduce((sum, item) => sum + item.shares, 0);
  const totalSaves = sample.reduce((sum, item) => sum + item.saves, 0);
  const totalComments = sample.reduce((sum, item) => sum + item.comments, 0);
  const shareRate = totalReach ? (totalShares / totalReach) * 100 : 0;
  const saveRate = totalReach ? (totalSaves / totalReach) * 100 : 0;
  const commentRate = totalReach ? (totalComments / totalReach) * 100 : 0;
  const averageSkipRate = average(sample.map((item) => item.skipRate));
  const averageWatchTimeMs = average(sample.map((item) => item.averageWatchTimeMs));
  const distributionGoal = totalShares >= totalSaves
    ? "Crie uma frase ou descoberta que a pessoa queira enviar para alguém."
    : "Estruture o conteúdo como uma referência prática que mereça ser salva.";
  const hookExample = winningHookEntry?.example
    ? `Use a mesma lógica de “${winningHookEntry.example}”, adaptada ao novo assunto.`
    : "Comece pelo resultado ou pela tensão principal, sem apresentação.";
  const retentionInstruction = averageSkipRate
    ? `A taxa média de abandono nos 3 primeiros segundos está em ${averageSkipRate.toFixed(1).replace(".", ",")}%. Mostre o resultado na tela antes de explicar o contexto.`
    : "Mostre o resultado ou a transformação logo nos 3 primeiros segundos.";

  return {
    confidence: analyzedWithInsights.length >= 12
      ? "alta"
      : analyzedWithInsights.length >= 5
        ? "média"
        : "inicial",
    sampleSize: sample.length,
    postsWithAdvancedInsights: analyzedWithInsights.length,
    headline: winningHookEntry
      ? `O melhor sinal recente vem de ${winningHookEntry.label}${topics[0] ? ` em conteúdos sobre ${topics[0]}` : ""}.`
      : "O agente ainda está formando uma linha de base.",
    winningHook: winningHookEntry,
    winningTopics: topics,
    benchmarks: {
      shareRate: Number(shareRate.toFixed(2)),
      saveRate: Number(saveRate.toFixed(2)),
      commentRate: Number(commentRate.toFixed(2)),
      averageSkipRate: Number(averageSkipRate.toFixed(1)),
      averageWatchTimeMs: Math.round(averageWatchTimeMs),
    },
    strongestPost: strongest
      ? {
          id: strongest.id,
          caption: strongest.caption,
          permalink: strongest.permalink,
          performanceScore: strongest.performanceScore,
          views: strongest.views,
          reach: strongest.reach,
        }
      : null,
    nextRecordingBrief: [
      {
        title: "Gancho em até 3 segundos",
        instruction: hookExample,
      },
      {
        title: "Prova antes da explicação",
        instruction: retentionInstruction,
      },
      {
        title: "Ideia com distribuição",
        instruction: distributionGoal,
      },
      {
        title: "Fechamento específico",
        instruction: commentRate > 0.5
          ? "Termine com uma pergunta simples e específica para repetir o sinal de comentários."
          : "Peça uma resposta binária ou uma palavra-chave; evite o genérico “o que achou?”.",
      },
    ],
  };
}

export function summarizeMedia(media = []) {
  const normalized = addPerformanceScores(media.map((item) => {
    const insights = item.insights || {};
    const likes = number(item.like_count);
    const comments = number(item.comments_count);
    const shares = number(insights.shares);
    const saves = number(insights.saved);
    const totalInteractions = Math.max(
      number(insights.total_interactions),
      likes + comments + shares + saves,
    );
    const reach = number(insights.reach);
    return {
      ...item,
      likes,
      comments,
      shares,
      saves,
      views: number(insights.views),
      reach,
      totalInteractions,
      engagement: totalInteractions,
      interactionRate: reach ? Number(((totalInteractions / reach) * 100).toFixed(2)) : 0,
      shareRate: reach ? Number(((shares / reach) * 100).toFixed(2)) : 0,
      saveRate: reach ? Number(((saves / reach) * 100).toFixed(2)) : 0,
      averageWatchTimeMs: number(insights.ig_reels_avg_watch_time),
      totalWatchTimeMs: number(insights.ig_reels_video_view_total_time),
      skipRate: number(insights.reels_skip_rate),
    };
  }));
  const totals = normalized.reduce(
    (acc, item) => ({
      likes: acc.likes + item.likes,
      comments: acc.comments + item.comments,
      shares: acc.shares + item.shares,
      saves: acc.saves + item.saves,
      views: acc.views + item.views,
      reach: acc.reach + item.reach,
      engagement: acc.engagement + item.engagement,
    }),
    { likes: 0, comments: 0, shares: 0, saves: 0, views: 0, reach: 0, engagement: 0 },
  );
  const topPosts = [...normalized]
    .sort((a, b) => b.performanceScore - a.performanceScore || b.engagement - a.engagement)
    .slice(0, 8);
  const recentPosts = [...normalized]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12);
  const byHour = new Map();
  for (const item of normalized) {
    const hour = localHour(item.timestamp);
    const current = byHour.get(hour) || { signal: 0, posts: 0 };
    current.signal += item.performanceScore || item.engagement;
    current.posts += 1;
    byHour.set(hour, current);
  }
  const bestHourEntry = [...byHour.entries()]
    .map(([hour, value]) => ({
      hour,
      average: value.posts ? value.signal / value.posts : 0,
      posts: value.posts,
    }))
    .filter((entry) => entry.posts >= 2 || normalized.length < 6)
    .sort((a, b) => b.average - a.average)[0];
  return {
    totals,
    averageEngagement: normalized.length
      ? Math.round(totals.engagement / normalized.length)
      : 0,
    bestHour: bestHourEntry ? `${String(bestHourEntry.hour).padStart(2, "0")}:00` : null,
    recommendedSlots: recommendPostingSlots(normalized),
    topPosts,
    recentPosts,
    agent: buildPerformanceAgent(normalized),
  };
}

export async function getInstagramInsights({ force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached?.summary?.agent) return { ...cached, cached: true };
  }

  const config = getConfig({ requireCredentials: true });
  const profile = await request(
    `/${config.igUserId}?fields=id,username,account_type,profile_picture_url,followers_count,media_count`,
    config.accessToken,
  );
  const mediaPayload = await request(
    `/${config.igUserId}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url&limit=30`,
    config.accessToken,
  );
  const media = await mapWithConcurrency(
    mediaPayload.data || [],
    5,
    async (item) => ({ ...item, ...(await fetchMediaMetrics(item, config.accessToken)) }),
  );
  const summary = summarizeMedia(media);
  const result = {
    fetchedAt: new Date().toISOString(),
    profile,
    media,
    summary,
    cached: false,
  };
  writeCache(result);
  return result;
}
