import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { WorkflowStep } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJob, settle, utcDay } from "../src/db";
import { Higgsfield } from "../src/higgsfield";
import { reconcile } from "../src/reconcile";
import { GenerateJob } from "../src/workflow";
import { bot, higgsfield, json, mockFetch, resetDb, RESULT_URL, resultFile, seedClient, seedInputs, spend } from "./helpers";

const SUBMIT_PATH = "/higgsfield/genjutsu-light/motion-transfer/v1.0";

let workflows: Awaited<ReturnType<typeof introspectWorkflow>>;
beforeEach(async () => {
  await resetDb();
  await seedClient("bot");
  workflows = await introspectWorkflow(env.GENERATE_JOB);
});
afterEach(async () => {
  await workflows.dispose();
  vi.restoreAllMocks();
});

async function startJob(maxUsd = 2) {
  const { trendId, imageId } = await seedInputs("bot");
  return bot().createJob({
    clientJobId: crypto.randomUUID(),
    model: "genjutsu-light/motion-transfer",
    resolution: "480p",
    imageInputIds: [imageId],
    video: { trendId },
    maxUsd,
  });
}

async function finished(status: "complete" | "errored" = "complete") {
  const [instance] = await workflows.get();
  await instance!.waitForStatus(status);
  return instance!;
}

/** The webhook arrives at once and no sleep or retry delay is real. */
async function fastForward() {
  await workflows.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.mockEvent({ type: "hf-done", payload: {} });
  });
}

/** Higgsfield answering every submit with `answer`, for the first `times` submits (all when omitted). */
const failingSubmit = (answer: () => Response, times = Infinity) => {
  let submits = 0;
  return (url: URL) => (url.pathname === SUBMIT_PATH && submits++ < times ? answer() : undefined);
};

const busyAnswer = () => json({ detail: "Maximum number of concurrent requests (4) has been reached" }, 400);

