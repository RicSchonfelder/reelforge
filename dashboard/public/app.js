const state = {
  overview: null,
  insights: null,
  matrix: { pieces: [], batches: [], engine: {}, publicationEnabled: false },
  editor: {
    jobs: [],
    music: null,
    engine: {},
    templates: [],
    selectedTemplateId: "fluxo-padrao-dynamic",
  },
  timeline: {
    projects: [],
    transcription: {},
    selectedProjectId: null,
    selectedSegmentId: null,
  },
  studio: {
    tab: "assets",
    assetQuery: "",
    selectedContentId: null,
    livePolling: false,
  },
  agent: { messages: [], commands: [], counts: {}, safeguards: {} },
  view: "overview",
  filter: "all",
  coverContentId: null,
};

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
// URLs só entram em href/src com scheme http/https (bloqueia javascript: e dados maliciosos).
const safeUrl = (value = "") => {
  const text = String(value).trim();
  return /^(https?:\/\/|\/)/i.test(text) ? escapeHtml(text) : "#";
};

const stageLabels = {
  inbox: "Entrada",
  editing_requested: "Aguardando edição",
  editing: "Em edição",
  review: "Em revisão",
  ready: "Pronto",
  scheduled: "Agendado",
  publishing: "Publicando",
  published: "Publicado",
  attention: "Atenção",
};

const editingPresetLabels = {
  "fluxo-padrao": "Fluxo Padrão",
  "autoridade-direta": "Autoridade direta",
  "bastidores-natural": "Bastidores natural",
};

function editingPresetLabel(id) {
  return state.overview?.editingPresets?.find((preset) => preset.id === id)?.name
    || editingPresetLabels[id]
    || id;
}

function renderEditingPresetOptions() {
  const presets = state.overview?.editingPresets || [];
  const options = presets.map((preset) => `
    <option value="${escapeHtml(preset.id)}">
      ${preset.learned ? "Aprendido · " : ""}${escapeHtml(preset.name)}${preset.description ? ` — ${escapeHtml(preset.description)}` : ""}
    </option>
  `).join("");
  ["#editingPreset", "#external-editorSourcePreset", "#editorPreset"].forEach((selector) => {
    const element = $(selector);
    if (!element) return;
    const current = element.value;
    element.innerHTML = options;
    element.value = presets.some((preset) => preset.id === current)
      ? current
      : "fluxo-padrao";
  });
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = "toast"; }, 3300);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      // Identifica o cliente Reelforge: o servidor rejeita mutações sem este
      // header (bloqueia envios cross-origin de formulários, anti-CSRF).
      "X-Reelforge-Client": "1",
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.ok
        ? "Resposta inválida do servidor."
        : `Servidor respondeu ${response.status}.`,
    );
  }
  if (!response.ok) throw new Error(payload.error || "Não foi possível concluir.");
  return payload;
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    ...options,
  }).format(new Date(value));
}

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function relativeScheduleLabel(value) {
  const date = new Date(value);
  const key = localDateKey(date);
  const today = localDateKey(new Date());
  const tomorrow = localDateKey(new Date(Date.now() + 24 * 60 * 60_000));
  const day = key === today
    ? "Hoje"
    : key === tomorrow
      ? "Amanhã"
      : formatDate(date, { weekday: "short", day: "2-digit", month: "short" });
  return `${day}, ${formatDate(date, { day: "2-digit", month: "2-digit", year: "numeric" })} às ${formatDate(date, { hour: "2-digit", minute: "2-digit" })}`;
}

function updateScheduleSummary() {
  const input = $("#publishAt");
  const summary = $("#scheduleSummary");
  if (!input?.value || !summary) return;
  summary.innerHTML = `<strong>${escapeHtml(relativeScheduleLabel(new Date(input.value)))}</strong><small>Horário de São Paulo · publicação automática em alta qualidade</small>`;
}

