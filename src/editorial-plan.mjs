function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function key(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s$%]/gu, "")
    .toLowerCase();
}

function semanticScore(cue) {
  const text = key(cue.text);
  let score = Math.min(24, text.length / 2);
  if (/\d|r\$|%/.test(text)) score += 35;
  if (/\b(resultado|venda|vendas|lucro|roas|lead|leads|dashboard|meta|escala|campanha|automacao|sistema|grupo)\b/.test(text)) score += 22;
  if (/\b(comenta|segue|link|grupo)\b/.test(text)) score += 28;
  if (/\b(tipo|entao|agora|aqui|assim|cara)\b/.test(text)) score -= 8;
  return score;
}

function selectDistributed(candidates, count, minGap, duration) {
  const selected = [];
  const targets = Array.from({ length: count }, (_, index) =>
    duration * ((index + 1) / (count + 1)),
  );
  for (const target of targets) {
    const choice = candidates
      .filter((cue) => selected.every((item) => Math.abs(item.start - cue.start) >= minGap))
      .toSorted((a, b) =>
        (semanticScore(b) - Math.abs(b.start - target) * 1.4)
        - (semanticScore(a) - Math.abs(a.start - target) * 1.4),
      )[0];
    if (choice) selected.push(choice);
  }
  return selected.toSorted((a, b) => a.start - b.start);
}

function graphicText(cue) {
  const words = String(cue.text || "").split(/\s+/).filter(Boolean);
  const important = words.filter((word) => {
    const normalized = key(word);
    return /\d|r\$|%/.test(normalized)
      || normalized.length >= 5
      || ["meta", "roas", "leads", "lucro", "vendas"].includes(normalized);
  });
  return (important.length ? important : words)
    .slice(0, 5)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function planEditorialMoments({ cues = [], duration = 0, templateMode = "fluxo-padrao" } = {}) {
  const safeDuration = Math.max(0, Number(duration) || 0);
  const safeCues = (Array.isArray(cues) ? cues : [])
    .filter((cue) => Number.isFinite(Number(cue.start)) && cue.start < safeDuration - 0.2);
  const dynamic = ["fluxo-padrao", "pulse-tech", "manifesto-kinetic"].includes(templateMode);
  if (!dynamic || safeCues.length < 3 || safeDuration < 4) {
    return { zooms: [], graphics: [], sfx: [], flashes: [], metrics: { zoomsPerMinute: 0, graphicsPerMinute: 0, sfxPerMinute: 0, flashesPerMinute: 0 } };
  }
  const zoomCount = clamp(Math.round(safeDuration / 14), 2, 7);
  const graphicCount = clamp(Math.round(safeDuration / 22), 2, 5);
  const zoomCues = selectDistributed(safeCues, zoomCount, 5.2, safeDuration);
  const graphicCandidates = safeCues
    .filter((cue) => cue.start > 2 && cue.start < safeDuration - 2)
    .toSorted((a, b) => semanticScore(b) - semanticScore(a));
  const graphics = selectDistributed(graphicCandidates, graphicCount, 8, safeDuration)
    .map((cue, index) => {
      const normalized = key(cue.text);
      const type = /\b(comenta|segue|link|grupo)\b/.test(normalized)
        ? "cta"
        : /\d|r\$|%|roas/.test(normalized)
          ? "metric"
          : "concept";
      return {
        start: Math.max(0.4, cue.start - 0.12),
        end: Math.min(safeDuration - 0.2, cue.start + (type === "cta" ? 2.2 : 1.55)),
        text: graphicText(cue),
        type,
        slot: index % 2 === 0 ? "top" : "upper-middle",
      };
    })
    .filter((item) => item.text && item.end - item.start >= 0.5);
  const zooms = zoomCues.map((cue, index) => ({
    start: Math.max(0.2, cue.start - 0.08),
    end: Math.min(safeDuration - 0.1, cue.start + (index % 3 === 0 ? 1.7 : 1.15)),
    magnification: index % 3 === 0 ? 1.08 : 1.12,
    shape: index % 3 === 0 ? "slow-push" : "punch",
    focalPointX: 0.5,
    focalPointY: 0.42,
  }));
  const sfx = graphics
    .slice(0, Math.max(2, Math.round(safeDuration / 24)))
    .map((graphic, index) => ({
      at: graphic.start,
      type: graphic.type === "cta" ? "impact" : index % 2 ? "tick" : "whoosh",
      gain: graphic.type === "cta" ? 0.2 : 0.13,
    }));
  const flashes = graphics
    .filter((graphic, index) => graphic.type === "cta" || index % 2 === 0)
    .slice(0, Math.max(1, Math.round(safeDuration / 35)))
    .map((graphic) => ({
      at: graphic.start,
      strength: graphic.type === "cta" ? 0.32 : 0.2,
      duration: graphic.type === "cta" ? 0.1 : 0.07,
    }));
  const minutes = Math.max(1 / 60, safeDuration / 60);
  return {
    zooms,
    graphics,
    sfx,
    flashes,
    metrics: {
      zoomsPerMinute: zooms.length / minutes,
      graphicsPerMinute: graphics.length / minutes,
      sfxPerMinute: sfx.length / minutes,
      flashesPerMinute: flashes.length / minutes,
    },
  };
}

export function zoomPanExpression(zooms = [], fps = 30) {
  let expression = "1";
  const safeFps = Math.max(1, Math.round(Number(fps) || 30));
  const frame = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(Math.max(0, number)) : Math.round(fallback);
  };
  for (const zoom of [...(Array.isArray(zooms) ? zooms : [])].reverse()) {
    // start/end chegam em SEGUNDOS; `on` do zoompan é ÍNDICE DE FRAME.
    // Sem a conversão, todos os pulsos colapsam nos primeiros frames.
    const start = frame(zoom?.start * safeFps, 0);
    const end = Math.max(start + 1, frame((zoom?.end ?? zoom?.start) * safeFps, start + safeFps));
    const magnification = Number(zoom?.magnification) || 1.1;
    const delta = clamp(magnification - 1, 0.02, 0.22).toFixed(4);
    const progress = `(on-${start})/${Math.max(1, end - start)}`;
    const pulse = `1+${delta}*(0.5-0.5*cos(2*PI*${progress}))`;
    expression = `if(between(on,${start},${end}),${pulse},${expression})`;
  }
  return expression;
}