describe("GenerateJob", () => {
  it("runs a job end to end and settles at the exact price", async () => {
    await fastForward();
    const { calls } = mockFetch(higgsfield({ usd: "0.80" }), resultFile);
    const { jobId } = await startJob();
    await finished();

    const job = (await getJob(env.DB, jobId))!;
    expect(job).toMatchObject({ status: "completed", est_cents: 80, spent_cents: 80, hf_request: "req-1", hf_correlation: "corr-1" });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 80 });
    expect(await spend("_global")).toEqual({ reserved: 0, spent: 80 });
    expect((await env.MEDIA.head(`out/${jobId}.mp4`))?.size).toBe(1234);
    expect(await bot().getJob(jobId)).toEqual({ status: "completed", usd: 0.8 });

    const estimate = calls.find((c) => c.url.pathname.startsWith("/estimate/"))!;
    const submit = calls.find((c) => c.url.pathname === SUBMIT_PATH)!;
    expect(submit.body).toBe(estimate.body);
    expect(submit.headers.get("Idempotency-Key")).toBe(jobId);
    expect(submit.url.searchParams.get("hf_webhook")).toBe(`https://hf-gateway.example.com/hf/webhook/${jobId}/${job.hook_token}`);
    const body = JSON.parse(submit.body!);
    expect(body).toMatchObject({ prompt: "", resolution: "480p" });
    expect(body.image_urls).toHaveLength(1);
    expect(new URL(body.video_url).hostname).toBe("replace-with-account-id.r2.cloudflarestorage.com");
    expect(new URL(body.video_url).searchParams.get("X-Amz-Expires")).toBe("14400");
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname === "/requests/req-1")).toBe(true);
  });

  it("retries a busy submit with the same key and body", async () => {
    await fastForward();
    const { calls } = mockFetch(failingSubmit(busyAnswer, 1), higgsfield(), resultFile);
    const { jobId } = await startJob();
    await finished();

    const tries = calls.filter((c) => c.url.pathname === SUBMIT_PATH);
    expect(tries).toHaveLength(2);
    expect(tries[1]!.body).toBe(tries[0]!.body);
    expect(tries[1]!.headers.get("Idempotency-Key")).toBe(tries[0]!.headers.get("Idempotency-Key"));
    expect((await getJob(env.DB, jobId))!.status).toBe("completed");
  });

  it("releases the reservation when every submit is refused as busy", async () => {
    await fastForward();
    mockFetch(failingSubmit(busyAnswer), higgsfield());
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 0 });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 0 });
  });

  it("replays an uncertain submit with the same key until Higgsfield answers", async () => {
    await fastForward();
    // The first attempt and its 8 retries end in 500s; the first replay gets the request.
    const { calls } = mockFetch(failingSubmit(() => json({ detail: "boom" }, 500), 9), higgsfield(), resultFile);
    const { jobId } = await startJob();
    await finished();
    const keys = new Set(calls.filter((c) => c.url.pathname === SUBMIT_PATH).map((c) => c.headers.get("Idempotency-Key")));
    expect(keys).toEqual(new Set([jobId]));
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "completed", error: null, hf_request: "req-1" });
  });

  it("keeps the reservation when a submit's outcome stays unknown, and the cron counts it as spent", async () => {
    await fastForward();
    mockFetch(failingSubmit(() => json({ detail: "boom" }, 500)), higgsfield());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "timeout", error: "submit_uncertain", hf_request: null });
    expect(await spend("bot")).toEqual({ reserved: 50, spent: 0 });

    await reconcile(env);
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 50, error: "submit_uncertain" });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 50 });
  });

  it("fails before submit when the exact price is above maxUsd", async () => {
    await fastForward();
    const { calls } = mockFetch(higgsfield({ usd: "3.00" }));
    const { jobId } = await startJob(2);
    await finished();

    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 0 });
    expect((await getJob(env.DB, jobId))!.error).toMatch(/^over_max_usd/);
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 0 });
    expect(calls.some((c) => c.url.pathname === SUBMIT_PATH)).toBe(false);
  });

  it("fails before submit when the exact price is above the operator's per-job cap", async () => {
    await fastForward();
    await env.DB.prepare("UPDATE clients SET max_job_cents = 300 WHERE id = 'bot'").run();
    const { calls } = mockFetch(higgsfield({ usd: "4.60" }));
    const { jobId } = await startJob(5);
    await finished();

    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 0 });
    expect((await getJob(env.DB, jobId))!.error).toMatch(/^over_job_cap/);
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 0 });
    expect(calls.some((c) => c.url.pathname === SUBMIT_PATH)).toBe(false);
  });

  it("releases the reservation of an nsfw result", async () => {
    await fastForward();
    mockFetch(higgsfield({ status: { status: "nsfw" } }));
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "nsfw", spent_cents: 0 });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 0 });
  });

  it("refuses a result from an unexpected host but counts it as spent", async () => {
    await fastForward();
    mockFetch(higgsfield({ status: { status: "completed", video: { url: "https://evil.example/x.mp4" } } }));
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 50, error: "unexpected_result_host: evil.example" });
  });

  it("downloads a result that has no Content-Length", async () => {
    await fastForward();
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4321));
        controller.close();
      },
    });
    mockFetch(higgsfield(), (url) => (url.toString() === RESULT_URL ? new Response(chunks) : undefined));
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "completed", spent_cents: 50 });
    expect((await env.MEDIA.head(`out/${jobId}.mp4`))?.size).toBe(4321);
  });

  it("refuses a redirect instead of following it", async () => {
    await fastForward();
    const { calls } = mockFetch(higgsfield(), (url) =>
      url.toString() === RESULT_URL ? new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/" } }) : undefined,
    );
    const { jobId } = await startJob();
    await finished();
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "failed", spent_cents: 50, error: "result_redirect: 302" });
    expect(calls.find((c) => c.url.toString() === RESULT_URL)!.redirect).toBe("manual");
  });

  it("settles as failed when the download never succeeds", async () => {
    await fastForward();
    mockFetch(higgsfield(), (url) => {
      if (url.toString() === RESULT_URL) throw new Error("network down");
    });
    const { jobId } = await startJob();
    await finished();
    const job = (await getJob(env.DB, jobId))!;
    expect(job).toMatchObject({ status: "failed", spent_cents: 50 });
    expect(job.error).toMatch(/^deliver_failed: network down/);
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 50 });
  });

  it("emits nothing when the job was settled by the cron first", async () => {
    const { trendId, imageId } = await seedInputs("bot");
    const { jobId } = await bot().createJob({
      clientJobId: crypto.randomUUID(),
      model: "genjutsu-light/motion-transfer",
      resolution: "480p",
      imageInputIds: [imageId],
      video: { trendId },
      maxUsd: 2,
    });
    // Reconcile closed the job before the Workflow's own settle step ran.
    await settle(env.DB, (await getJob(env.DB, jobId))!, "canceled", 0);

    // `finish` only reads `this.env`, so the prototype can run without the Workflow's constructor.
    const { finish } = GenerateJob.prototype as unknown as {
      finish(
        this: { env: typeof env },
        step: WorkflowStep,
        jobId: string,
        hf: Higgsfield,
        final: string,
        cents: number,
      ): Promise<{ status: string }>;
    };
    const step = {
      do: async (_name: string, configOrFn: unknown, fn?: unknown) => {
        const run = (typeof configOrFn === "function" ? configOrFn : fn) as () => Promise<unknown>;
        return run();
      },
    } as unknown as WorkflowStep;
    const hf = new Higgsfield(env.HF_KEY, env.HF_BASE_URL);

    expect(await finish.call({ env }, step, jobId, hf, "completed", 50)).toEqual({ status: "already_settled" });
    expect((await getJob(env.DB, jobId))!.status).toBe("canceled");
  });

  it("keeps the reservation of a job past its time limit, and the cron settles it", async () => {
    await workflows.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      for (let round = 0; round < 18; round++) await m.forceEventTimeout({ name: `hook ${round}` });
    });
    let status: unknown = { status: "in_progress" };
    mockFetch(higgsfield({ cancel: 400, status: { status: "in_progress" } }), (url) =>
      url.pathname.endsWith("/status") ? json(status) : undefined,
    );
    const { jobId } = await startJob();
    await finished();
    expect((await getJob(env.DB, jobId))!.status).toBe("timeout");
    expect(await spend("bot")).toEqual({ reserved: 50, spent: 0 });
    expect(await bot().getJob(jobId)).toEqual({ status: "timeout", usd: 0.5 });

    vi.restoreAllMocks();
    status = { status: "completed", video: { url: "https://results.example.com/late.mp4" } };
    mockFetch(higgsfield({ status }));
    await reconcile(env);
    // The client already saw `timeout`: the late result is discarded and never labelled `completed`.
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "expired", spent_cents: 50, error: "finished_after_timeout" });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 50 });
  });

  it("delivers a job whose Workflow died before the result was copied", async () => {
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO spend (client_id, day, cap_cents, reserved_cents) VALUES ('bot', ?, 1000, 50), ('_global', ?, 5000, 50)",
      ).bind(utcDay(), utcDay()),
      env.DB.prepare(
        `INSERT INTO jobs (id, client_id, client_job_id, model, resolution, spec, est_cents, max_cents, spend_day, hook_token, status, hf_request, created_at)
         VALUES (?, 'bot', ?, 'genjutsu-light/motion-transfer', '480p', '{}', 50, 100, ?, ?, 'submitted', 'req-lost', datetime('now', '-4 hours'))`,
      ).bind(id, id, utcDay(), "ab".repeat(24)),
    ]);
    mockFetch(higgsfield(), resultFile);
    await reconcile(env);

    expect(await getJob(env.DB, id)).toMatchObject({
      status: "completed",
      spent_cents: 50,
      error: "workflow_lost",
      result_key: `out/${id}.mp4`,
    });
    expect((await env.MEDIA.head(`out/${id}.mp4`))?.size).toBe(1234);
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 50 });
  });

  it("reconciles the oldest stuck jobs first", async () => {
    const insert = env.DB.prepare(
      `INSERT INTO jobs (id, client_id, client_job_id, model, resolution, spec, est_cents, max_cents, spend_day, hook_token, status, hf_request, created_at)
       VALUES (?, 'bot', ?, 'genjutsu-light/motion-transfer', '480p', '{}', 50, 100, ?, ?, 'submitted', ?, datetime('now', '-4 hours', ?))`,
    );
    const ids = Array.from({ length: 51 }, () => crypto.randomUUID());
    await env.DB.batch(ids.map((id, i) => insert.bind(id, id, utcDay(), "ab".repeat(24), `req-${i}`, `+${i} seconds`)));

    mockFetch(higgsfield({ status: { status: "failed" } }));
    await reconcile(env);

    const { results } = await env.DB.prepare("SELECT id, status FROM jobs ORDER BY created_at").all<{ id: string; status: string }>();
    expect(results).toHaveLength(51);
    expect(results.slice(0, 50).every((row) => row.status === "failed")).toBe(true);
    // The newest of the 51 is the one left for the next run.
    expect(results[50]).toEqual({ id: ids[50], status: "submitted" });
  });
});

