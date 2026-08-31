import fs from "node:fs";

export class MetaApiError extends Error {
  constructor(message, { status, payload, ambiguous = false } = {}) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.payload = payload;
    this.ambiguous = ambiguous;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const apiMessage =
      payload?.error?.error_user_msg ||
      payload?.error?.message ||
      payload?.message ||
      `HTTP ${response.status}`;
    throw new MetaApiError(apiMessage, {
      status: response.status,
      payload,
    });
  }

  return payload;
}

export class InstagramClient {
  constructor({ igUserId, accessToken, apiVersion = "v25.0", fetchImpl = fetch }) {
    this.igUserId = igUserId;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.fetch = fetchImpl;
    this.graphBase = `https://graph.instagram.com/${apiVersion}`;
  }

  async graphRequest(path, { method = "GET", body } = {}) {
    const response = await this.fetch(`${this.graphBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body,
      // Sem timeout, undici segura a conexão por ~5 min antes de desistir.
      signal: AbortSignal.timeout(15_000),
    });
    return parseResponse(response);
  }

  async createReelContainer({
    videoUrl,
    caption,
    shareToFeed = true,
    thumbOffsetMs,
  }) {
    if (!/^https:\/\//i.test(videoUrl || "")) {
      throw new MetaApiError("A publicação exige uma URL HTTPS temporária para o vídeo.");
    }
    const body = new URLSearchParams({
      media_type: "REELS",
      video_url: videoUrl,
      caption,
      share_to_feed: String(shareToFeed),
    });
    if (Number.isFinite(thumbOffsetMs)) {
      body.set("thumb_offset", String(Math.max(0, Math.round(thumbOffsetMs))));
    }

    const payload = await this.graphRequest(`/${this.igUserId}/media`, {
      method: "POST",
      body,
    });
    if (!payload.id) throw new MetaApiError("A Meta não retornou o ID do container.");

    return { containerId: payload.id };
  }

  async uploadVideo({ uploadUri, filePath }) {
    const stat = fs.statSync(filePath);
    const stream = fs.createReadStream(filePath);
    let response;

    try {
      response = await this.fetch(uploadUri, {
        method: "POST",
        headers: {
          Authorization: `OAuth ${this.accessToken}`,
          offset: "0",
          file_size: String(stat.size),
          "Content-Length": String(stat.size),
          "Content-Type": "application/octet-stream",
        },
        body: stream,
        duplex: "half",
      });
    } catch (error) {
      // Sem o destroy, o ReadStream fica com handle aberto quando o fetch falha.
      stream.destroy();
      throw new MetaApiError(
        `A conexão caiu durante o envio: ${error.message}. O trabalho foi pausado para evitar publicação duplicada.`,
        { ambiguous: true },
      );
    }

    // Lê o body ANTES de destruir o stream: destruir antes faz o
    // response.text() falhar e esconde o erro real devolvido pela Meta.
    const text = response.ok ? null : await response.text().catch(() => "");
    stream.destroy();
    if (!response.ok) {
      const payload = (() => {
        try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
      })();
      const apiMessage = payload?.error?.error_user_msg || payload?.error?.message || `HTTP ${response.status}`;
      throw new MetaApiError(apiMessage, { status: response.status, payload });
    }
    return parseResponse(response);
  }

  async getContainerStatus(containerId) {
    return this.graphRequest(
      `/${containerId}?fields=status_code,status`,
    );
  }

  async waitUntilReady(containerId, { timeoutMs = 15 * 60_000, intervalMs = 5_000 } = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const payload = await this.getContainerStatus(containerId);
      if (payload.status_code === "FINISHED") return payload;
      if (["ERROR", "EXPIRED"].includes(payload.status_code)) {
        throw new MetaApiError(
          payload.status || `O processamento terminou com status ${payload.status_code}.`,
          { payload },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new MetaApiError(
      "A Meta não terminou o processamento em 15 minutos; o trabalho foi pausado para revisão.",
      { ambiguous: true },
    );
  }

  async publishContainer(containerId) {
    const body = new URLSearchParams({ creation_id: containerId });
    try {
      const payload = await this.graphRequest(`/${this.igUserId}/media_publish`, {
        method: "POST",
        body,
      });
      if (!payload.id) throw new MetaApiError("A Meta não retornou o ID da publicação.");
      return payload;
    } catch (error) {
      if (error instanceof MetaApiError) {
        error.ambiguous = true;
        throw error;
      }
      throw new MetaApiError(error.message, { ambiguous: true });
    }
  }

  async getPublishedMedia(mediaId) {
    return this.graphRequest(`/${mediaId}?fields=id,media_type,permalink,timestamp`);
  }
}