function formatBytes(bytes) {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatMetric(value) {
  return new Intl.NumberFormat("pt-BR", {
    notation: Number(value || 0) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function formatWatchTime(milliseconds) {
  if (!milliseconds) return "—";
  return `${(milliseconds / 1000).toFixed(1).replace(".", ",")}s`;
}

function shortCaption(caption = "") {
  const clean = caption.replace(/\s+/g, " ").trim();
  return clean ? `${clean.slice(0, 86)}${clean.length > 86 ? "…" : ""}` : "Legenda ainda não preparada.";
}

function captionSourceStatus(item) {
  if (item?.captionSource === "transcript" && item?.transcript?.trim()) {
    const local = item.transcriptSource === "reelforge-local";
    return {
      tone: "verified",
      title: "Legenda sincronizada com a fala",
      detail: local
        ? "Gerada pela transcrição local do Reelforge, sem depender do Editor Externo."
        : "Gerada a partir da transcrição em português do Editor Externo.",
    };
  }
  if (item?.captionSource === "manual") {
    return {
      tone: "manual",
      title: "Legenda escrita manualmente",
      detail: "Ela pode ser publicada, mas não foi conferida com a transcrição.",
    };
  }
  if (item?.captionSource === "metadata") {
    return {
      tone: "blocked",
      title: "Legenda antiga não vinculada à fala",
      detail: "Sincronize a transcrição antes de agendar ou publicar.",
    };
  }
  if (["queued", "preparing", "loading_model", "transcribing"].includes(item?.transcriptStatus)) {
    return {
      tone: "waiting",
      title: "Transcrição local em andamento",
      detail: `${Math.round(Number(item.transcriptProgress || 0) * 100)}% · o primeiro uso também prepara o modelo no computador.`,
    };
  }
  if (item?.transcriptStatus === "failed") {
    return {
      tone: "blocked",
      title: "A transcrição local precisa ser refeita",
      detail: item.transcriptError || "O motor não conseguiu concluir esta transcrição.",
    };
  }
  return {
    tone: "waiting",
    title: "Aguardando transcrição",
    detail: "Use o motor local do Reelforge ou vincule uma transcrição já existente.",
  };
}

function go(view) {
  state.view = view;
  document.body.classList.toggle("editor-mode", view === "editor");
  $$(".view").forEach((element) => element.classList.toggle("active", element.id === `view-${view}`));
  $$(".nav-item").forEach((element) => element.classList.toggle("active", element.dataset.view === view));
  const names = { overview: "Visão geral", content: "Conteúdos", agent: "Falar com o agente", editor: "Editor IA", matrix: "Matriz de Criativos", calendar: "Agenda", insights: "Insights", references: "Referências", "external-editor": "Editor Externo ao vivo" };
  $("#pageTitle").textContent = names[view];
  $("#openUpload").hidden = ["agent", "editor", "matrix"].includes(view);
  if (view === "calendar") renderCalendar();
  if (view === "agent") renderAgentChat();
  if (view === "editor") renderEditor();
  if (view === "matrix") renderMatrix();
  if (view === "references") renderReferences();
  if (view === "external-editor") renderExternalEditorProjects();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function groupPipeline(items) {
  return [
    { key: "Entrada", stages: ["inbox"], dot: "muted" },
    { key: "Edição", stages: ["editing_requested", "editing"], dot: "blue" },
    { key: "Prontos", stages: ["review", "ready", "attention"], dot: "warning" },
    { key: "Distribuição", stages: ["scheduled", "publishing", "published"], dot: "" },
  ].map((column) => ({
    ...column,
    items: items.filter((item) => column.stages.includes(item.stage)),
  }));
}

function renderPipeline() {
  const columns = groupPipeline(state.overview.content);
  $("#overviewPipeline").innerHTML = columns.map((column) => `
    <article class="pipeline-column">
      <div class="pipeline-title">${column.key}<span>${column.items.length}</span></div>
      ${column.items.slice(0, 2).map((item) => `
        <div class="pipeline-card">
          <strong><i class="stage-dot ${column.dot}"></i>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(stageLabels[item.stage] || item.stage)} · ${formatDate(item.updatedAt, { day: "2-digit", month: "short" })}</small>
        </div>
      `).join("") || '<div class="pipeline-empty">Nenhum conteúdo aqui</div>'}
    </article>
  `).join("");
}

function renderMetrics() {
  const content = state.overview.content;
  const scheduled = content.filter((item) => item.stage === "scheduled").length;
  const published = content.filter((item) => item.stage === "published").length;
  const average = state.insights?.summary?.averageEngagement;
  $("#metricGrid").innerHTML = `
    <article class="metric-card"><span>Conteúdos no fluxo</span><strong>${content.length}</strong><small>${content.filter((i) => !["published"].includes(i.stage)).length} em produção</small></article>
    <article class="metric-card"><span>Agendados</span><strong>${scheduled}</strong><small>${state.overview.upcoming.length} na fila da Meta</small></article>
    <article class="metric-card"><span>Publicados</span><strong>${published}</strong><small>pelo estúdio local</small></article>
    <article class="metric-card accent"><span>Engajamento médio</span><strong>${average ?? "—"}</strong><small>curtidas + comentários</small></article>
  `;
}

function renderAutoSchedule() {
  const settings = state.overview.autoSchedule || {};
  const slots = settings.slots || [];
  $("#autoScheduleSummary").textContent = settings.enabled
    ? `Até ${settings.dailyLimit || 4} publicações por dia · horário de São Paulo`
    : "Fila automática desativada";
  $("#autoScheduleSlots").innerHTML = slots
    .map((slot) => `<span class="slot-pill">${escapeHtml(slot)}</span>`)
    .join("");
}

function renderScheduleList(target, limit = 8) {
  const jobs = state.overview.upcoming.slice(0, limit);
  $(target).innerHTML = jobs.map((job) => {
    const content = state.overview.content.find((item) => item.id === job.contentId);
    const date = new Date(job.publishAt);
    return `
      <div class="schedule-item">
        <div class="date-block">${String(date.getDate()).padStart(2, "0")}<small>${formatDate(date, { month: "short" }).replace(".", "")}</small></div>
        <div><strong>${escapeHtml(content?.title || String(job.filePath || "").split(/[\\/]/).pop())}</strong><small>${escapeHtml(relativeScheduleLabel(date))} · ${content?.scheduleMode === "automatic" ? "fila automática" : escapeHtml(stageLabels[content?.stage] || job.status)}</small></div>
        <div><span class="time-pill">${formatDate(date, { hour: "2-digit", minute: "2-digit" })}</span>${job.status === "queued" ? `<button class="icon-button cancel-job" data-job="${job.id}" title="Cancelar">×</button>` : ""}</div>
      </div>`;
  }).join("") || '<div class="empty-state">Nenhuma publicação agendada ainda.</div>';
}

function renderPerformance() {
  const posts = state.insights?.summary?.topPosts || [];
  const max = Math.max(...posts.map((item) => item.engagement), 1);
  $("#miniPerformance").innerHTML = posts.slice(0, 4).map((item, index) => `
    <div class="bar-row">
      <span>${index + 1}. ${escapeHtml(shortCaption(item.caption).slice(0, 34))}</span>
      <div class="bar-track"><i style="width:${Math.max(8, item.engagement / max * 100)}%"></i></div>
      <b>${item.engagement}</b>
    </div>
  `).join("") || '<div class="empty-state">As métricas aparecerão quando a API carregar.</div>';
}

function contentActions(item) {
  const previewAction = item.finalFile || item.rawFile
    ? `<button class="button small ghost watch-video" data-id="${item.id}">▶ Revisar vídeo</button>`
    : "";
  const externalEditorAction = item.externalEditorUrl
    ? `<button class="button small ghost watch-external-editor" data-project="${item.externalProjectId}">Acompanhar edição</button>`
    : `<button class="button small ghost link-external-editor" data-id="${item.id}">Vincular Editor Externo</button>`;
  const coverAction = item.finalFile && item.stage !== "published"
    ? `<button class="button small ghost choose-cover" data-id="${item.id}">▣ ${
        item.coverSelection?.status === "ready" ? "Ver capa" : "Gerar capa"
      }</button>`
    : "";
  const timelineAction = (item.rawFile || item.finalFile)
    && !["scheduled", "published"].includes(item.stage)
    ? `<button class="button small ghost open-timeline" data-id="${item.id}">⌁ Abrir timeline</button>`
    : "";
  const common = `
    ${previewAction}
    ${timelineAction}
    ${externalEditorAction}
    ${coverAction}
    <button class="button small ghost edit-caption" data-id="${item.id}">${item.caption ? "Editar legenda" : "Gerar legenda"}</button>
    <button class="button small danger delete-content" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Excluir</button>`;
  if (item.stage === "inbox") {
    return `<button class="button small primary request-edit" data-id="${item.id}">Iniciar edição agora</button>
      <button class="button small ghost attach-final" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Adicionar final</button>${common}`;
  }
  if (item.stage === "review") {
    return `<button class="button small primary approve-edit" data-id="${item.id}">Aprovar e agendar automaticamente</button>
      <button class="button small ghost request-revision" data-id="${item.id}">Pedir ajustes</button>
      <button class="button small ghost attach-final" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Trocar versão</button>${common}`;
  }
  if (["editing_requested", "editing"].includes(item.stage)) {
    return `<button class="button small primary request-edit" data-id="${item.id}">Iniciar agora</button>
      ${previewAction}
      ${timelineAction}
      ${item.externalEditorUrl ? `<a class="button small ghost" href="${safeUrl(item.externalEditorUrl)}" target="_blank" rel="noopener noreferrer">Acompanhar no Editor Externo</a>` : ""}
      <button class="button small ghost attach-final" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Enviar final manualmente</button>
      <button class="button small danger delete-content" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Excluir</button>`;
  }
  if (item.stage === "attention" && !item.finalFile) {
    return `${item.externalEditorUrl ? `<a class="button small primary" href="${safeUrl(item.externalEditorUrl)}" target="_blank" rel="noopener noreferrer">Abrir no Editor Externo</a>` : ""}
      <button class="button small ghost attach-final" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Enviar final manualmente</button>
      <button class="button small danger delete-content" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Excluir</button>`;
  }
  if (["ready", "attention"].includes(item.stage)) {
    return `<button class="button small primary auto-schedule" data-id="${item.id}">Colocar na fila automática</button>
      <button class="button small ghost publish-now" data-id="${item.id}">Publicar agora</button>
      <button class="button small ghost open-schedule" data-id="${item.id}">Agendar manualmente</button>
      <button class="button small ghost attach-final" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Trocar final</button>${common}`;
  }
  if (item.stage === "scheduled") {
    return `${coverAction}
      <button class="button small ghost edit-caption" data-id="${item.id}">Ver legenda</button>
      <button class="button small danger delete-content" data-id="${item.id}" data-title="${escapeHtml(item.title)}">Excluir e cancelar</button>`;
  }
  if (item.stage === "published" && item.publishedPermalink) {
    return `<a class="button small primary" href="${escapeHtml(item.publishedPermalink)}" target="_blank">Ver no Instagram</a>${common}`;
  }
  return common;
}

function filterMatches(item) {
  if (state.filter === "all") return true;
  if (state.filter === "editing") return ["editing_requested", "editing", "review"].includes(item.stage);
  return item.stage === state.filter;
}

function renderContent() {
  const items = state.overview.content.filter(filterMatches);
  $("#contentGrid").innerHTML = items.map((item) => {
    const mediaKind = item.finalFile ? "final" : item.rawFile ? "raw" : null;
    const quality = item.finalFile?.quality;
    const qualityLine = item.finalFile
      ? `<div class="quality-line ${quality?.ok ? "passed" : "pending"}"><i></i>${quality?.ok ? "Reel HQ validado" : "Qualidade será validada antes de publicar"}</div>`
      : "";
    const revisionLine = item.revisionRequest
      ? `<div class="revision-line"><strong>Ajuste solicitado${item.revisionRequest.timecode ? ` · ${escapeHtml(item.revisionRequest.timecode)}` : ""}</strong><span>${escapeHtml(item.revisionRequest.instructions)}</span></div>`
      : "";
    const automationLine = item.agentStatus
      ? `<div class="agent-line"><i></i><span>${escapeHtml(item.agentStatus)}</span></div>`
      : "";
    const captionStatus = captionSourceStatus(item);
    const captionLine = `<div class="caption-source-line ${captionStatus.tone}"><i></i><span><strong>${escapeHtml(captionStatus.title)}</strong><small>${escapeHtml(captionStatus.detail)}</small></span></div>`;
    const cover = item.coverSelection;
    const coverLine = item.finalFile && (item.stage !== "published" || cover?.status === "ready")
      ? cover?.status === "ready"
        ? `<div class="cover-agent-line"><span>✦ Capa escolhida pelo agente</span><strong>${cover.score || "—"}/100 · ${escapeHtml(cover.rationale || "")}</strong></div>`
        : cover?.status === "error"
          ? `<div class="cover-agent-line error"><span>Agente de capa precisa revisar</span><strong>${escapeHtml(cover.error || "Análise indisponível")}</strong></div>`
          : `<div class="cover-agent-line pending"><span>Agente de capa</span><strong>Análise automática pendente</strong></div>`
      : "";
    const sourceLabel = item.finalFile
      ? "FINAL"
      : item.sourceMode === "external-editor"
        ? "EDITOR EXTERNO"
        : "BRUTO";
    const sourceSize = (item.finalFile || item.rawFile)?.sizeBytes
      ? formatBytes((item.finalFile || item.rawFile).sizeBytes)
      : item.sourceMode === "external-editor"
        ? "No Editor Externo"
        : "—";
    return `
      <article class="content-card">
        <div class="content-preview">
          ${mediaKind ? `<video src="/media/${item.id}/${mediaKind}" ${cover?.selectedPreviewUrl ? `poster="${escapeHtml(cover.selectedPreviewUrl)}"` : ""} muted preload="metadata"></video>` : ""}
          ${mediaKind ? `<button class="preview-play watch-video" data-id="${item.id}" aria-label="Revisar ${escapeHtml(item.title)}">▶</button>` : ""}
          <span class="content-badge">${escapeHtml(stageLabels[item.stage] || item.stage)}</span>
          <span class="content-type">${sourceLabel}</span>
        </div>
        <div class="content-card-body">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(shortCaption(item.caption))}</p>
          ${qualityLine}
          ${coverLine}
          ${captionLine}
          ${automationLine}
          ${revisionLine}
          <div class="content-meta"><span>${escapeHtml(editingPresetLabel(item.editingPreset) || item.series)}</span><span>${sourceSize}</span></div>
          <div class="card-actions">${contentActions(item)}</div>
        </div>
      </article>`;
  }).join("") || '<div class="empty-state">Nenhum conteúdo nesta etapa.</div>';
}

function renderInsights() {
  const insights = state.insights;
  const profile = insights?.profile || {};
  const summary = insights?.summary || {};
  const agent = summary.agent || {};
  const benchmarks = agent.benchmarks || {};
  const topics = agent.winningTopics || [];
  $("#performanceConfidence").textContent = `Confiança ${agent.confidence || "inicial"} · ${agent.postsWithAdvancedInsights || 0} vídeos`;
  $("#performanceAgentSummary").innerHTML = `
    <strong>${escapeHtml(agent.headline || "O agente ainda está formando uma linha de base.")}</strong>
    <p>Leitura de ${agent.sampleSize || 0} vídeos recentes de @${escapeHtml(profile.username || "seuinstagram")}. A recomendação é atualizada com os resultados reais de cada nova publicação.</p>
    <div class="performance-signals">
      <span><b>${formatWatchTime(benchmarks.averageWatchTimeMs)}</b> assistidos em média</span>
      <span><b>${benchmarks.averageSkipRate ? `${String(benchmarks.averageSkipRate).replace(".", ",")}%` : "—"}</b> pulam nos 3s iniciais</span>
      <span><b>${String(benchmarks.shareRate || 0).replace(".", ",")}%</b> taxa de compartilhamento</span>
      <span><b>${summary.bestHour || "—"}</b> melhor faixa recente</span>
    </div>`;
  $("#recordingBrief").innerHTML = (agent.nextRecordingBrief || []).map((step, index) => `
    <div class="recording-step">
      <span>0${index + 1}</span>
      <strong>${escapeHtml(step.title)}</strong>
      <p>${escapeHtml(step.instruction)}</p>
    </div>
  `).join("") || '<div class="empty-state">Atualize os dados para gerar o próximo briefing.</div>';
  $("#insightMetricGrid").innerHTML = `
    <article class="metric-card"><span>Publicações analisadas</span><strong>${insights?.media?.length || 0}</strong><small>${formatMetric(profile.followers_count)} seguidores na conta</small></article>
    <article class="metric-card"><span>Visualizações</span><strong>${formatMetric(summary.totals?.views)}</strong><small>reproduções e exibições recentes</small></article>
    <article class="metric-card"><span>Alcance somado</span><strong>${formatMetric(summary.totals?.reach)}</strong><small>contas alcançadas por publicação</small></article>
    <article class="metric-card accent"><span>Compartilhamentos + salvos</span><strong>${formatMetric(Number(summary.totals?.shares || 0) + Number(summary.totals?.saves || 0))}</strong><small>sinais fortes de distribuição</small></article>
  `;
  $("#topPosts").innerHTML = (summary.topPosts || []).map((item) => `
    <a class="top-post" href="${safeUrl(item.permalink)}" target="_blank" rel="noopener noreferrer">
      ${item.thumbnail_url || item.media_url ? `<img class="post-thumb" src="${escapeHtml(item.thumbnail_url || item.media_url)}" alt="" />` : '<span class="post-thumb"></span>'}
      <span>
        <strong>${escapeHtml(shortCaption(item.caption))}</strong>
        <small class="post-metric-row">
          <em>▶ ${formatMetric(item.views)}</em><em>↗ ${formatMetric(item.reach)}</em><em>⇧ ${formatMetric(item.shares)}</em><em>▣ ${formatMetric(item.saves)}</em>
        </small>
      </span>
      <b class="post-score">${item.performanceScore || 0}<small>score</small></b>
    </a>
  `).join("") || '<div class="empty-state">Sem publicações suficientes para o ranking.</div>';
  $("#recentPosts").innerHTML = (summary.recentPosts || []).slice(0, 8).map((item) => `
    <a class="top-post" href="${safeUrl(item.permalink)}" target="_blank" rel="noopener noreferrer">
      ${item.thumbnail_url || item.media_url ? `<img class="post-thumb" src="${escapeHtml(item.thumbnail_url || item.media_url)}" alt="" />` : '<span class="post-thumb"></span>'}
      <span>
        <strong>${escapeHtml(shortCaption(item.caption))}</strong>
        <small class="post-metric-row">
          <em>${formatDate(item.timestamp, { day: "2-digit", month: "short" })}</em><em>▶ ${formatMetric(item.views)}</em><em>♥ ${formatMetric(item.likes)}</em><em>☁ ${formatMetric(item.comments)}</em>
        </small>
      </span>
      <b class="post-score">${item.performanceScore || 0}<small>score</small></b>
    </a>
  `).join("") || '<div class="empty-state">Nenhuma publicação recente encontrada.</div>';
  $("#insightNotes").innerHTML = `
    <div class="insight-note"><strong>Gancho que mais funciona</strong><p>${agent.winningHook ? `O padrão “${escapeHtml(agent.winningHook.label)}” lidera o sinal recente. Exemplo: “${escapeHtml(agent.winningHook.example)}”.` : "Ainda não há amostra suficiente para comparar os ganchos."}</p></div>
    <div class="insight-note"><strong>Temas com melhor resposta</strong><p>${topics.length ? `${topics.map(escapeHtml).join(" · ")}. Use esses temas como ponto de partida, sem repetir literalmente os conteúdos.` : "Os temas serão identificados conforme novas publicações acumularem dados."}</p></div>
    <div class="insight-note"><strong>Retenção inicial</strong><p>${benchmarks.averageSkipRate ? `${String(benchmarks.averageSkipRate).replace(".", ",")}% das visualizações pulam nos primeiros 3 segundos. O próximo vídeo deve mostrar a prova antes do contexto.` : "Aguardando métricas de retenção dos Reels."}</p></div>
    <div class="insight-note"><strong>Distribuição e agenda</strong><p>${summary.bestHour ? `${summary.bestHour} tem o melhor sinal recente.` : "Ainda sem horário vencedor."} A fila continuará testando ${(summary.recommendedSlots || state.overview.autoSchedule?.slots || []).join(" · ") || "novas janelas"} para não confundir horário com qualidade do conteúdo.</p></div>
  `;
}

function renderCalendar() {
  const now = new Date();
  $("#calendarMonth").textContent = formatDate(now, { month: "long", year: "numeric" });
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const scheduledDays = new Set(
    state.overview.upcoming
      .map((job) => new Date(job.publishAt))
      .filter((date) => date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear())
      .map((date) => date.getDate()),
  );
  const headers = ["D", "S", "T", "Q", "Q", "S", "S"].map((day) => `<div class="calendar-day head">${day}</div>`).join("");
  const blanks = Array.from({ length: first.getDay() }, () => '<div class="calendar-day"></div>').join("");
  const cells = Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    return `<div class="calendar-day ${scheduledDays.has(day) ? "has-post" : ""}">${day}${scheduledDays.has(day) ? "<i></i>" : ""}</div>`;
  }).join("");
  $("#calendarGrid").innerHTML = headers + blanks + cells;
  $("#agendaSourceDetail").textContent = state.overview.upcoming.length
    ? `${state.overview.upcoming.length} publicação(ões) confirmada(s) na fila deste painel.`
    : "Nenhuma publicação programada por este painel.";
  renderScheduleList("#fullScheduleList", 30);
}

function renderReferences() {
  const statusLabels = {
    saved: ["Referência salva", "neutral"],
    queued: ["Na fila do agente", "queued"],
    analyzing: ["Aprendendo o estilo", "analyzing"],
    ready: ["Padrão aprendido", "ready"],
    error: ["Análise interrompida", "error"],
  };
  $("#referenceGrid").innerHTML = state.overview.references.map((reference, index) => `
    <article class="reference-card ${reference.analysisStatus === "ready" ? "learned" : ""}">
      <div class="reference-card-head">
        <span class="ref-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="reference-status ${statusLabels[reference.analysisStatus || "saved"]?.[1] || "neutral"}">
          <i></i>${escapeHtml(statusLabels[reference.analysisStatus || "saved"]?.[0] || "Referência salva")}
        </span>
      </div>
      <h3>${escapeHtml(reference.title)}</h3>
      <p>${escapeHtml(reference.analysis?.summary || reference.notes || "O agente vai identificar ritmo, cortes, legendas, enquadramento e recursos visuais.")}</p>
      ${reference.analysisStatus === "ready" ? `
        <div class="reference-style-tags">
          ${[reference.analysis?.rhythm, reference.analysis?.cuts, reference.analysis?.captions]
            .filter(Boolean)
            .slice(0, 3)
            .map((value) => `<span>${escapeHtml(value)}</span>`)
            .join("")}
        </div>
        <button class="button small primary use-reference-style" data-preset="reference-${reference.id}">
          Usar este padrão
        </button>
      ` : reference.analysisStatus === "error" ? `
        <small class="reference-error">${escapeHtml(reference.analysisError || "O agente não conseguiu concluir.")}</small>
        <button class="button small ghost analyze-reference" data-id="${reference.id}">Tentar novamente</button>
      ` : reference.analysisStatus === "saved" ? `
        <button class="button small ghost analyze-reference" data-id="${reference.id}">Aprender este estilo</button>
      ` : `
        <div class="reference-progress"><i></i><span>${reference.analysisStatus === "analyzing" ? "Analisando a linguagem visual…" : "Aguardando o agente iniciar…"}</span></div>
      `}
      <footer><a href="${safeUrl(reference.url)}" target="_blank" rel="noopener">Abrir Reel →</a><button class="icon-button remove-reference" data-id="${reference.id}" title="Remover">×</button></footer>
    </article>
  `).join("") || '<div class="empty-state">Sua biblioteca ainda está vazia.</div>';
}

function renderExternalEditorProjects(preferredProjectId = "") {
  const projects = state.overview.externalProjects || [];
  const selector = $("#external-editorProjectSelect");
  const linkSelector = $("#linkExternalEditorProject");
  const sourceSelector = $("#external-editorSourceProject");
  const current = preferredProjectId || selector.value || projects[0]?.projectId || "";
  const options = projects.map((project) =>
    `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`
  ).join("");
  selector.innerHTML = options || '<option value="">Nenhum projeto sincronizado</option>';
  linkSelector.innerHTML = options || '<option value="">Nenhum projeto sincronizado</option>';
  sourceSelector.innerHTML = options || '<option value="">Nenhum projeto sincronizado</option>';
  if (projects.some((project) => project.projectId === current)) selector.value = current;
  if (projects.some((project) => project.projectId === current)) sourceSelector.value = current;
  loadExternalEditorProject(selector.value);
}

function loadExternalEditorProject(projectId, force = false) {
  const project = (state.overview.externalProjects || []).find((candidate) => candidate.projectId === projectId);
  const frame = $("#external-editorFrame");
  const empty = $("#external-editorEmpty");
  const fullLink = $("#openExternalEditorFull");
  if (!project) {
    frame.src = "about:blank";
    empty.hidden = false;
    $("#external-editorLiveTitle").textContent = "Nenhum projeto conectado";
    fullLink.href = "#";
    fullLink.setAttribute("aria-disabled", "true");
    return;
  }
  if (frame.dataset.projectId !== project.projectId) {
    frame.src = "about:blank";
    frame.dataset.projectId = project.projectId;
    frame.dataset.loaded = "";
  }
  const editorUrl = /^https:\/\//i.test(String(project.editorUrl || "")) ? project.editorUrl : "";
  if (force && editorUrl) {
    frame.src = `${editorUrl}${editorUrl.includes("?") ? "&" : "?"}studioRefresh=${Date.now()}`;
    frame.dataset.loaded = "true";
  }
  empty.hidden = frame.dataset.loaded === "true";
  $("#external-editorLoginLink").href = editorUrl || "#";
  $("#external-editorEmptyTitle").textContent = `Entrar para acompanhar “${project.name}”`;
  $("#external-editorLiveTitle").textContent = project.name;
  fullLink.href = editorUrl || "#";
  fullLink.removeAttribute("aria-disabled");
}

const creativeRoleLabels = {
  hook: "Ganchos",
  body: "Corpos",
  cta: "CTAs",
};

function creativePieceTitle(piece) {
  return escapeHtml(piece?.name || "Peça criativa");
}

function renderMatrix() {
  const matrix = state.matrix || { pieces: [], batches: [] };
  const groups = Object.fromEntries(
    Object.keys(creativeRoleLabels).map((role) => [
      role,
      matrix.pieces.filter((piece) => piece.role === role),
    ]),
  );
  const total = groups.hook.length * groups.body.length * groups.cta.length;
  $("#matrixHookCount").textContent = groups.hook.length;
  $("#matrixBodyCount").textContent = groups.body.length;
  $("#matrixCtaCount").textContent = groups.cta.length;
  $("#matrixCombinationCount").textContent = total;
  const canGenerate = total > 0 && matrix.engine?.ffmpegAvailable !== false;
  $("#generateMatrixBatch").disabled = !canGenerate;
  $("#matrixReadyTitle").textContent = canGenerate
    ? `${total} variação(ões) pronta(s) para gerar`
    : "Adicione as três categorias";
  $("#matrixReadyDetail").textContent = canGenerate
    ? "Os arquivos serão normalizados e entregues apenas para download."
    : "Precisamos de ao menos um Gancho, um Corpo e um CTA.";

  $("#matrixPieceColumns").innerHTML = Object.entries(creativeRoleLabels).map(([role, label]) => `
    <article class="matrix-piece-column">
      <header><span>${label}</span><b>${groups[role].length}</b></header>
      <div>
        ${groups[role].map((piece, index) => `
          <article class="matrix-piece-card">
            <button class="matrix-piece-preview preview-matrix-piece" data-id="${piece.id}" aria-label="Revisar ${creativePieceTitle(piece)}">
              <span>▶</span>
            </button>
            <div>
              <strong>${String(index + 1).padStart(2, "0")} · ${creativePieceTitle(piece)}</strong>
              <small>${piece.media?.durationSeconds ? `${piece.media.durationSeconds}s` : "Vídeo"} · ${piece.media?.width || "?"}×${piece.media?.height || "?"}</small>
            </div>
            <button class="icon-button remove-matrix-piece" data-id="${piece.id}" data-name="${creativePieceTitle(piece)}" title="Remover">×</button>
          </article>
        `).join("") || '<div class="matrix-empty">Nenhuma peça adicionada.</div>'}
      </div>
    </article>
  `).join("");

  $("#matrixBatches").innerHTML = matrix.batches.map((batch) => {
    const ready = batch.combinations.filter((combination) => combination.status === "ready").length;
    const progress = batch.total ? Math.round(((ready + (batch.failed || 0)) / batch.total) * 100) : 0;
    const pieceMap = new Map(matrix.pieces.map((piece) => [piece.id, piece]));
    const statusLabel = {
      queued: "Na fila",
      generating: "Gerando agora",
      ready: "Pronto para baixar",
      partial: "Concluído com alertas",
      failed: "Falha na geração",
    }[batch.status] || batch.status;
    return `
      <article class="matrix-batch-card">
        <header>
          <div><span class="matrix-batch-status ${escapeHtml(batch.status)}">${escapeHtml(statusLabel)}</span><h3>${escapeHtml(batch.name)}</h3><small>${batch.total} variação(ões) · ${ready} pronta(s)</small></div>
          <div class="matrix-batch-actions">
            ${ready ? `<a class="button primary small" href="/creative-download/batches/${batch.id}.zip">↓ Baixar lote .zip</a>` : ""}
            ${["failed", "partial"].includes(batch.status) ? `<button class="button ghost small retry-matrix-batch" data-id="${batch.id}">Tentar novamente</button>` : ""}
            ${batch.status !== "generating" ? `<button class="button danger small remove-matrix-batch" data-id="${batch.id}" data-name="${escapeHtml(batch.name)}">Excluir lote</button>` : ""}
          </div>
        </header>
        <div class="matrix-progress"><i style="width:${progress}%"></i></div>
        <details ${batch.status === "generating" ? "open" : ""}>
          <summary>Ver ${batch.total} combinações</summary>
          <div class="matrix-output-grid">
            ${batch.combinations.map((combination) => {
              const hook = pieceMap.get(combination.hookId);
              const body = pieceMap.get(combination.bodyId);
              const cta = pieceMap.get(combination.ctaId);
              return `
                <article class="matrix-output-card ${escapeHtml(combination.status)}">
                  <div><b>${escapeHtml(combination.label)}</b><small>${creativePieceTitle(hook)} → ${creativePieceTitle(body)} → ${creativePieceTitle(cta)}</small></div>
                  <span>${combination.status === "ready" ? formatBytes(combination.outputFile?.sizeBytes) : combination.status === "failed" ? "Falhou" : "Processando…"}</span>
                  <div>
                    ${combination.status === "ready" ? `
                      <button class="button ghost small preview-matrix-output" data-batch="${batch.id}" data-id="${combination.id}" data-name="${escapeHtml(combination.label)}">▶ Revisar</button>
                      <a class="button ghost small" href="/creative-media/outputs/${batch.id}/${combination.id}?download=1">↓ MP4</a>
                    ` : combination.status === "failed" ? `<small title="${escapeHtml(combination.error || "")}">Verifique o arquivo de origem</small>` : '<i class="matrix-spinner"></i>'}
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </details>
      </article>
    `;
  }).join("") || '<div class="empty-state">Nenhum lote gerado ainda. Adicione as peças e crie sua primeira matriz.</div>';
}

const agentCommandStatusLabels = {
  queued: "Na fila",
  running: "Em execução",
  waiting_review: "Aguardando sua revisão",
  completed: "Concluído",
  failed: "Precisa de atenção",
  cancelled: "Cancelado",
};

function renderAgentChat() {
  const agent = state.agent || { messages: [], commands: [], counts: {} };
  const commands = new Map((agent.commands || []).map((command) => [command.id, command]));
  const messages = $("#agentMessages");
  if (!messages) return;
  const shouldStickToBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  messages.innerHTML = (agent.messages || []).map((message) => {
    const command = message.commandId ? commands.get(message.commandId) : null;
    const status = command ? agentCommandStatusLabels[command.status] : "";
    return `
      <article class="agent-message ${message.role === "user" ? "user" : ""} ${message.kind === "error" ? "error" : ""}">
        <p>${escapeHtml(message.content)}</p>
        <footer>
          ${message.role === "assistant" ? "<span>Operador Reelforge</span>" : "<span>Você</span>"}
          <span>${formatDate(message.createdAt, { hour: "2-digit", minute: "2-digit" })}</span>
          ${status && message.kind !== "welcome" ? `<span class="agent-message-status">${escapeHtml(status)}</span>` : ""}
        </footer>
      </article>
    `;
  }).join("");
  if (shouldStickToBottom || state.view === "agent") messages.scrollTop = messages.scrollHeight;

  const active = agent.activeCommand;
  $("#agentCurrentOperation").innerHTML = active ? `
    <div class="agent-current-operation">
      <strong>${escapeHtml(active.message)}</strong>
      <small>${escapeHtml(active.progress || agentCommandStatusLabels[active.status])}</small>
      <div class="matrix-progress"><i style="width:${active.status === "running" ? 55 : 12}%"></i></div>
    </div>
  ` : '<div class="agent-command-empty">Nenhuma operação aguardando.<br />Envie uma mensagem para iniciar.</div>';

  const queued = Number(agent.counts?.queued || 0);
  const running = Number(agent.counts?.running || 0);
  $("#agentPresenceTitle").textContent = agent.available === false
    ? "Reinicie o painel"
    : running
      ? "Agente trabalhando"
      : "Agente conectado";
  $("#agentPresenceDetail").textContent = agent.available === false
    ? "A API do chat ainda não foi carregada"
    : running
    ? `${running} operação em andamento · ${queued} na fila`
    : queued
      ? `${queued} solicitação(ões) aguardando`
      : "Pronto para receber instruções";
  $("#agentLiveDot").style.background = agent.available === false
    ? "var(--danger)"
    : running
      ? "var(--blue)"
      : "var(--lime)";
}

function editorStatusLabel(job) {
  return {
    queued: "Na fila",
    analyzing: "Analisando",
    rendering: "Renderizando",
    ready: job.settings?.previewMode ? "Prévia pronta" : "Pronto para revisão",
    failed: "Precisa de atenção",
  }[job.status] || job.status;
}

function selectedEditorTemplate() {
  const templates = state.editor?.templates || [];
  return templates.find((template) =>
    template.id === (state.editor.selectedTemplateId || $("#editorTemplate")?.value),
  ) || templates.find((template) => template.id === "fluxo-padrao-dynamic") || templates[0];
}

function templatePreviewMarkup(template) {
  const frame = template.referenceFrames?.[0];
  // CSS custom property: só URLs http(s)/relativas e sem aspas/parênteses.
  const safeFrame = typeof frame === "string" && /^(https?:\/\/|\/)/.test(frame) && !/['"()]/.test(frame)
    ? frame
    : "";
  const style = safeFrame ? ` style="--template-frame:url('${safeFrame}')"` : "";
  const previewClass = `template-preview mode-${escapeHtml(template.engineMode)}`;
  if (template.engineMode === "pulse-tech") {
    return `<div class="${previewClass}"${style}><i></i><span class="template-word one">AUTOMAÇÃO</span><span class="template-word two">CONFIRMADA</span><b>+ PERFORMANCE</b></div>`;
  }
  if (template.engineMode === "manifesto-kinetic") {
    return `<div class="${previewClass}"><span class="manifesto-word one">comece</span><span class="manifesto-word two">antes</span><span class="manifesto-word three">de estar pronto.</span></div>`;
  }
  if (template.engineMode === "remix-split") {
    return `<div class="${previewClass}"><i></i><i></i><b>REAÇÃO + CONTEXTO</b></div>`;
  }
  return `<div class="${previewClass}"><i></i><span>${escapeHtml(template.shortName)}</span><b>${escapeHtml(template.category)}</b></div>`;
}

function renderEditorTemplates() {
  const container = $("#editorTemplateGrid");
  if (!container) return;
  const templates = state.editor?.templates || [];
  const selected = selectedEditorTemplate();
  if (selected) {
    state.editor.selectedTemplateId = selected.id;
    $("#editorTemplate").value = selected.id;
  }
  container.innerHTML = templates.map((template) => {
    const active = selected?.id === template.id;
    const agentWorkflow = template.workflow === "agent-remix";
    return `
      <article class="editor-template-card${active ? " selected" : ""}${template.upcoming ? " upcoming" : ""}">
        ${templatePreviewMarkup(template)}
        <div class="editor-template-body">
          <div class="editor-template-title">
            <span><small>${escapeHtml(template.shortName)} · ${escapeHtml(template.category)}</small><strong>${escapeHtml(template.name)}</strong></span>
            ${template.upcoming ? "<em>EM CONSTRUÇÃO</em>" : agentWorkflow ? "<em>AGENTE</em>" : active ? "<em>SELECIONADO</em>" : ""}
          </div>
          <p>${escapeHtml(template.description)}</p>
          <div class="editor-template-tags">${template.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
          <div class="editor-template-actions">
            <button type="button" class="button small ${active && !agentWorkflow ? "primary" : "ghost"} select-editor-template" data-id="${template.id}" ${template.upcoming ? "disabled" : ""}>${agentWorkflow ? "Pedir Remix ao agente" : active ? "Modelo ativo" : "Usar modelo"}</button>
            ${template.referenceFrames?.length
              ? `<button type="button" class="button small ghost compare-editor-template" data-id="${template.id}">Comparar</button>`
              : ""}
          </div>
        </div>
      </article>`;
  }).join("");
}

function templateJob(templateId) {
  return (state.editor.jobs || []).find((job) =>
    job.settings?.previewMode && job.settings?.templateId === templateId,
  );
}

function renderTemplateComparison(templateId) {
  const template = (state.editor.templates || []).find((item) => item.id === templateId);
  if (!template) return;
  const preview = templateJob(templateId);
  $("#templateCompareDialog").dataset.templateId = template.id;
  $("#templateCompareTitle").textContent = `${template.shortName} · ${template.name}`;
  $("#templateScoreStrip").innerHTML = Object.entries(template.fidelity || {})
    .map(([key, score]) => `<span><small>${escapeHtml({
      typography: "Tipografia",
      rhythm: "Ritmo",
      composition: "Composição",
      transitions: "Transições",
      soundDesign: "Som",
    }[key] || key)}</small><strong>${score}%</strong><i><b style="width:${score}%"></b></i></span>`)
    .join("");
  $("#templateReferenceFrames").innerHTML = template.referenceFrames?.length
    ? template.referenceFrames.map((frame, index) => `<figure><img src="${safeUrl(frame)}" alt="Frame ${index + 1} da referência" /><figcaption>Frame ${String(index + 1).padStart(2, "0")}</figcaption></figure>`).join("")
    : `<div class="template-proof-empty">A referência visual ainda não tem frames capturados.</div>`;
  $("#templateOutputProof").innerHTML = preview?.status === "ready"
    ? `<video src="/editor-media/jobs/${preview.id}" controls playsinline preload="metadata"></video><small>Teste isolado · não altera nem aprova o conteúdo original.</small>`
    : preview
      ? `<div class="template-proof-empty"><i></i><strong>${escapeHtml(preview.step || "Gerando teste")}</strong><small>${Math.round(Number(preview.progress || 0) * 100)}% concluído</small></div>`
      : `<div class="template-proof-empty"><strong>Nenhum teste gerado ainda</strong><small>Crie 16 segundos para confrontar composição, ritmo e legenda com os frames reais.</small></div>`;
  const recipe = template.recipe || {};
  $("#templateRecipe").innerHTML = `
    <span><small>LEGENDA</small><strong>${escapeHtml(recipe.captionMode || "—")}</strong></span>
    <span><small>PALAVRAS</small><strong>${(recipe.wordsPerPage || []).join("–") || "—"} por tela</strong></span>
    <span><small>PUNCH-IN</small><strong>${recipe.punchInPercent || 0}%</strong></span>
    <span><small>TELA GRÁFICA</small><strong>${recipe.graphicEverySeconds ? `a cada ~${recipe.graphicEverySeconds}s` : "mínima"}</strong></span>`;
  $("#runTemplateTest").disabled = Boolean(preview && ["queued", "analyzing", "rendering"].includes(preview.status));
}

function timelineTime(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const remainder = (value % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function activeTimelineProject() {
  return (state.timeline.projects || []).find(
    (project) => project.id === state.timeline.selectedProjectId,
  ) || null;
}

function activeStudioContent() {
  const project = activeTimelineProject();
  const selectedId = state.studio.selectedContentId || project?.contentId;
  const selected = state.overview?.content?.find((item) => item.id === selectedId);
  if (selected) return selected;
  return [...(state.overview?.content || [])]
    .filter((item) => item.rawFile || item.finalFile)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function activeStudioJob(contentId) {
  return [...(state.editor?.jobs || [])]
    .filter((job) => job.contentId === contentId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function studioOperationState(content, job, project) {
  if (!content) return {
    progress: 0,
    title: "Aguardando um vídeo",
    detail: "O próximo upload aparecerá aqui com todas as etapas.",
    tone: "idle",
  };
  const transcriptProgress = Math.max(0, Math.min(1, Number(content.transcriptProgress || 0)));
  const recoveredAfterFailure = Boolean(
    job?.status === "failed"
    && content.finalFile?.uploadedAt
    && new Date(content.finalFile.uploadedAt) > new Date(job.updatedAt || job.createdAt),
  );
  const legacyLocalEdit = Boolean(
    job?.status === "ready"
    && job?.settings?.captions
    && job?.audit?.qualityGate !== "semantic-motion-v3"
  );
  if (legacyLocalEdit) return {
    progress: 100,
    title: "Edição antiga bloqueada para publicação",
    detail: "Reprocesse este vídeo: ele foi criado antes do sincronismo por timestamps.",
    tone: "failed",
  };
  if (job?.status === "failed" && !recoveredAfterFailure) return {
    progress: Math.max(96, Math.round(Number(job.progress || 0) * 100)),
    title: "A edição parou no controle de qualidade",
    detail: job.error || content.agentStatus || "A saída precisa de correção.",
    tone: "failed",
  };
  if (job?.status === "ready" || ["review", "ready"].includes(content.stage)) return {
    progress: 100,
    title: "Edição pronta para revisão",
    detail: content.agentStatus || "Abra a timeline, dê play e revise a versão final.",
    tone: "ready",
  };
  if (job && ["queued", "analyzing", "rendering"].includes(job.status)) return {
    progress: Math.max(42, Math.round(42 + Number(job.progress || 0) * 55)),
    title: job.step || "Editando agora",
    detail: `A timeline está vinculada e a renderização está em ${Math.round(Number(job.progress || 0) * 100)}%.`,
    tone: "working",
  };
  if (content.transcriptStatus === "ready") return {
    progress: project ? 42 : 38,
    title: project ? "Transcrição pronta · timeline criada" : "Transcrição pronta",
    detail: project ? "A fala e as legendas já podem ser conferidas enquanto a edição começa." : "A fala foi reconhecida e está pronta para orientar os cortes.",
    tone: "working",
  };
  if (content.transcriptStatus && content.transcriptStatus !== "failed") return {
    progress: Math.round(8 + transcriptProgress * 30),
    title: "Transcrevendo a fala",
    detail: `${Math.round(transcriptProgress * 100)}% concluído · o arquivo original está preservado.`,
    tone: "working",
  };
  return {
    progress: 8,
    title: "Upload recebido",
    detail: "O vídeo está salvo e aguardando a transcrição local.",
    tone: "working",
  };
}

function renderStudioLiveOperation() {
  const content = activeStudioContent();
  const project = content
    ? (state.timeline.projects || []).find((item) => item.contentId === content.id)
    : null;
  const job = content ? activeStudioJob(content.id) : null;
  const operation = studioOperationState(content, job, project);
  const shell = $("#studioLiveOperation");
  if (!shell) return;
  shell.dataset.tone = operation.tone;
  $("#studioLiveTitle").textContent = operation.title;
  $("#studioLiveDetail").textContent = operation.detail;
  $("#studioLivePercent").textContent = `${operation.progress}%`;
  $("#studioLiveProgress").style.width = `${operation.progress}%`;
  const steps = [
    ["Upload", Boolean(content)],
    ["Transcrição", content?.transcriptStatus === "ready"],
    ["Timeline", Boolean(project)],
    ["Edição", job?.status === "ready" || ["review", "ready", "scheduled", "published"].includes(content?.stage)],
  ];
  $("#studioLiveSteps").innerHTML = steps.map(([label, complete], index) =>
    `<span class="${complete ? "complete" : operation.tone === "failed" && index === 3 ? "failed" : ""}"><i>${complete ? "✓" : index + 1}</i>${label}</span>`,
  ).join("");
  const action = $("#studioLiveAction");
  action.hidden = !content;
  action.dataset.contentId = content?.id || "";
  action.dataset.retry = operation.tone === "failed" && project ? "1" : "";
  action.textContent = operation.tone === "failed" && project
    ? "Corrigir e renderizar novamente"
    : project
      ? "Abrir na timeline"
      : "Criar timeline";
}

function renderStudioTranscript() {
  const content = activeStudioContent();
  const progress = Math.max(0, Math.min(1, Number(content?.transcriptProgress || 0)));
  const quality = content?.transcriptQuality || null;
  $("#studioTranscriptTitle").textContent = content?.title || "Transcrição do vídeo";
  $("#studioTranscriptStatus").textContent = !content
    ? "Selecione uma mídia para acompanhar."
    : content.transcriptStatus === "ready"
      ? content.transcriptWords?.length
        ? `${content.transcriptWords.length} palavras sincronizadas · ${content.transcriptQuality?.modelId || "Whisper local"}`
        : `${(content.transcriptSegments || []).length} trechos com tempo · retranscreva para precisão por palavra`
      : content.transcriptStatus === "failed"
        ? content.transcriptError || "A transcrição precisa de atenção."
        : `Transcrevendo localmente · ${Math.round(progress * 100)}%`;
  $("#studioTranscriptProgress").style.width = `${content?.transcriptStatus === "ready" ? 100 : Math.round(progress * 100)}%`;
  const review = $("#studioTranscriptReview");
  review.hidden = !content?.transcript?.trim();
  review.dataset.contentId = content?.id || "";
  const qualityPanel = $("#studioTranscriptQuality");
  qualityPanel.hidden = !quality;
  const knownQualityStatus = ["clean", "reviewed", "needs_review"].includes(quality?.semanticStatus);
  qualityPanel.className = `studio-transcript-quality ${quality?.semanticStatus === "needs_review" || !knownQualityStatus ? "needs-review" : "clean"}`;
  if (quality) {
    const issueCount = (quality.issues || []).length;
    const label = !knownQualityStatus
      ? "Transcrição anterior · reprocessar ou revisar"
      : quality.semanticStatus === "reviewed"
      ? "Revisada e sincronizada"
      : quality.semanticStatus === "needs_review"
        ? "Revisão obrigatória"
        : "Transcrição aprovada";
    const score = Number.isFinite(Number(quality.score)) ? ` · nota ${Math.round(Number(quality.score))}/100` : "";
    const detail = !knownQualityStatus
      ? "Foi criada antes do novo controle semântico; ela não será publicada sem nova validação."
      : issueCount
        ? `${issueCount} alerta(s): ${(quality.issues || []).slice(0, 2).map((issue) => escapeHtml(issue.message)).join(" · ")}`
        : "Nenhuma palavra suspeita detectada.";
    qualityPanel.innerHTML = `<strong>${label}${score}</strong>${detail}`;
  }
  const segments = content?.transcriptSegments || [];
  $("#studioTranscriptSegments").innerHTML = segments.length
    ? segments.map((segment, index) => `
        <button type="button" data-transcript-start="${Number(segment.start || 0)}">
          <span>${timelineTime(segment.start)}</span>
          <p>${escapeHtml(segment.text)}</p>
          <small>${String(index + 1).padStart(2, "0")}</small>
        </button>`).join("")
    : `<div class="editor-empty"><span>CC</span><strong>${content ? "A fala aparecerá aqui" : "Nenhuma mídia selecionada"}</strong><p>${content ? "O progresso da transcrição será atualizado automaticamente." : "Clique em um vídeo da biblioteca."}</p></div>`;
}

function updateTimelinePlayhead() {
  const player = $("#timelinePlayer");
  const track = $("#timelineTrack");
  const playhead = $("#timelinePlayhead");
  const project = activeTimelineProject();
  if (!player || !track || !playhead || !project) return;
  const ratio = Math.min(1, Math.max(0, Number(player.currentTime || 0) / project.duration));
  playhead.style.left = `${track.offsetLeft + track.offsetWidth * ratio}px`;
  $("#timelineTime").textContent = `${timelineTime(player.currentTime)} / ${timelineTime(project.duration)}`;
  const content = state.overview?.content?.find((item) => item.id === project.contentId);
  const transcriptSegment = (content?.transcriptSegments || []).find((segment) =>
    Number(player.currentTime || 0) >= Number(segment.start || 0)
    && Number(player.currentTime || 0) < Number(segment.end || 0),
  );
  const caption = $("#timelineCaptionPreview");
  caption.textContent = transcriptSegment?.text || "";
  caption.style.display = project.settings.captions && transcriptSegment?.text ? "block" : "none";
}

function renderTimelineHeadline(project) {
  const preview = $("#timelineHeadlinePreview");
  const headline = project?.settings?.headline?.trim() || "";
  preview.textContent = headline;
  preview.style.display = headline ? "block" : "none";
  preview.style.top = `${Math.min(88, Math.max(3, Number(project?.settings?.headlineY || 180) / 1920 * 100))}%`;
  preview.style.fontSize = `${Math.max(14, Number(project?.settings?.headlineFontSize || 56) * 0.48)}px`;
}

function renderTimelineLite() {
  const sourceItems = state.overview?.content?.filter((item) =>
    item.rawFile || item.finalFile,
  ) || [];
  const select = $("#timelineContent");
  if (select) {
    const current = select.value;
    select.innerHTML = sourceItems.length
      ? sourceItems.map((item) => `<option value="${item.id}">${escapeHtml(item.title)} · ${item.rawFile ? "bruto" : "final"}</option>`).join("")
      : '<option value="">Envie um vídeo diretamente ao Reelforge</option>';
    if (sourceItems.some((item) => item.id === current)) select.value = current;
  }

  let project = activeTimelineProject();
  if (!project && state.timeline.selectedProjectId) {
    state.timeline.selectedProjectId = null;
  }
  $("#timelineEmpty").hidden = Boolean(project);
  $("#timelineWorkspace").hidden = !project;
  $("#timelineDock").hidden = !project;
  $("#studioProjectName").textContent = project?.title || "Novo projeto";
  $("#studioViewerLabel").textContent = project?.title || "Selecione uma mídia";
  if (!project) return;

  $("#timelineProjectTitle").textContent = project.title;
  $("#timelineSaveState").textContent = `Salvo · ${formatDate(project.updatedAt, { hour: "2-digit", minute: "2-digit" })}`;
  $("#timelineSpeed").value = project.settings.speed;
  $("#timelineSpeedValue").textContent = `${Number(project.settings.speed).toFixed(2).replace(/0$/, "")}×`;
  $("#timelineHeadline").value = project.settings.headline || "";
  $("#timelineHeadlineY").value = project.settings.headlineY || 180;
  $("#timelineHeadlineSize").value = project.settings.headlineFontSize || 56;
  $("#timelineCaptions").checked = Boolean(project.settings.captions);
  $("#timelineMusic").checked = Boolean(project.settings.music);
  const content = state.overview.content.find((item) => item.id === project.contentId);
  $("#timelineCaptions").disabled = !content?.transcript?.trim();
  $("#timelineMusic").disabled = !state.editor.music;
  state.studio.selectedContentId = content?.id || state.studio.selectedContentId;

  const player = $("#timelinePlayer");
  if (player.dataset.projectId !== project.id) {
    player.pause();
    player.src = project.mediaUrl;
    player.dataset.projectId = project.id;
    player.currentTime = 0;
  }
  renderTimelineHeadline(project);

  const enabledDuration = project.segments
    .filter((segment) => segment.enabled !== false)
    .reduce((total, segment) => total + segment.end - segment.start, 0);
  $("#timelineTrack").innerHTML = project.segments.map((segment, index) => {
    const width = Math.max(0.02, (segment.end - segment.start) / Math.max(0.1, project.duration));
    const selected = segment.id === state.timeline.selectedSegmentId;
    return `<button type="button" class="timeline-clip${selected ? " selected" : ""}${segment.enabled === false ? " disabled" : ""}" data-timeline-segment="${segment.id}" style="flex:${width} 1 0">
      <small>CLIPE ${String(index + 1).padStart(2, "0")}</small>
      <small>${timelineTime(segment.start)}–${timelineTime(segment.end)}</small>
    </button>`;
  }).join("");
  const transcriptSegments = content?.transcriptSegments || [];
  $("#timelineCaptionTrack").innerHTML = transcriptSegments.map((segment, index) => {
    const width = Math.max(0.02, (segment.end - segment.start) / Math.max(0.1, project.duration));
    return `<button type="button" class="timeline-caption-clip" data-transcript-start="${Number(segment.start || 0)}" style="flex:${width} 1 0" title="${escapeHtml(segment.text)}"><span>${String(index + 1).padStart(2, "0")}</span></button>`;
  }).join("");
  const lastJob = (state.editor.jobs || []).find((job) => job.id === project.lastJobId)
    || activeStudioJob(project.contentId);
  const motionPlan = lastJob?.audit?.motionPlan || {};
  const motionDuration = Math.max(0.1, Number(lastJob?.audit?.outputDuration || project.duration));
  const momentClip = (moment, type, label, fallbackDuration = 0.18) => {
    const start = Math.max(0, Number(moment.start ?? moment.at ?? 0));
    const end = Math.max(start + fallbackDuration, Number(moment.end ?? start + Number(moment.duration || fallbackDuration)));
    const left = Math.min(99.5, start / motionDuration * 100);
    const width = Math.max(0.55, Math.min(100 - left, (end - start) / motionDuration * 100));
    return `<span class="timeline-moment-clip ${type}" style="left:${left}%;width:${width}%" title="${escapeHtml(label)} · ${timelineTime(start)}">${escapeHtml(label)}</span>`;
  };
  const effectMoments = [
    ...(motionPlan.zooms || []).map((moment) => momentClip(moment, "zoom", `ZOOM ${Math.round(Number(moment.magnification || 1) * 100)}%`, 0.5)),
    ...(motionPlan.graphics || []).map((moment) => momentClip(moment, "graphic", `MG · ${moment.text || moment.type}`, 0.7)),
    ...(motionPlan.flashes || []).map((moment) => momentClip(moment, "flash", "FLASH", 0.08)),
  ];
  $("#timelineEffectTrack").innerHTML = effectMoments.join("") || '<span class="timeline-track-empty">Renderize para ver os efeitos</span>';
  $("#timelineSfxTrack").innerHTML = (lastJob?.audit?.sfxApplied || motionPlan.sfx || [])
    .map((moment) => momentClip(moment, "sfx", String(moment.type || "SFX").toUpperCase(), 0.22))
    .join("") || '<span class="timeline-track-empty">Sem SFX nesta versão</span>';
  const selected = project.segments.find((segment) => segment.id === state.timeline.selectedSegmentId);
  $("#timelineDeleteSegment").textContent = selected?.enabled === false
    ? "Restaurar trecho selecionado"
    : "Excluir trecho selecionado";
  $("#renderTimeline").textContent = `✦ Renderizar ${timelineTime(enabledDuration / project.settings.speed)}`;
  updateTimelinePlayhead();
}

async function openTimelineForContent(contentId) {
  state.studio.selectedContentId = contentId;
  const project = await api("/api/timeline/projects", {
    method: "POST",
    body: JSON.stringify({ contentId }),
  });
  state.timeline.selectedProjectId = project.id;
  state.timeline.selectedSegmentId = project.segments?.[0]?.id || null;
  await loadEditor();
  go("editor");
  if (!document.body.classList.contains("editor-mode")) {
    $("#timelineWorkspace").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function saveActiveTimeline(patch, { render = true } = {}) {
  const project = activeTimelineProject();
  if (!project) return null;
  $("#timelineSaveState").textContent = "Salvando…";
  const updated = await api(`/api/timeline/projects/${project.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  state.timeline.projects = state.timeline.projects.map((item) =>
    item.id === updated.id ? { ...updated, mediaUrl: project.mediaUrl } : item,
  );
  if (render) renderTimelineLite();
  return updated;
}

function setStudioTab(tab) {
  state.studio.tab = tab;
  $$(".studio-media-tabs [data-studio-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.studioTab === tab);
  });
  $$("[data-studio-pane]").forEach((pane) => {
    pane.classList.toggle("active", pane.dataset.studioPane === tab);
  });
}

function renderStudioAssets() {
  const container = $("#studioAssetGrid");
  if (!container || !state.overview) return;
  const query = String(state.studio.assetQuery || "").trim().toLowerCase();
  const project = activeTimelineProject();
  const selectedContent = activeStudioContent();
  const items = state.overview.content
    .filter((item) => item.rawFile || item.finalFile)
    .filter((item) => !query || `${item.title} ${item.series}`.toLowerCase().includes(query));
  container.innerHTML = items.length
    ? items.map((item) => {
        const kind = item.rawFile ? "raw" : "final";
        const source = item.rawFile || item.finalFile;
        const transcript = item.transcriptStatus === "ready"
          ? "transcrito"
          : ["queued", "preparing", "loading_model", "transcribing"].includes(item.transcriptStatus)
            ? `${Math.round(Number(item.transcriptProgress || 0) * 100)}% transcrição`
            : stageLabels[item.stage] || item.stage;
        return `
          <button type="button" class="studio-asset-card${project?.contentId === item.id || selectedContent?.id === item.id ? " active" : ""}" data-studio-asset="${item.id}">
            <span class="studio-asset-thumb">
              <video src="/media/${item.id}/${kind}" ${item.coverSelection?.selectedPreviewUrl ? `poster="${escapeHtml(item.coverSelection.selectedPreviewUrl)}"` : ""} muted preload="metadata"></video>
              <span>${escapeHtml(kind === "raw" ? "BRUTO" : "FINAL")}</span>
            </span>
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(transcript)} · ${source?.sizeBytes ? formatBytes(source.sizeBytes) : "local"}</small>
          </button>`;
      }).join("")
    : `<div class="editor-empty"><span>↑</span><strong>Nenhum vídeo encontrado</strong><p>Suba até 10 arquivos e dê um único comando ao agente.</p></div>`;
}

function renderStudioAgent() {
  const container = $("#studioAgentMessages");
  if (!container) return;
  const agent = state.agent || { messages: [], commands: [] };
  const commands = new Map((agent.commands || []).map((command) => [command.id, command]));
  const messages = (agent.messages || []).filter((message) => message.kind !== "welcome").slice(-10);
  container.innerHTML = messages.length
    ? messages.map((message) => {
        const command = message.commandId ? commands.get(message.commandId) : null;
        return `<article class="studio-message${message.role === "user" ? " user" : ""}">
          <p>${escapeHtml(message.content)}</p>
          <small>${message.role === "user" ? "Você" : "Agente"} · ${formatDate(message.createdAt, { hour: "2-digit", minute: "2-digit" })}${command ? ` · ${escapeHtml(agentCommandStatusLabels[command.status] || command.status)}` : ""}</small>
        </article>`;
      }).join("")
    : `<article class="studio-message"><p>Suba os vídeos e me diga como quer o lote. Eu cuido da transcrição, cortes, estilo, música e revisão.</p><small>Agente Reelforge</small></article>`;
  container.scrollTop = container.scrollHeight;
}

function renderEditor() {
  if (!state.overview) return;
  const editor = state.editor || { jobs: [], music: null, engine: {} };
  renderEditorTemplates();
  renderTimelineLite();
  renderStudioAssets();
  renderStudioLiveOperation();
  renderStudioTranscript();
  renderStudioAgent();
  setStudioTab(state.studio.tab || "assets");
  const sourceItems = state.overview.content.filter((item) =>
    item.rawFile || item.finalFile,
  );
  const sourceSelect = $("#editorContent");
  if (sourceSelect) {
    const current = sourceSelect.value;
    sourceSelect.innerHTML = sourceItems.length
      ? sourceItems.map((item) => `
          <option value="${item.id}">
            ${escapeHtml(item.title)} · ${item.rawFile ? "bruto" : "final"}
          </option>
        `).join("")
      : '<option value="">Envie um vídeo para a esteira primeiro</option>';
    if (sourceItems.some((item) => item.id === current)) sourceSelect.value = current;
  }

  const busyJobs = (editor.jobs || []).filter((job) =>
    ["queued", "analyzing", "rendering"].includes(job.status),
  );
  $("#editorEngineTitle").textContent = editor.engine?.ffmpegAvailable === false
    ? "Motor indisponível"
    : busyJobs.length
      ? `${busyJobs.length} edição(ões) em andamento`
      : "Motor disponível";
  $("#editorEngineDetail").textContent = editor.engine?.ffmpegAvailable === false
    ? "O FFmpeg local precisa ser restaurado"
    : "FFmpeg local · sem custo por render";

  const musicAvailable = Boolean(editor.music);
  $("#editorMusicStatus").textContent = musicAvailable
    ? `${editor.music.name} · ducking automático`
    : "Envie a faixa padrão abaixo.";
  $("#editorMusicName").textContent = musicAvailable
    ? editor.music.name
    : "Escolher música";
  $("#editorMusic").disabled = !musicAvailable;
  if (!musicAvailable) $("#editorMusic").checked = false;

  const container = $("#editorJobs");
  const jobs = editor.jobs || [];
  container.innerHTML = jobs.length
    ? jobs.map((job) => {
        const content = state.overview.content.find((item) => item.id === job.contentId);
        const recovered = Boolean(
          job.status === "failed"
          && content?.finalFile?.uploadedAt
          && new Date(content.finalFile.uploadedAt) > new Date(job.updatedAt || job.createdAt),
        );
        const progress = recovered ? 100 : Math.round(Number(job.progress || 0) * 100);
        return `
          <article class="editor-job ${escapeHtml(recovered ? "recovered" : job.status)}">
            <div class="editor-job-preview">
              ${job.status === "ready"
                ? `<video src="/editor-media/jobs/${job.id}" preload="metadata" muted playsinline></video><button type="button" class="preview-editor-output" data-id="${job.id}" data-title="${escapeHtml(job.title)}">▶</button>`
                : `<div class="editor-job-orbit"><i></i><span>${recovered ? "✓" : job.status === "failed" ? "!" : "V"}</span></div>`}
            </div>
            <div class="editor-job-body">
              <div class="editor-job-head">
                <span><small>${escapeHtml(recovered ? "Recuperado e validado" : editorStatusLabel(job))}</small><strong>${escapeHtml(job.title)}</strong></span>
                <b>${progress}%</b>
              </div>
              <div class="editor-progress"><i style="width:${progress}%"></i></div>
              <p>${escapeHtml(recovered ? "A saída foi corrigida e está pronta para revisão." : job.error || job.step || "Preparando edição")}</p>
              <div class="editor-job-tags">
                <span>${Number(job.settings?.speed || 1).toFixed(2).replace(/0$/, "")}×</span>
                <span>${escapeHtml(editingPresetLabel(job.presetId))}</span>
                ${job.settings?.templateId
                  ? `<span>${escapeHtml((editor.templates || []).find((template) => template.id === job.settings.templateId)?.shortName || job.settings.templateId)}</span>`
                  : ""}
                ${job.settings?.previewMode ? "<span>Teste isolado · 16s</span>" : ""}
                ${job.settings?.captions ? "<span>Legendas seguras</span>" : ""}
                ${job.audit?.syncMode === "word-timestamps" ? "<span>✓ Sync por palavra</span>" : ""}
                ${job.audit?.syncMode === "segment-timestamps" ? "<span>✓ Sync temporal</span>" : ""}
                ${job.status === "ready" && job.settings?.captions && job.audit?.qualityGate !== "semantic-motion-v3" ? "<span>⚠ Render antigo · bloqueado</span>" : ""}
                ${Number.isFinite(job.audit?.coverageRatio) ? `<span>${Math.round(job.audit.coverageRatio * 100)}% cobertura</span>` : ""}
                ${job.settings?.music ? "<span>Música</span>" : ""}
                ${job.media?.durationSeconds ? `<span>${Number(job.media.durationSeconds).toFixed(1).replace(".", ",")}s</span>` : ""}
              </div>
              ${(job.warnings || []).length
                ? `<div class="editor-warnings">${job.warnings.map((warning) => `<small>⚠ ${escapeHtml(warning)}</small>`).join("")}</div>`
                : ""}
              ${job.status === "ready"
                ? `<div class="editor-job-actions">
                    ${job.settings?.previewMode
                      ? `<button type="button" class="button small primary compare-editor-template" data-id="${job.settings.templateId}">Comparar modelo</button>`
                      : `<button type="button" class="button small primary review-editor-content" data-id="${job.contentId}">Revisar e aprovar</button>`}
                    <a class="button small ghost" href="/editor-media/jobs/${job.id}?download=1">Baixar MP4</a>
                  </div>`
                : recovered
                  ? `<div class="editor-job-actions"><button type="button" class="button small primary review-editor-content" data-id="${content.id}">Revisar edição</button></div>`
                : job.status === "failed" && content
                  ? '<small>Revise a mensagem acima e crie uma nova receita.</small>'
                  : ""}
            </div>
          </article>`;
      }).join("")
    : `
      <div class="editor-empty">
        <span>✦</span>
        <strong>Nenhuma edição criada neste motor</strong>
        <p>Escolha um vídeo, defina o padrão e clique em “Criar edição”.</p>
      </div>`;
}

function renderAll() {
  const scheduler = state.overview.scheduler;
  $("#schedulerLabel").textContent = scheduler.busy ? "Publicando agora" : "Agendador ativo";
  $("#schedulerDot").style.background = scheduler.active ? "var(--lime)" : "var(--danger)";
  $("#accountDot").style.background = state.overview.account.connected ? "var(--lime)" : "var(--danger)";
  renderEditingPresetOptions();
  renderMetrics();
  renderAutoSchedule();
  renderPipeline();
  renderScheduleList("#upcomingList", 4);
  renderPerformance();
  renderContent();
  renderCalendar();
  renderInsights();
  renderReferences();
  renderExternalEditorProjects();
  renderEditor();
  renderMatrix();
  renderAgentChat();
}

async function loadOverview() {
  const [overview, matrix, editor, templatePayload, agent, timeline] = await Promise.all([
    api("/api/overview"),
    api("/api/creative-matrix"),
    api("/api/editor"),
    api("/api/editor/templates"),
    api("/api/agent/chat").catch(() => ({
      ...state.agent,
      available: false,
      activeCommand: null,
    })),
    api("/api/timeline"),
  ]);
  state.overview = overview;
  state.matrix = matrix;
  state.editor = {
    ...editor,
    templates: templatePayload.templates || [],
    selectedTemplateId: state.editor.selectedTemplateId || "fluxo-padrao-dynamic",
  };
  state.agent = agent;
  state.timeline = {
    ...state.timeline,
    ...timeline,
  };
  renderAll();
}

async function loadMatrix() {
  state.matrix = await api("/api/creative-matrix");
  renderMatrix();
}

async function loadEditor() {
  const [editor, templatePayload, timeline] = await Promise.all([
    api("/api/editor"),
    api("/api/editor/templates"),
    api("/api/timeline"),
  ]);
  state.editor = {
    ...editor,
    templates: templatePayload.templates || [],
    selectedTemplateId: state.editor.selectedTemplateId || "fluxo-padrao-dynamic",
  };
  state.timeline = {
    ...state.timeline,
    ...timeline,
  };
  renderEditor();
}

async function loadStudioLive() {
  if (state.studio.livePolling) return;
  state.studio.livePolling = true;
  try {
    const [overview, editor, timeline, agent] = await Promise.all([
      api("/api/overview"),
      api("/api/editor"),
      api("/api/timeline"),
      api("/api/agent/chat"),
    ]);
    state.overview = overview;
    state.editor = {
      ...state.editor,
      ...editor,
    };
    state.timeline = {
      ...state.timeline,
      ...timeline,
    };
    state.agent = agent;
    renderEditor();
  } finally {
    state.studio.livePolling = false;
  }
}

async function loadAgentChat() {
  state.agent = await api("/api/agent/chat");
  renderAgentChat();
}

async function loadInsights(force = false) {
  try {
    state.insights = await api(`/api/insights${force ? "?refresh=1" : ""}`);
    renderMetrics();
    renderPerformance();
    renderInsights();
  } catch (error) {
    toast(`Métricas: ${error.message}`, true);
  }
}

function openUpload({ contentId = "", kind = "raw", title = "" } = {}) {
  const dialog = $("#uploadDialog");
  $("#uploadContentId").value = contentId;
  $("#uploadKind").value = kind;
  $("#uploadTitle").value = title;
  $("#uploadTitle").closest("label").style.display = contentId ? "none" : "grid";
  $("#uploadKindSwitch").style.display = contentId ? "none" : "grid";
  $$("#uploadKindSwitch [data-kind]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === kind);
  });
  $("#dropTitle").textContent = contentId
    ? kind === "final" ? "Envie a versão final exportada" : "Envie o vídeo bruto"
    : kind === "final" ? "Arraste até 10 vídeos editados aqui" : "Arraste até 10 vídeos brutos aqui";
  dialog.showModal();
}

function openCaption(id) {
  const item = state.overview.content.find((candidate) => candidate.id === id);
  if (!item) return;
  const sourceStatus = captionSourceStatus(item);
  $("#captionContentId").value = id;
  $("#captionText").value = item.caption || "";
  $("#captionHashtags").value = (item.hashtags || []).join(" ");
  $("#captionSourceStatus").className = `caption-source-status ${sourceStatus.tone}`;
  $("#captionSourceStatus").innerHTML = `<strong>${escapeHtml(sourceStatus.title)}</strong><span>${escapeHtml(sourceStatus.detail)}</span>`;
  $("#generateCaption").disabled = !item.transcript?.trim();
  $("#generateCaption").textContent = item.transcript?.trim()
    ? "✦ Gerar pela transcrição"
    : "Aguardando transcrição";
  const localButton = $("#startLocalTranscript");
  const transcribing = ["queued", "preparing", "loading_model", "transcribing"].includes(item.transcriptStatus);
  localButton.disabled = transcribing;
  localButton.textContent = transcribing
    ? `◎ Transcrevendo ${Math.round(Number(item.transcriptProgress || 0) * 100)}%`
    : item.transcript?.trim()
      ? "↻ Refazer transcrição local"
      : "◎ Transcrever neste computador";
  $("#captionDialog").showModal();
}

function captionWithHashtags(item) {
  const parts = [item?.caption?.trim(), (item?.hashtags || []).join(" ").trim()].filter(Boolean);
  return parts.join("\n\n");
}

function openSchedule(id) {
  const item = state.overview.content.find((candidate) => candidate.id === id);
  $("#scheduleContentId").value = id;
  $("#scheduleCaption").value = captionWithHashtags(item);
  const defaultDate = new Date(Date.now() + 60 * 60_000);
  defaultDate.setMinutes(Math.ceil(defaultDate.getMinutes() / 15) * 15, 0, 0);
  $("#publishAt").value = new Date(defaultDate.getTime() - defaultDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  updateScheduleSummary();
  $("#scheduleDialog").showModal();
}

function renderCoverDialog(item) {
  const cover = item?.coverSelection;
  $("#coverTitle").textContent = item?.title || "Escolher capa";
  if (cover?.status !== "ready") {
    $("#coverAgentSummary").innerHTML = cover?.status === "error"
      ? `<strong>Não foi possível concluir a análise</strong><small>${escapeHtml(cover.error || "")}</small>`
      : "<strong>O agente está analisando o vídeo</strong><small>Avaliando nitidez, luz, contraste, riqueza visual e proximidade do gancho.</small>";
    $("#coverCandidates").innerHTML = '<div class="cover-loading"><i></i><span>Gerando e comparando os melhores quadros…</span></div>';
    return;
  }

  $("#coverAgentSummary").innerHTML = `
    <strong>Recomendação automática · ${cover.score}/100</strong>
    <small>${escapeHtml(cover.rationale)} Você não precisa fazer nada: esta opção já está salva e seguirá para o Instagram.</small>`;
  $("#coverCandidates").innerHTML = cover.candidates.map((candidate, index) => `
    <button type="button" class="cover-candidate ${candidate.id === cover.selectedCandidateId ? "selected" : ""}" data-cover-candidate="${candidate.id}">
      <span class="cover-rank">${index === 0 ? "RECOMENDADA" : `OPÇÃO ${index + 1}`}</span>
      <img src="${escapeHtml(candidate.previewUrl)}" alt="Quadro em ${escapeHtml(candidate.timeLabel)}" />
      <span class="cover-candidate-meta">
        <strong>${candidate.score}/100 · ${escapeHtml(candidate.timeLabel)}</strong>
        <small>${escapeHtml(candidate.rationale)}</small>
      </span>
      ${candidate.id === cover.selectedCandidateId ? '<i>✓ Em uso</i>' : "<i>Usar esta</i>"}
    </button>
  `).join("");
}

async function openCover(id) {
  const item = state.overview.content.find((candidate) => candidate.id === id);
  if (!item?.finalFile) return;
  state.coverContentId = id;
  renderCoverDialog(item);
  $("#coverDialog").showModal();
  if (item.coverSelection?.status === "ready") return;

  try {
    const updated = await api(`/api/content/${id}/generate-cover`, {
      method: "POST",
      body: "{}",
    });
    await loadOverview();
    renderCoverDialog(updated);
  } catch (error) {
    toast(error.message, true);
  }
}

function openReviewPlayer(id) {
  const item = state.overview.content.find((candidate) => candidate.id === id);
  if (!item) return;
  const kind = item.finalFile ? "final" : item.rawFile ? "raw" : null;
  if (!kind) return;
  const player = $("#reviewPlayer");
  $("#reviewPlayerTitle").textContent = item.title;
  $("#reviewPlayerKind").textContent = kind === "final"
    ? "Versão final para aprovação"
    : "Vídeo bruto enviado";
  player.src = `/media/${item.id}/${kind}`;
  player.load();
  $("#playerDialog").showModal();
}

function openMatrixPlayer(url, title, kind) {
  const player = $("#reviewPlayer");
  $("#reviewPlayerTitle").textContent = title;
  $("#reviewPlayerKind").textContent = kind;
  player.src = url;
  player.load();
  $("#playerDialog").showModal();
}

async function createTemplateTest(templateId) {
  const template = (state.editor.templates || []).find((item) => item.id === templateId);
  if (!template) throw new Error("Modelo de edição não encontrado.");
  const contentId = $("#editorContent").value;
  if (!contentId) throw new Error("Selecione um vídeo de origem para gerar o teste.");
  const existing = templateJob(templateId);
  if (existing && ["queued", "analyzing", "rendering"].includes(existing.status)) {
    throw new Error("Este teste já está sendo renderizado.");
  }
  const job = await api("/api/editor/jobs", {
    method: "POST",
    body: JSON.stringify({
      contentId,
      templateId: template.id,
      presetId: template.presetId,
      previewMode: true,
      previewSeconds: 16,
      settings: {
        speed: Number($("#editorSpeed").value || 1.3),
        style: template.style,
        removeSilence: false,
        captions: true,
        music: false,
        headline: "",
        ctaText: "",
        accentColor: template.accentColor,
      },
    }),
  });
  await loadEditor();
  renderTemplateComparison(template.id);
  return job;
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.matches("[data-view]")) go(target.dataset.view);
  if (target.matches("[data-go]")) go(target.dataset.go);
  if (target.matches("[data-studio-tab]")) {
    setStudioTab(target.dataset.studioTab);
  }
  if (target.matches("[data-studio-command]")) {
    $("#studioAgentInput").value = target.dataset.studioCommand;
    $("#studioAgentInput").focus();
  }
  if (target.matches("[data-studio-asset]")) {
    target.disabled = true;
    try {
      await openTimelineForContent(target.dataset.studioAsset);
      toast("Vídeo aberto no viewer e na timeline.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      target.disabled = false;
    }
  }
  if (target.matches("#studioLiveAction")) {
    const contentId = target.dataset.contentId;
    if (!contentId) return;
    target.disabled = true;
    try {
      const project = (state.timeline.projects || []).find((item) => item.contentId === contentId);
      if (target.dataset.retry === "1" && project) {
        await api(`/api/timeline/projects/${project.id}/render`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        state.studio.tab = "queue";
        toast("Correção aplicada. A nova renderização começou.");
        await loadStudioLive();
      } else {
        await openTimelineForContent(contentId);
      }
    } catch (error) {
      toast(error.message, true);
    } finally {
      target.disabled = false;
    }
  }
  if (target.matches("[data-transcript-start]")) {
    const content = activeStudioContent();
    if (!content) return;
    try {
      const project = activeTimelineProject();
      if (!project || project.contentId !== content.id) {
        await openTimelineForContent(content.id);
      }
      const player = $("#timelinePlayer");
      player.currentTime = Number(target.dataset.transcriptStart || 0);
      player.play().catch(() => {});
    } catch (error) {
      toast(error.message, true);
    }
  }
  if (target.matches("#studioTranscriptReview")) {
    const content = activeStudioContent();
    if (!content?.transcript?.trim()) return;
    const quality = content.transcriptQuality || {};
    const issues = quality.issues || [];
    $("#transcriptReviewContentId").value = content.id;
    $("#transcriptReviewText").value = content.transcript;
    $("#transcriptReviewAudit").innerHTML = `<strong>${issues.length ? "Pontos para conferir" : "Nenhuma palavra suspeita detectada"}</strong>${issues.length ? issues.map((issue) => `• ${escapeHtml(issue.word || "Trecho")}: ${escapeHtml(issue.message)}`).join("<br>") : "Você ainda pode ajustar nomes, termos técnicos e pontuação antes da renderização."}`;
    $("#transcriptReviewDialog").showModal();
  }
  if (target.matches("[data-agent-prompt]")) {
    go("agent");
    $("#agentChatInput").value = target.dataset.agentPrompt;
    $("#agentChatInput").focus();
  }
  if (target.matches(".select-editor-template")) {
    const template = (state.editor.templates || []).find((item) => item.id === target.dataset.id);
    if (!template || template.upcoming) return;
    if (template.workflow === "agent-remix") {
      go("agent");
      $("#agentChatInput").value = "Quero criar um vídeo com o Template 06 · Remix Tela Dividida. Vou enviar o link do Instagram, uma foto e a tarja. Use o vídeo em cima, a foto embaixo, preserve o áudio original e entregue em 1080x1920.";
      $("#agentChatInput").focus();
      toast("Template 06 aberto no agente. Envie o link, a foto e o texto da tarja.");
      return;
    }
    state.editor.selectedTemplateId = template.id;
    $("#editorTemplate").value = template.id;
    $("#editorPreset").value = template.presetId;
    $("#editorStyle").value = template.style;
    renderEditorTemplates();
    toast(`${template.shortName} selecionado. O agente seguirá esta receita.`);
  }
  if (target.matches(".compare-editor-template")) {
    renderTemplateComparison(target.dataset.id);
    $("#templateCompareDialog").showModal();
  }
  if (target.matches("#runTemplateTest")) {
    const templateId = $("#templateCompareDialog").dataset.templateId;
    target.disabled = true;
    try {
      await createTemplateTest(templateId);
      toast("Teste isolado iniciado. A comparação se atualiza na fila.");
    } catch (error) {
      toast(error.message, true);
    } finally {
      target.disabled = false;
    }
  }
  if (target.matches(".open-timeline")) {
    try {
      await openTimelineForContent(target.dataset.id);
      toast("Projeto aberto na Timeline Lite.");
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches("#openTimelineProject")) {
    const contentId = $("#timelineContent").value;
    if (!contentId) return;
    target.disabled = true;
    try {
      await openTimelineForContent(contentId);
      toast("Projeto aberto na Timeline Lite.");
    } catch (error) { toast(error.message, true); }
    finally { target.disabled = false; }
  }
  if (target.matches("[data-timeline-segment]")) {
    const project = activeTimelineProject();
    const segment = project?.segments.find((item) => item.id === target.dataset.timelineSegment);
    if (!segment) return;
    state.timeline.selectedSegmentId = segment.id;
    $("#timelinePlayer").currentTime = segment.start;
    renderTimelineLite();
  }
  if (target.matches("#timelineSplit")) {
    const project = activeTimelineProject();
    const time = Number($("#timelinePlayer").currentTime || 0);
    const segment = project?.segments.find((item) =>
      item.enabled !== false && time > item.start + 0.08 && time < item.end - 0.08,
    );
    if (!segment) {
      toast("Posicione o cursor dentro de um trecho ativo para dividir.", true);
      return;
    }
    const index = project.segments.findIndex((item) => item.id === segment.id);
    const nextSegments = [...project.segments];
    const left = { ...segment, id: crypto.randomUUID(), end: time };
    const right = { ...segment, id: crypto.randomUUID(), start: time };
    nextSegments.splice(index, 1, left, right);
    state.timeline.selectedSegmentId = right.id;
    await saveActiveTimeline({ segments: nextSegments });
    toast("Trecho dividido. O original continua preservado.");
  }
  if (target.matches("#timelineDeleteSegment")) {
    const project = activeTimelineProject();
    const selected = project?.segments.find((item) => item.id === state.timeline.selectedSegmentId);
    if (!selected) {
      toast("Selecione um trecho da faixa V1.", true);
      return;
    }
    const nextSegments = project.segments.map((segment) =>
      segment.id === selected.id
        ? { ...segment, enabled: segment.enabled === false }
        : segment,
    );
    await saveActiveTimeline({ segments: nextSegments });
    toast(selected.enabled === false ? "Trecho restaurado." : "Trecho removido da próxima renderização.");
  }
  if (target.matches("#renderTimeline")) {
    const project = activeTimelineProject();
    if (!project) return;
    target.disabled = true;
    try {
      await saveActiveTimeline({
        settings: {
          speed: Number($("#timelineSpeed").value),
          headline: $("#timelineHeadline").value.trim(),
          headlineY: Number($("#timelineHeadlineY").value),
          headlineFontSize: Number($("#timelineHeadlineSize").value),
          captions: $("#timelineCaptions").checked,
          music: $("#timelineMusic").checked,
        },
      });
      await api(`/api/timeline/projects/${project.id}/render`, {
        method: "POST",
        body: "{}",
      });
      toast("A versão da timeline entrou na fila de renderização.");
      await loadOverview();
      setStudioTab("queue");
    } catch (error) { toast(error.message, true); }
    finally { target.disabled = false; }
  }
  if (target.matches("[data-open-chooser], #openUpload")) $("#uploadChooserDialog").showModal();
  if (target.matches("[data-open-external-editor-source]")) {
    renderExternalEditorProjects();
    $("#external-editorSourceDialog").showModal();
  }
  if (target.matches("[data-open-upload]")) {
    state.uploadReturnView = state.view;
    openUpload({ kind: target.dataset.openUpload || "raw" });
  }
  if (target.matches("[data-upload-kind]")) {
    target.closest("dialog").close();
    if (target.dataset.uploadKind === "external-editor") {
      renderExternalEditorProjects();
      $("#external-editorSourceDialog").showModal();
    } else {
      openUpload({ kind: target.dataset.uploadKind });
    }
  }
  if (target.matches("#uploadKindSwitch [data-kind]")) {
    $("#uploadKind").value = target.dataset.kind;
    $$("#uploadKindSwitch [data-kind]").forEach((button) => button.classList.toggle("active", button === target));
    $("#dropTitle").textContent = target.dataset.kind === "final"
      ? "Arraste até 10 vídeos editados aqui"
      : "Arraste até 10 vídeos brutos aqui";
  }
  if (target.matches("[data-close]")) {
    const dialog = target.closest("dialog");
    if (dialog?.id === "playerDialog") {
      const player = $("#reviewPlayer");
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    dialog.close();
  }
  if (target.matches(".filter")) {
    state.filter = target.dataset.filter;
    $$(".filter").forEach((button) => button.classList.toggle("active", button === target));
    renderContent();
  }
  if (target.matches(".request-edit")) {
    try {
      await api(`/api/content/${target.dataset.id}/external-editor-request`, { method: "POST", body: "{}" });
      toast("Prioridade ativada. O agente começa em até 1 minuto.");
      await loadOverview();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".watch-video")) openReviewPlayer(target.dataset.id);
  if (target.matches(".choose-cover")) openCover(target.dataset.id);
  if (target.matches("[data-cover-candidate]")) {
    try {
      const updated = await api(
        `/api/content/${state.coverContentId}/select-cover`,
        {
          method: "POST",
          body: JSON.stringify({
            candidateId: target.dataset.coverCandidate,
          }),
        },
      );
      await loadOverview();
      renderCoverDialog(updated);
      toast("Capa atualizada. Ela já seguirá para a publicação.");
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches("#regenerateCover")) {
    target.disabled = true;
    $("#coverCandidates").innerHTML = '<div class="cover-loading"><i></i><span>Refazendo a análise…</span></div>';
    try {
      const updated = await api(
        `/api/content/${state.coverContentId}/generate-cover`,
        { method: "POST", body: "{}" },
      );
      await loadOverview();
      renderCoverDialog(updated);
      toast("O agente refez a análise e salvou a melhor capa.");
    } catch (error) { toast(error.message, true); }
    finally { target.disabled = false; }
  }
  if (target.matches(".preview-matrix-piece")) {
    const piece = state.matrix.pieces.find((candidate) => candidate.id === target.dataset.id);
    if (piece) {
      openMatrixPlayer(`/creative-media/pieces/${piece.id}`, piece.name, `${creativeRoleLabels[piece.role]} · PEÇA ORIGINAL`);
    }
  }
  if (target.matches(".preview-matrix-output")) {
    openMatrixPlayer(
      `/creative-media/outputs/${target.dataset.batch}/${target.dataset.id}`,
      target.dataset.name,
      "VARIAÇÃO FINAL · SOMENTE DOWNLOAD",
    );
  }
  if (target.matches(".preview-editor-output")) {
    openMatrixPlayer(
      `/editor-media/jobs/${target.dataset.id}`,
      target.dataset.title,
      "VERSÃO FINAL · REELFORGE EDITOR",
    );
  }
  if (target.matches(".review-editor-content")) {
    await loadOverview();
    go("content");
    openReviewPlayer(target.dataset.id);
  }
  if (target.matches(".remove-matrix-piece")) {
    if (!confirm(`Remover a peça “${target.dataset.name}”?`)) return;
    try {
      await api(`/api/creative-matrix/pieces/${target.dataset.id}`, { method: "DELETE" });
      toast("Peça removida da Matriz.");
      await loadMatrix();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".remove-matrix-batch")) {
    if (!confirm(`Excluir o lote “${target.dataset.name}” e todos os MP4s gerados?`)) return;
    try {
      await api(`/api/creative-matrix/batches/${target.dataset.id}`, { method: "DELETE" });
      toast("Lote e arquivos gerados excluídos.");
      await loadMatrix();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".retry-matrix-batch")) {
    try {
      await api(`/api/creative-matrix/batches/${target.dataset.id}/retry`, {
        method: "POST",
        body: "{}",
      });
      toast("Lote reenviado para geração.");
      await loadMatrix();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".attach-final")) {
    openUpload({ contentId: target.dataset.id, kind: "final", title: target.dataset.title });
  }
  if (target.matches(".link-external-editor")) {
    $("#linkExternalEditorContentId").value = target.dataset.id;
    renderExternalEditorProjects();
    $("#linkExternalEditorDialog").showModal();
  }
  if (target.matches(".watch-external-editor")) {
    go("external-editor");
    renderExternalEditorProjects(target.dataset.project);
  }
  if (target.matches(".approve-edit")) {
    try {
      const approved = await api(`/api/content/${target.dataset.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ autoSchedule: true, shareToFeed: true }),
      });
      toast(`Aprovado e agendado automaticamente para ${relativeScheduleLabel(approved.scheduleSlot.publishAt)}.`);
      await loadOverview();
      go("calendar");
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".auto-schedule")) {
    try {
      const scheduled = await api(`/api/content/${target.dataset.id}/auto-schedule`, {
        method: "POST",
        body: JSON.stringify({ shareToFeed: true }),
      });
      toast(`Agendado automaticamente para ${relativeScheduleLabel(scheduled.scheduleSlot.publishAt)}.`);
      await loadOverview();
      go("calendar");
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".request-revision")) {
    $("#revisionContentId").value = target.dataset.id;
    $("#revisionTimecode").value = "";
    $("#revisionInstructions").value = "";
    $("#revisionDialog").showModal();
  }
  if (target.matches(".publish-now")) {
    if (!confirm("Publicar este Reel agora? O envio começará em até 15 segundos.")) return;
    const item = state.overview.content.find((candidate) => candidate.id === target.dataset.id);
    try {
      await api(`/api/content/${target.dataset.id}/publish-now`, {
        method: "POST",
        body: JSON.stringify({ caption: captionWithHashtags(item), shareToFeed: true }),
      });
      toast("Publicação confirmada. O envio para a Meta vai começar agora.");
      await loadOverview();
      go("calendar");
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".edit-caption")) openCaption(target.dataset.id);
  if (target.matches(".delete-content")) {
    const warning = `Excluir “${target.dataset.title}”? O arquivo salvo neste computador também será removido.`;
    if (!confirm(warning)) return;
    try {
      await api(`/api/content/${target.dataset.id}`, { method: "DELETE" });
      toast("Conteúdo e arquivos locais excluídos.");
      await loadOverview();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches(".open-schedule")) openSchedule(target.dataset.id);
  if (target.matches(".cancel-job")) {
    if (!confirm("Cancelar esta publicação agendada?")) return;
    try {
      await api(`/api/queue/${target.dataset.job}/cancel`, { method: "POST", body: "{}" });
      toast("Agendamento cancelado.");
      await loadOverview();
    } catch (error) { toast(error.message, true); }
  }
  if (target.matches("#openReference")) $("#referenceDialog").showModal();
  if (target.matches(".analyze-reference")) {
    target.disabled = true;
    try {
      await api(`/api/references/${target.dataset.id}/analyze`, {
        method: "POST",
        body: "{}",
      });
      toast("Referência enviada ao agente para análise.");
      await loadOverview();
    } catch (error) {
      target.disabled = false;
      toast(error.message, true);
    }
  }
  if (target.matches(".use-reference-style")) {
    renderExternalEditorProjects();
    $("#external-editorSourcePreset").value = target.dataset.preset;
    $("#external-editorSourceDialog").showModal();
    toast("Padrão aprendido selecionado para a próxima edição.");
  }
  if (target.matches(".remove-reference")) {
    if (!confirm("Remover esta referência?")) return;
    await api(`/api/references/${target.dataset.id}`, { method: "DELETE" });
    await loadOverview();
  }
  if (target.matches("#refreshInsights")) {
    target.disabled = true;
    await loadInsights(true);
    target.disabled = false;
    toast("Métricas atualizadas.");
  }
  if (target.matches("#reloadExternalEditor")) {
    loadExternalEditorProject($("#external-editorProjectSelect").value, true);
    toast("Editor Editor Externo atualizado.");
  }
  if (target.matches("#loadExternalEditorEmbed")) {
    loadExternalEditorProject($("#external-editorProjectSelect").value, true);
    toast("Carregando a sessão autenticada do Editor Externo.");
  }
});

$("#external-editorProjectSelect").addEventListener("change", (event) => {
  loadExternalEditorProject(event.currentTarget.value);
});

$("#agentChatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $("#agentChatInput");
  const message = input.value.trim();
  if (!message) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    state.agent = result.chat;
    input.value = "";
    renderAgentChat();
    toast("Solicitação enviada ao agente.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
    input.focus();
  }
});

$("#agentChatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#agentChatForm").requestSubmit();
  }
});

$("#studioAgentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = $("#studioAgentInput");
  const message = input.value.trim();
  if (!message) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await api("/api/agent/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    state.agent = result.chat;
    input.value = "";
    renderAgentChat();
    renderStudioAgent();
    toast("Comando enviado. O agente vai operar o lote.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
    input.focus();
  }
});

$("#studioAgentInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#studioAgentForm").requestSubmit();
  }
});

$("#studioAssetSearch").addEventListener("input", (event) => {
  state.studio.assetQuery = event.currentTarget.value;
  renderStudioAssets();
});

$("#editorSpeed").addEventListener("input", (event) => {
  $("#editorSpeedValue").textContent = `${Number(event.currentTarget.value).toFixed(2).replace(/0$/, "")}×`;
});

let timelineSaveTimer = null;

function timelineSettingsFromForm() {
  return {
    speed: Number($("#timelineSpeed").value),
    headline: $("#timelineHeadline").value.trim(),
    headlineY: Number($("#timelineHeadlineY").value),
    headlineFontSize: Number($("#timelineHeadlineSize").value),
    captions: $("#timelineCaptions").checked,
    music: $("#timelineMusic").checked,
  };
}

function queueTimelineSettingsSave() {
  const project = activeTimelineProject();
  if (!project) return;
  const settings = timelineSettingsFromForm();
  project.settings = { ...project.settings, ...settings };
  $("#timelineSpeedValue").textContent = `${settings.speed.toFixed(2).replace(/0$/, "")}×`;
  $("#timelineSaveState").textContent = "Alterações pendentes…";
  renderTimelineHeadline(project);
  clearTimeout(timelineSaveTimer);
  timelineSaveTimer = setTimeout(async () => {
    try {
      await saveActiveTimeline({ settings }, { render: false });
      $("#timelineSaveState").textContent = "Salvo neste computador";
    } catch (error) {
      $("#timelineSaveState").textContent = "Falha ao salvar";
      toast(error.message, true);
    }
  }, 450);
}

[
  "#timelineSpeed",
  "#timelineHeadline",
  "#timelineHeadlineY",
  "#timelineHeadlineSize",
  "#timelineCaptions",
  "#timelineMusic",
].forEach((selector) => {
  $(selector).addEventListener("input", queueTimelineSettingsSave);
  $(selector).addEventListener("change", queueTimelineSettingsSave);
});

$("#timelinePlayer").addEventListener("timeupdate", updateTimelinePlayhead);
$("#timelinePlayer").addEventListener("loadedmetadata", updateTimelinePlayhead);
$("#timelinePlayer").addEventListener("play", () => {
  $("#timelinePlay").textContent = "❚❚ Pausar";
});
$("#timelinePlayer").addEventListener("pause", () => {
  $("#timelinePlay").textContent = "▶ Reproduzir";
});
$("#timelinePlay").addEventListener("click", () => {
  const player = $("#timelinePlayer");
  if (player.paused) player.play().catch(() => {});
  else player.pause();
});
$("#timelineBack").addEventListener("click", () => {
  const player = $("#timelinePlayer");
  player.currentTime = Math.max(0, player.currentTime - 2);
});
$("#timelineForward").addEventListener("click", () => {
  const player = $("#timelinePlayer");
  player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 2);
});
$("#timelineTrack").addEventListener("click", (event) => {
  if (event.target.closest("[data-timeline-segment]")) return;
  const project = activeTimelineProject();
  if (!project) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  $("#timelinePlayer").currentTime = ratio * project.duration;
});

$("#editorMusicFile").addEventListener("change", (event) => {
  const file = event.currentTarget.files?.[0];
  if (file) $("#editorMusicName").textContent = file.name;
});

$("#editorMusicForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = $("#editorMusicFile").files?.[0];
  if (!file) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const data = new FormData();
    data.append("music", file);
    await api("/api/editor/music", { method: "POST", body: data });
    $("#editorMusicFile").value = "";
    toast("Música padrão salva no Reelforge Editor.");
    await loadEditor();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

$("#editorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = "Enviando para o motor…";
  try {
    const job = await api("/api/editor/jobs", {
      method: "POST",
      body: JSON.stringify({
        contentId: $("#editorContent").value,
        templateId: $("#editorTemplate").value,
        presetId: $("#editorPreset").value,
        settings: {
          speed: Number($("#editorSpeed").value),
          style: $("#editorStyle").value,
          removeSilence: $("#editorSilence").checked,
          captions: $("#editorCaptions").checked,
          music: $("#editorMusic").checked,
          headline: $("#editorHeadline").value.trim(),
          ctaText: $("#editorCta").value.trim(),
          accentColor: selectedEditorTemplate()?.accentColor || "#B08968",
        },
      }),
    });
    toast(`“${job.title}” entrou na fila do Reelforge Editor.`);
    $("#editorHeadline").value = "";
    await loadOverview();
    renderEditor();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
    submit.textContent = "✦ Criar edição";
  }
});

$("#matrixUploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...$("#matrixPieceFiles").files];
  if (!files.length) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    for (let index = 0; index < files.length; index += 1) {
      $("#matrixUploadStatus").textContent = `Enviando ${index + 1} de ${files.length}: ${files[index].name}`;
      const data = new FormData();
      data.append("role", $("#matrixPieceRole").value);
      data.append("name", files[index].name.replace(/\.[^.]+$/, ""));
      data.append("video", files[index]);
      await api("/api/creative-matrix/pieces", { method: "POST", body: data });
    }
    $("#matrixPieceFiles").value = "";
    $("#matrixUploadStatus").textContent = `${files.length} peça(s) adicionada(s).`;
    toast("Peças adicionadas à Matriz.");
    await loadMatrix();
  } catch (error) {
    $("#matrixUploadStatus").textContent = error.message;
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

$("#generateMatrixBatch").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const batch = await api("/api/creative-matrix/batches", {
      method: "POST",
      body: JSON.stringify({ name: $("#matrixBatchName").value.trim() }),
    });
    $("#matrixBatchName").value = "";
    toast(`${batch.total} variação(ões) entraram em geração.`);
    await loadMatrix();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#linkExternalEditorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/content/${$("#linkExternalEditorContentId").value}/link-external-editor`, {
      method: "POST",
      body: JSON.stringify({ projectId: $("#linkExternalEditorProject").value }),
    });
    form.closest("dialog").close();
    toast("Conteúdo vinculado ao projeto Editor Externo.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
});

$("#external-editorSourceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api("/api/content/from-external-editor", {
      method: "POST",
      body: JSON.stringify({
        projectId: $("#external-editorSourceProject").value,
        sourceAssetName: $("#external-editorSourceAssetName").value.trim(),
        title: $("#external-editorSourceTitle").value.trim(),
        editingPreset: $("#external-editorSourcePreset").value,
        notes: $("#external-editorSourceNotes").value.trim(),
      }),
    });
    form.reset();
    form.closest("dialog").close();
    toast("Projeto enviado para a fila. O agente começa em até 1 minuto.");
    await loadOverview();
    go("content");
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

$("#generateCaption").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Gerando…";
  try {
    const suggestion = await api(`/api/content/${$("#captionContentId").value}/generate-caption`, {
      method: "POST",
      body: JSON.stringify({ style: $("#captionStyle").value }),
    });
    $("#captionText").value = suggestion.caption;
    $("#captionHashtags").value = suggestion.hashtags.join(" ");
    $("#captionSourceStatus").className = "caption-source-status verified";
    $("#captionSourceStatus").innerHTML = "<strong>Legenda gerada pela transcrição</strong><span>O conteúdo acompanha o que é falado no vídeo.</span>";
    toast("Legenda criada a partir da fala do vídeo. Revise e salve quando estiver boa.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "✦ Gerar pela transcrição";
  }
});

$("#startLocalTranscript").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const contentId = $("#captionContentId").value;
  button.disabled = true;
  button.textContent = "◎ Preparando transcrição local…";
  try {
    await api(`/api/content/${contentId}/transcribe-local`, {
      method: "POST",
      body: JSON.stringify({ force: true }),
    });
    toast("Transcrição local iniciada. Você pode fechar esta janela.");
    await loadOverview();
    $("#captionDialog").close();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = "◎ Transcrever neste computador";
  }
});

$("#captionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const hashtags = $("#captionHashtags").value
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith("#") ? tag : `#${tag}`);
  try {
    await api(`/api/content/${$("#captionContentId").value}`, {
      method: "PATCH",
      body: JSON.stringify({
        caption: $("#captionText").value.trim(),
        hashtags: [...new Set(hashtags)].slice(0, 15),
        captionSource: "manual",
      }),
    });
    form.closest("dialog").close();
    toast("Legenda e hashtags salvas.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
});

$("#transcriptReviewForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  const contentId = $("#transcriptReviewContentId").value;
  const transcript = $("#transcriptReviewText").value.replace(/\s+/g, " ").trim();
  submit.disabled = true;
  try {
    await api(`/api/content/${contentId}`, {
      method: "PATCH",
      body: JSON.stringify({
        transcript,
        transcriptReviewed: true,
        transcriptSource: "reelforge-local-reviewed",
      }),
    });
    form.closest("dialog").close();
    toast("Transcrição revisada e timestamps realinhados. A próxima renderização usará este texto.");
    await loadOverview();
    renderStudioTranscript();
  } catch (error) {
    toast(error.message, true);
  } finally {
    submit.disabled = false;
  }
});

$("#revisionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(`/api/content/${$("#revisionContentId").value}/request-revision`, {
      method: "POST",
      body: JSON.stringify({
        timecode: $("#revisionTimecode").value,
        instructions: $("#revisionInstructions").value,
      }),
    });
    form.reset();
    form.closest("dialog").close();
    toast("Pedido de reedição salvo com o trecho e as instruções.");
    await loadOverview();
  } catch (error) { toast(error.message, true); }
});

$("#uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const progress = $("#uploadProgress");
  const progressLabel = progress.querySelector("span");
  progress.classList.add("active");
  const submit = form.querySelector('[type="submit"]');
  const kind = $("#uploadKind").value;
  const contentId = $("#uploadContentId").value;
  const selectedFiles = [...$("#videoInput").files];
  const files = contentId ? selectedFiles.slice(0, 1) : selectedFiles.slice(0, 10);
  const batchTitle = $("#uploadTitle").value.trim();
  if (!files.length) {
    progress.classList.remove("active");
    toast("Escolha pelo menos um vídeo.", true);
    return;
  }
  submit.disabled = true;
  let uploadedCount = 0;
  const failures = [];
  try {
    for (const [index, file] of files.entries()) {
      progressLabel.textContent = `Enviando ${index + 1} de ${files.length} · ${file.name}`;
      const payload = new FormData(form);
      payload.delete("video");
      payload.append("video", file);
      if (batchTitle && files.length > 1) {
        payload.set("title", `${batchTitle} · ${String(index + 1).padStart(2, "0")}`);
      }
      try {
        await api("/api/upload", { method: "POST", body: payload });
        uploadedCount += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error.message}`);
      }
    }
    if (!uploadedCount) throw new Error(failures[0] || "Nenhum arquivo foi enviado.");
    form.reset();
    $("#uploadKind").value = "raw";
    $("#uploadContentId").value = "";
    progress.classList.remove("active");
    form.closest("dialog").close();
    toast(failures.length
      ? `${uploadedCount} vídeo(s) recebidos e ${failures.length} precisam ser reenviados.`
      : `${uploadedCount} vídeo(s) recebidos. A transcrição local e a organização do lote já começaram.`,
    failures.length > 0);
    await loadOverview();
    go(state.uploadReturnView || "content");
    if ((state.uploadReturnView || state.view) === "editor") {
      setStudioTab("assets");
      $("#studioAgentInput").value = kind === "final"
        ? `Recebi ${uploadedCount} vídeos já editados. Gere as legendas pela transcrição e traga todos para revisão.`
        : `Edite os ${uploadedCount} vídeos que acabei de subir, seguindo nosso padrão. Transcreva, aplique os cortes e traga todos para revisão.`;
      $("#studioAgentInput").focus();
    }
    state.uploadReturnView = null;
  } catch (error) {
    toast(error.message, true);
  } finally {
    progressLabel.textContent = "Preparando o lote…";
    progress.classList.remove("active");
    submit.disabled = false;
  }
});

$("#publishAt").addEventListener("change", updateScheduleSummary);

$("#scheduleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = $("#scheduleContentId").value;
  try {
    await api(`/api/content/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({
        publishAt: new Date($("#publishAt").value).toISOString(),
        caption: $("#scheduleCaption").value,
        shareToFeed: $("#shareToFeed").checked,
      }),
    });
    form.closest("dialog").close();
    toast("Reel programado com sucesso.");
    await loadOverview();
    go("calendar");
  } catch (error) { toast(error.message, true); }
});