describe("webhook route", () => {
  const secret = "test-webhook-secret";

  async function post(path: string, opts: { id?: string; signWith?: string; timestamp?: number } = {}) {
    const body = '{"request_id":"req-1","status":"completed"}';
    const id = opts.id ?? "msg_1";
    const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(opts.signWith ?? secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
    return exports.default.fetch(`https://hf-gateway.example.com${path}`, {
      method: "POST",
      body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`,
      },
    });
  }

  async function seedJob(status = "submitted") {
    const id = crypto.randomUUID();
    const token = "ab".repeat(24);
    await env.DB.prepare(
      `INSERT INTO jobs (id, client_id, client_job_id, model, resolution, spec, est_cents, max_cents, spend_day, hook_token, status)
       VALUES (?, 'bot', ?, 'genjutsu-light/motion-transfer', '480p', '{}', 50, 100, '2026-10-26', ?, ?)`,
    )
      .bind(id, id, token, status)
      .run();
    return { path: `/hf/webhook/${id}/${token}`, id, token };
  }

  it("accepts a signed delivery once and ignores repeats", async () => {
    const { path } = await seedJob();
    expect((await post(path)).status).toBe(200);
    expect((await post(path)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(1);
  });

  it("does not consume a delivery that arrives before the job is submitted", async () => {
    const { path, id } = await seedJob("reserved");
    expect((await post(path)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(0);

    await env.DB.prepare("UPDATE jobs SET status = 'submitted' WHERE id = ?").bind(id).run();
    expect((await post(path)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(1);
  });

  it("refuses bad signatures, stale timestamps, wrong tokens and other routes", async () => {
    const { path, id } = await seedJob();
    expect((await post(path, { signWith: "other" })).status).toBe(401);
    expect((await post(path, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
    expect((await post(`/hf/webhook/${id}/${"cd".repeat(24)}`)).status).toBe(404);
    expect((await exports.default.fetch("https://hf-gateway.example.com/")).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(0);
  });
});
