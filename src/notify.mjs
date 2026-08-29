// Notificações de eventos da fila para canais externos (webhook genérico e
// Telegram). O servidor roda 24/7; falhas de publicação precisam chegar ao
// operador sem depender de abrir o painel.
//
// Contrato: notifyEvent NUNCA lança. Qualquer erro de rede/configuração é
// absorvido e refletido no retorno — uma falha de notificação não pode
// interferir na publicação nem derrubar o agendador.

const FETCH_TIMEOUT_MS = 5000;

function eventoNormalizado(event) {
  return {
    type: event?.type ?? "unknown",
    jobId: event?.jobId ?? null,
    title: event?.title ?? "",
    detail: event?.detail ?? "",
  };
}

async function notifyWebhook(evento) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return false;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: evento.type,
      jobId: evento.jobId,
      title: evento.title,
      detail: evento.detail,
      at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return response.ok;
}

async function notifyTelegram(evento) {
  const token = process.env.NOTIFY_TELEGRAM_TOKEN;
  const chatId = process.env.NOTIFY_TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const texto = [
    `Reelforge: ${evento.type}`,
    evento.title ? `Arquivo: ${evento.title}` : null,
    evento.jobId ? `Job: ${evento.jobId}` : null,
    evento.detail ? `Detalhe: ${evento.detail}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: texto }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return response.ok;
}

/**
 * Notifica um evento da fila nos canais configurados.
 * event: { type: "failed"|"needs_review"|"published", jobId, title, detail }
 *
 * Variáveis de ambiente (todas opcionais):
 *   NOTIFY_WEBHOOK_URL — POST JSON { type, jobId, title, detail, at }
 *   NOTIFY_TELEGRAM_TOKEN + NOTIFY_TELEGRAM_CHAT_ID — sendMessage da API do Telegram
 *
 * Retorna { notified: boolean, channels: string[] } — channels lista apenas os
 * canais que confirmaram entrega (HTTP 2xx). Sem variáveis configuradas,
 * retorna { notified: false, channels: [] }.
 */
export async function notifyEvent(event) {
  const evento = eventoNormalizado(event);
  const channels = [];
  try {
    if (await notifyWebhook(evento)) channels.push("webhook");
  } catch {
    // webhook indisponível/timeout: segue para o próximo canal
  }
  try {
    if (await notifyTelegram(evento)) channels.push("telegram");
  } catch {
    // Telegram indisponível/timeout: notificação silenciosamente descartada
  }
  return { notified: channels.length > 0, channels };
}