$("#referenceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  try {
    const payload = Object.fromEntries(formData);
    payload.learnStyle = formData.get("learnStyle") === "true";
    await api("/api/references", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    form.reset();
    form.closest("dialog").close();
    toast(payload.learnStyle
      ? "Link salvo. O agente já entrou na fila para aprender o estilo."
      : "Referência salva.");
    await loadOverview();
    go("references");
  } catch (error) { toast(error.message, true); }
});

const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
}));
dropzone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files].slice(0, 10);
  if (!files.length) return;
  const transfer = new DataTransfer();
  files.forEach((file) => transfer.items.add(file));
  $("#videoInput").files = transfer.files;
  $("#dropTitle").textContent = files.length === 1
    ? files[0].name
    : `${files.length} vídeos selecionados`;
});
$("#videoInput").addEventListener("change", (event) => {
  const files = [...event.target.files].slice(0, 10);
  if (files.length) {
    $("#dropTitle").textContent = files.length === 1
      ? files[0].name
      : `${files.length} vídeos selecionados`;
  }
});

// Bootstrap resiliente: backend fora do ar no primeiro load não pode congelar
// o painel para sempre — os timers e o service worker continuam sendo criados.
loadOverview()
  .then(() => loadInsights())
  .catch((error) => {
    console.warn("Falha no carregamento inicial:", error?.message || error);
    toast("Não foi possível falar com o servidor local. Tentando novamente…", true);
  });
setInterval(() => {
  loadOverview().catch(() => {
    console.warn("Servidor local indisponível (polling de 15s).");
  });
}, 15_000);
setInterval(() => loadInsights().catch(() => {}), 10 * 60_000);
setInterval(() => {
  if (state.view === "matrix") loadMatrix().catch(() => {});
}, 3_000);
setInterval(() => {
  if (state.view === "editor") loadStudioLive().catch(() => {});
}, 2_000);
setInterval(() => {
  if (state.view === "agent") loadAgentChat().catch(() => {});
}, 2_500);
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
