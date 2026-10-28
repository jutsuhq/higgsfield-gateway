import { WorkerEntrypoint } from "cloudflare:workers";
import {
  cancelReserved,
  findByClientJobId,
  getClient,
  getJob,
  reserveAndInsert,
  settle,
  utcDay,
  type ClientRow,
  type JobRow,
} from "./db";
import { eventsQueue, GatewayError, usd, type Env, type JobStatus, type Model, type Resolution } from "./env";
import { Higgsfield } from "./higgsfield";
import { loadSources } from "./jobs";
import { declaredType, inspectImage, inspectStoredVideo, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, streamToR2 } from "./media";
import { isModel, MODELS, type JobSpec } from "./models";
import { hfConcurrency, maxResultBytes, resultHosts } from "./result";

/** Uploads a client may add in 24 h. Nothing deletes unused inputs yet, so this bounds the table and R2. */
const MAX_PENDING_INPUTS = 50;

export interface CreateJobRequest extends JobSpec {
  clientJobId: string;
  model: Model;
  resolution: Resolution;
  maxUsd: number;
}

/**
 * The RPC surface clients reach through a Service Binding. Each client binds its own subclass, and the
 * subclass fixes `clientId`, so a client can't act as another one. Errors are `GatewayError`s whose
 * message starts with a stable code.
 */
abstract class ClientEntrypoint extends WorkerEntrypoint<Env> {
  protected abstract readonly clientId: string;

  /** List price in USD: an upper bound, before the exact quote the job gets before submit. */
  async estimate(req: { model: Model; resolution: Resolution; inputSeconds: number }): Promise<{ usd: number }> {
    if (!Number.isFinite(req.inputSeconds) || req.inputSeconds <= 0) {
      throw new GatewayError("invalid_input", "inputSeconds must be a finite number above 0");
    }
    await this.allowed(req.model, req.resolution);
    const video = { r2Key: "", seconds: req.inputSeconds, width: 9, height: 16 };
    return { usd: usd(MODELS[req.model].listPriceCents(req.resolution, video, { imageInputIds: [], video: { inputId: "" } })) };
  }

  /** Images are checked in memory (10 MB at most); videos stream to R2 and are read back by range. */
  async putInput(body: ReadableStream<Uint8Array>, contentType: string): Promise<{ inputId: string }> {
    const pending = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM inputs WHERE client_id = ? AND created_at >= datetime('now', '-1 day')",
    )
      .bind(this.clientId)
      .first<number>("n");
    if ((pending ?? 0) >= MAX_PENDING_INPUTS) {
      throw new GatewayError("over_quota", `at most ${MAX_PENDING_INPUTS} uploads in 24 hours`);
    }

    const id = crypto.randomUUID();
    const r2Key = `in/${id}`;
    const type = declaredType(contentType);
    let row: { kind: "image" | "video"; seconds: number | null; width: number; height: number };