export function assessEditorialPlan(plan, { duration = 0, templateMode = "fluxo-padrao" } = {}) {
  const dynamic = ["fluxo-padrao", "pulse-tech", "manifesto-kinetic"].includes(templateMode);
  if (!dynamic || Number(duration) < 4) return { ok: true, issues: [], mode: "light" };
  // Plano vazio (fala curta, <3 cues) é decisão do gerador, não falha —
  // exigir densidade num plano vazio travava o render final.
  if (!(plan?.zooms || []).length && !(plan?.graphics || []).length && !(plan?.sfx || []).length) {
    return { ok: true, issues: [], mode: "light" };
  }
  const issues = [];
  // Mínimos escalam com a duração: um Reel de 10s não pode exigir a mesma
  // densidade de um de 60s (o gerador já limita por espaçamento mínimo).
  const expectedZooms = Math.min(2, Math.max(1, Math.round(Number(duration) / 14)));
  const expectedGraphics = Math.min(2, Math.max(1, Math.round(Number(duration) / 22)));
  if ((plan?.zooms || []).length < expectedZooms) issues.push("faltam mudanças de enquadramento");
  if ((plan?.graphics || []).length < expectedGraphics) issues.push("faltam destaques semânticos");
  if ((plan?.sfx || []).length < 1) issues.push("falta desenho de som");
  return { ok: issues.length === 0, issues, mode: "dynamic" };
}
