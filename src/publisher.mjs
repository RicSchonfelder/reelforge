import path from "node:path";
import { getConfig } from "./env.mjs";
import { validateMedia } from "./media.mjs";
import { InstagramClient, MetaApiError } from "./meta-api.mjs";
import { notifyEvent } from "./notify.mjs";
import { updateJob } from "./queue.mjs";
import { startTemporaryMediaHost } from "./temporary-media-host.mjs";

export async function processJob(
  job,
  {
    client: suppliedClient,
    mediaHostFactory = startTemporaryMediaHost,
  } = {},
) {
  const config = getConfig({ requireCredentials: !suppliedClient });
  let validation;
  try {
    validation = validateMedia(job.filePath, {
      ffprobePath: config.ffprobePath,
    });
  } catch (validationError) {
    // Arquivo removido/ilegível entre o agendamento e a publicação não pode
    // derrubar o agendador — marca o job e segue para o próximo.
    notifyEvent({
      type: "failed",
      jobId: job.id,
      title: path.basename(job.filePath),
      detail: `Validação impossível: ${validationError.message}`,
    }).catch(() => {});
    return updateJob(job.id, {
      status: "failed",
      error: `Validação impossível: ${validationError.message}`,
    });
  }

  if (!validation.ok) {
    notifyEvent({
      type: "failed",
      jobId: job.id,
      title: path.basename(job.filePath),
      detail: validation.errors.join(" "),
    }).catch(() => {});
    return updateJob(job.id, {
      status: "failed",
      error: validation.errors.join(" "),
      validation,
    });
  }

  updateJob(job.id, {
    status: "uploading",
    attempts: (job.attempts || 0) + 1,
    validation,
  });

  const client =
    suppliedClient ||
    new InstagramClient({
      igUserId: config.igUserId,
      accessToken: config.accessToken,
      apiVersion: config.apiVersion,
    });

  let mediaHost;
  try {
    mediaHost = await mediaHostFactory({ filePath: job.filePath });
    const container = await client.createReelContainer({
      videoUrl: mediaHost.videoUrl,
      caption: job.caption,
      shareToFeed: job.shareToFeed,
      thumbOffsetMs: job.thumbOffsetMs,
    });
    updateJob(job.id, {
      containerId: container.containerId,
    });

    updateJob(job.id, { status: "processing" });

    await client.waitUntilReady(container.containerId);
    updateJob(job.id, { status: "publishing" });

    const published = await client.publishContainer(container.containerId);
    const media = await client.getPublishedMedia(published.id);

    notifyEvent({
      type: "published",
      jobId: job.id,
      title: path.basename(job.filePath),
      detail: media.permalink || null,
    }).catch(() => {});
    return updateJob(job.id, {
      status: "published",
      mediaId: published.id,
      permalink: media.permalink ?? null,
      publishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (error) {
    const attempt = (job.attempts || 0) + 1;
    const transientNetworkFailure = !(error instanceof MetaApiError)
      && /temporário|EACCES|ENOTFOUND|ECONN(?:RESET|REFUSED)|ETIMEDOUT|fetch failed/i.test(error.message);
    if (transientNetworkFailure && attempt < 3) {
      return updateJob(job.id, {
        status: "queued",
        publishAt: new Date(Date.now() + 60_000).toISOString(),
        error: `Falha temporária de rede. Nova tentativa automática ${attempt + 1}/3 em um minuto.`,
      });
    }
    const needsReview = error instanceof MetaApiError && error.ambiguous;
    notifyEvent({
      type: needsReview ? "needs_review" : "failed",
      jobId: job.id,
      title: path.basename(job.filePath),
      detail: error.message,
    }).catch(() => {});
    return updateJob(job.id, {
      status: needsReview ? "needs_review" : "failed",
      error: error.message,
      apiPayload: error instanceof MetaApiError ? error.payload ?? null : null,
    });
  } finally {
    await mediaHost?.stop().catch(() => {});
  }
}
