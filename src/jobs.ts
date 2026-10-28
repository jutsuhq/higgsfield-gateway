import type { JobRow } from "./db";
import { GatewayError, type Env } from "./env";
import { presign } from "./media";
import { MODELS, type JobSpec, type SourceVideo } from "./models";

export interface Sources {
  video: SourceVideo;
  imageKeys: string[];
}

/** The job's video and images, which must belong to `clientId` (trends belong to everyone). */
export async function loadSources(db: D1Database, clientId: string, spec: JobSpec): Promise<Sources> {
  let video: SourceVideo | null;
  if ("trendId" in spec.video) {
    video = await db
      .prepare("SELECT r2_key AS r2Key, seconds, width, height FROM trends WHERE id = ? AND active = 1")
      .bind(spec.video.trendId)
      .first<SourceVideo>();
  } else {
    video = await db
      .prepare("SELECT r2_key AS r2Key, seconds, width, height FROM inputs WHERE id = ? AND client_id = ? AND kind = 'video'")
      .bind(spec.video.inputId, clientId)
      .first<SourceVideo>();
  }
  if (!video) throw new GatewayError("not_found", "video");

  const imageKeys: string[] = [];
  for (const id of spec.imageInputIds) {
    const row = await db
      .prepare("SELECT r2_key FROM inputs WHERE id = ? AND client_id = ? AND kind = 'image'")
      .bind(id, clientId)
      .first<{ r2_key: string }>();
    if (!row) throw new GatewayError("not_found", `image ${id}`);
    imageKeys.push(row.r2_key);
  }
  return { video, imageKeys };
}

/** The endpoint and body to estimate and submit. Built once per job, so retries send the same bytes. */
export async function buildRequest(env: Env, job: JobRow): Promise<{ endpoint: string; body: object }> {
  const spec = JSON.parse(job.spec) as JobSpec;
  const { video, imageKeys } = await loadSources(env.DB, job.client_id, spec);
  const rules = MODELS[job.model];
  const urls = {
    video: await presign(env, video.r2Key),
    images: await Promise.all(imageKeys.map((key) => presign(env, key))),
  };
  return { endpoint: rules.endpoint, body: rules.body(urls, job.resolution, video, spec) };
}
