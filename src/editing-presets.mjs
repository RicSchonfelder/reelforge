export const editingPresets = [
  {
    id: "fluxo-padrao",
    name: "Fluxo Padrão",
    description: "Padrão principal da esteira editorial.",
    output: { width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac" },
    duration: { maxSeconds: 90 },
    playbackSpeed: { min: 1.2, preferred: 1.3, max: 1.4 },
    captions: {
      anchor: "bottom-center",
      minBottomPx: 520,
      preferredBottomPx: 620,
      adaptiveBottomRangePx: { min: 560, max: 680 },
    },
    brief: [
      "Formato vertical 9:16 em 1080x1920 e 30 FPS.",
      "A duração final nunca pode ultrapassar 90 segundos; encurtar pelo conteúdo e preservar pensamentos completos.",
      "Trabalhar preferencialmente em 1.3x, mantendo a velocidade entre 1.2x e 1.4x para dar fluidez sem deixar a fala artificial.",
      "Preservar pensamentos completos e remover pausas, vícios de linguagem, repetições e tentativas descartadas.",
      "Ritmo dinâmico sem deixar a fala artificial.",
      "Legendas em português, grandes, com destaque nas palavras-chave e dentro da área segura.",
      "Manter as legendas mais altas para não colidirem com a interface do Reels: em 1080x1920 usar margem inferior mínima de 520 px, preferencial de 620 px e ajustar entre 560 e 680 px conforme o enquadramento, sempre protegendo o rosto.",
      "Usar cortes secos no talking head; nunca dissolver o mesmo enquadramento.",
      "Aplicar aproximações sutis somente em momentos de ênfase.",
      "Motion graphics apenas quando explicarem números, etapas ou conceitos — sem poluir.",
      "Não adicionar música sem autorização específica.",
    ].join("\n"),
  },
  {
    id: "autoridade-direta",
    name: "Autoridade direta",
    description: "Mais rápido, objetivo e orientado a retenção e conversão.",
    output: { width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac" },
    brief: [
      "Formato vertical 9:16 em 1080x1920 e 30 FPS.",
      "Abrir rapidamente no argumento mais forte e cortar introduções redundantes.",
      "Ritmo firme, cortes secos, aproximações pontuais e callouts para provas, números e ações.",
      "Legendas em português com paginação curta e ênfase em verbos e resultados.",
      "Preservar credibilidade: não alterar o sentido da fala nem criar promessas novas.",
      "Sem música por padrão.",
    ].join("\n"),
  },
  {
    id: "bastidores-natural",
    name: "Bastidores natural",
    description: "Mantém espontaneidade, humanidade e contexto documental.",
    output: { width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac" },
    brief: [
      "Formato vertical 9:16 em 1080x1920 e 30 FPS.",
      "Remover somente erros claros, silêncios longos e repetições que atrapalhem.",
      "Manter pequenas respirações e reações que deixem o relato autêntico.",
      "Legendas em português com visual limpo e poucas intervenções gráficas.",
      "Cortes secos e enquadramento estável; aproximações muito discretas.",
      "Sem música por padrão.",
    ].join("\n"),
  },
];

const defaultOutput = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: "h264",
  audioCodec: "aac",
};

function learnedPresetFromReference(reference) {
  if (
    reference?.analysisStatus !== "ready" ||
    !reference?.analysis?.brief?.trim()
  ) {
    return null;
  }
  return {
    id: `reference-${reference.id}`,
    name: reference.styleName?.trim() || reference.title?.trim() || "Estilo aprendido",
    description:
      reference.analysis.summary?.trim() ||
      "Padrão aprendido a partir de uma referência do Instagram.",
    output: { ...defaultOutput },
    brief: [
      "Use a referência apenas como linguagem de edição. Não copie identidade, marca, texto, voz ou conteúdo.",
      reference.analysis.brief.trim(),
      "Preserve o sentido da fala, pensamentos completos e o formato vertical 9:16 em alta qualidade.",
    ].join("\n"),
    learned: true,
    sourceReferenceId: reference.id,
    sourceUrl: reference.url,
  };
}

export function getEditingPresets(references = []) {
  const learned = references
    .map(learnedPresetFromReference)
    .filter(Boolean);
  return [...editingPresets, ...learned];
}

export function getEditingPreset(id, references = []) {
  return getEditingPresets(references).find((preset) => preset.id === id) || editingPresets[0];
}