    if (type === "video/mp4") {
      const size = await streamToR2(this.env.MEDIA, r2Key, body, MAX_VIDEO_BYTES, type);
      try {
        row = { kind: "video", ...(await inspectStoredVideo(this.env.MEDIA, r2Key, size)) };
      } catch (e) {
        await this.env.MEDIA.delete(r2Key);
        throw e;
      }
    } else {
      const bytes = await readCapped(body, MAX_IMAGE_BYTES);
      const image = inspectImage(bytes, type);
      await this.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: image.contentType } });
      row = { kind: "image", seconds: null, width: image.width, height: image.height };
    }

    await this.env.DB.prepare("INSERT INTO inputs (id, client_id, r2_key, kind, seconds, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, this.clientId, r2Key, row.kind, row.seconds, row.width, row.height)
      .run();
    return { inputId: id };
  }

  async createJob(req: CreateJobRequest): Promise<{ jobId: string; estUsd: number }> {
    if (typeof req.clientJobId !== "string" || !req.clientJobId || req.clientJobId.length > 200) {
      throw new GatewayError("invalid_input", "clientJobId must be 1–200 characters");
    }
    if (!(req.maxUsd > 0)) throw new GatewayError("invalid_input", "maxUsd must be positive");
    // A malformed spec fails here, not as a TypeError inside loadSources or the model rules.
    checkSpec(req);
    // A bad result or concurrency config fails here, before the client is charged, not at delivery.
    resultHosts(this.env.RESULT_HOSTS);
    maxResultBytes(this.env.MAX_RESULT_BYTES);
    hfConcurrency(this.env.HF_CONCURRENCY);
    const client = await this.allowed(req.model, req.resolution);
    // The Workflow emits through this queue; a missing binding would only surface after the job runs.
    eventsQueue(this.env, this.clientId);

    const existing = await findByClientJobId(this.env.DB, this.clientId, req.clientJobId);
    if (existing) return { jobId: existing.id, estUsd: usd(existing.est_cents) };

    const spec: JobSpec = { imageInputIds: req.imageInputIds ?? [], video: req.video, prompt: req.prompt, seedance: req.seedance };
    const { video } = await loadSources(this.env.DB, this.clientId, spec);
    const rules = MODELS[req.model];
    rules.validate(spec, video, spec.imageInputIds.length);

    const estCents = rules.listPriceCents(req.resolution, video, spec);
    const maxCents = Math.floor(req.maxUsd * 100);
    if (estCents > maxCents) throw new GatewayError("over_max_usd", `list price $${usd(estCents)}`);
    if (estCents > client.max_job_cents) throw new GatewayError("over_job_cap", `list price $${usd(estCents)}`);

    const jobId = crypto.randomUUID();
    const inserted = await reserveAndInsert(
      this.env.DB,
      {
        id: jobId,
        clientId: this.clientId,
        clientJobId: req.clientJobId,
        model: req.model,
        resolution: req.resolution,
        spec: JSON.stringify(spec),
        estCents,
        maxCents,
        day: utcDay(),
        hookToken: randomToken(),
      },
      Number(this.env.GLOBAL_DAILY_CAP_CENTS),
    );
    if (!inserted) {
      // A concurrent call with the same clientJobId won the race.
      const winner = await findByClientJobId(this.env.DB, this.clientId, req.clientJobId);
      return { jobId: winner!.id, estUsd: usd(winner!.est_cents) };
    }

    try {
      await this.env.GENERATE_JOB.create({ id: jobId, params: { jobId } });
    } catch (e) {
      const job = (await getJob(this.env.DB, jobId))!;
      await settle(this.env.DB, job, "failed", 0, { error: "workflow_start_failed" });
      throw e;
    }
    return { jobId, estUsd: usd(estCents) };
  }

  async getJob(jobId: string): Promise<{ status: JobStatus; usd?: number; error?: string }> {
    const job = await this.ownJob(jobId);
    return {
      status: job.status,
      ...(spentCents(job) !== undefined ? { usd: usd(spentCents(job)!) } : {}),
      ...(job.error ? { error: job.error } : {}),
    };
  }

  /** Effective while the job waits for a slot or is queued at Higgsfield. */
  async cancelJob(jobId: string): Promise<void> {
    const job = await this.ownJob(jobId);
    if (job.status === "reserved") {
      // One guarded batch: only the call that actually flips the job may release its budget.
      if (!(await cancelReserved(this.env.DB, job))) throw new GatewayError("not_cancelable", "the job left the queue");
      return;
    }
    if (job.status !== "submitted" || !job.hf_request) throw new GatewayError("not_cancelable", job.status);
    const hf = new Higgsfield(this.env.HF_KEY, this.env.HF_BASE_URL);
    // The Workflow sees `canceled` on its next poll and releases the reservation.
    if ((await hf.cancel(job.hf_request)) === "started") throw new GatewayError("not_cancelable", "already running");
  }

  async openResult(jobId: string): Promise<ReadableStream> {
    const job = await this.ownJob(jobId);
    const object = job.result_key ? await this.env.MEDIA.get(job.result_key) : null;
    if (!object) throw new GatewayError("not_found", "result");
    return object.body;
  }

  /** Another client's job is `not_found`, the same as a missing one, so ids can't be probed. */
  private async ownJob(jobId: string): Promise<JobRow> {
    const job = await getJob(this.env.DB, String(jobId), this.clientId);
    if (!job) throw new GatewayError("not_found", "job");
    return job;
  }

  private async allowed(model: Model, resolution: Resolution): Promise<ClientRow> {
    const client = await getClient(this.env.DB, this.clientId);
    if (!client) throw new GatewayError("unknown_client", this.clientId);
    const models = JSON.parse(client.models) as Record<string, string[]>;
    if (!isModel(model) || !models[model]?.includes(resolution)) {
      throw new GatewayError("model_not_allowed", `${model} at ${resolution}`);
    }
    return client;
  }
}

export class BotEntrypoint extends ClientEntrypoint {
  protected readonly clientId = "bot";
}

export class WebEntrypoint extends ClientEntrypoint {
  protected readonly clientId = "web";
}

/** What the job costs once it is closed, or will cost once past its time limit; undefined while it runs. */
function spentCents(job: JobRow): number | undefined {
  if (job.status === "timeout") return job.est_cents;
  return job.spent_cents ?? undefined;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rejects a malformed spec before D1 or R2 is touched: a missing video would throw a TypeError in loadSources. */
function checkSpec(req: CreateJobRequest): void {
  const imageInputIds: unknown = req.imageInputIds;
  if (imageInputIds !== undefined && (!Array.isArray(imageInputIds) || imageInputIds.some((id) => typeof id !== "string" || !id))) {
    throw new GatewayError("invalid_input", "imageInputIds must be an array of non-empty ids");
  }

  const video: unknown = req.video;
  if (typeof video !== "object" || video === null) {
    throw new GatewayError("invalid_input", "video must be { trendId } or { inputId }");
  }
  const { trendId, inputId } = video as { trendId?: unknown; inputId?: unknown };
  const trend = typeof trendId === "string" && trendId.length > 0;
  const input = typeof inputId === "string" && inputId.length > 0;
  if (trend === input) throw new GatewayError("invalid_input", "video must name exactly one of trendId or inputId");

  if (req.prompt !== undefined && typeof req.prompt !== "string") {
    throw new GatewayError("invalid_input", "prompt must be a string");
  }
  const seedance: unknown = req.seedance;
  if (seedance !== undefined && (typeof seedance !== "object" || seedance === null || Array.isArray(seedance))) {
    throw new GatewayError("invalid_input", "seedance must be an object");
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw new GatewayError("invalid_input", `the file is larger than ${max / 1024 / 1024} MB`);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
