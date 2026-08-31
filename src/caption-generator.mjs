const styleCtas = {
  direct: "Assista até o final e me conta nos comentários: qual parte mais chamou sua atenção?",
  story: "Se você gosta de acompanhar os bastidores reais, salva este vídeo e segue o perfil para ver a continuação.",
  authority: "Compartilha com alguém que precisa ouvir isso e me conta nos comentários o que você faria primeiro.",
};

const topicHashtags = [
  ["ia", "#InteligenciaArtificial"],
  ["inteligência artificial", "#InteligenciaArtificial"],
  ["automação", "#Automacao"],
  ["venda", "#Vendas"],
  ["saas", "#SaaS"],
  ["conteúdo", "#CriacaoDeConteudo"],
  ["marketing", "#MarketingDigital"],
  ["negócio", "#Empreendedorismo"],
  ["webinário", "#Webinario"],
  ["webinar", "#Webinario"],
];

function cleanTranscript(value = "") {
  return String(value)
    .replace(/\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d+)?\]/g, " ")
    .replace(/(?:^|\n)\s*(?:speaker|falante)\s*\d*\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transcriptSentences(transcript) {
  const parts = transcript.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  const useful = parts
    .map((part) => part.trim())
    .filter((part) => part.length >= 18);
  return useful.length ? useful : transcript ? [transcript] : [];
}

function fitSentences(sentences, maxLength) {
  const selected = [];
  let length = 0;
  for (const sentence of sentences) {
    const nextLength = length + sentence.length + (selected.length ? 1 : 0);
    if (selected.length && nextLength > maxLength) break;
    selected.push(sentence.slice(0, Math.max(0, maxLength - length)).trim());
    length = nextLength;
    if (length >= maxLength) break;
  }
  return selected.filter(Boolean).join(" ");
}

function inferHashtags(item, transcript = "") {
  const title = item.title?.trim() || "";
  const haystack = `${title} ${item.series || ""} ${transcript}`.toLowerCase();
  const hashtags = [];

  for (const [keyword, hashtag] of topicHashtags) {
    // Borda de palavra: sem isso "ia" casa com "día", "estratégia", "equipe"…
    const matches = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      .test(haystack);
    if (matches && !hashtags.includes(hashtag)) hashtags.push(hashtag);
  }
  for (const fallback of ["#EmpreendedorismoDigital", "#ReelsBrasil", "#Bastidores"]) {
    if (hashtags.length >= 5) break;
    if (!hashtags.includes(fallback)) hashtags.push(fallback);
  }
  return hashtags.slice(0, 6);
}

export function generateCaption(item, style = "direct") {
  const transcript = cleanTranscript(item.transcript);
  const hashtags = inferHashtags(item, transcript);
  if (!transcript) {
    return {
      caption: "",
      hashtags,
      source: null,
      requiresTranscript: true,
      message: "Aguardando a transcrição do Editor Externo para gerar uma legenda fiel ao vídeo.",
    };
  }

  const sentences = transcriptSentences(transcript);
  const hook = fitSentences(sentences.slice(0, 1), 180);
  const development = fitSentences(sentences.slice(1, 4), 520);
  const spokenCopy = [hook, development].filter(Boolean).join("\n\n");

  return {
    caption: [
      spokenCopy,
      styleCtas[style] || styleCtas.direct,
    ].filter(Boolean).join("\n\n"),
    hashtags,
    source: "transcript",
    requiresTranscript: false,
    transcriptExcerpt: fitSentences(sentences, 700),
  };
}
