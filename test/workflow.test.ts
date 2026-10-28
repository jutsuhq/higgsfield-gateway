import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJob } from "../src/db";
import { reconcile } from "../src/reconcile";
import { bot, higgsfield, json, mockFetch, resetDb, resultFile, seedClient, seedInputs, spend } from "./helpers";

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
    expect(new URL(body.video_url).searchParams.get("X-Amz-Expires")).toBe("7200");
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
    status = { status: "completed", video: { url: "https://d8j0ntlcm91z4.cloudfront.net/late.mp4" } };
    mockFetch(higgsfield({ status }));
    await reconcile(env);
    expect(await getJob(env.DB, jobId)).toMatchObject({ status: "completed", spent_cents: 50, error: "finished_after_timeout" });
    expect(await spend("bot")).toEqual({ reserved: 0, spent: 50 });
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

  async function seedJob() {
    const id = crypto.randomUUID();
    const token = "ab".repeat(24);
    await env.DB.prepare(
      `INSERT INTO jobs (id, client_id, client_job_id, model, resolution, spec, est_cents, max_cents, spend_day, hook_token, status)
       VALUES (?, 'bot', ?, 'genjutsu-light/motion-transfer', '480p', '{}', 50, 100, '2026-10-26', ?, 'completed')`,
    )
      .bind(id, id, token)
      .run();
    return { path: `/hf/webhook/${id}/${token}`, id, token };
  }

  it("accepts a signed delivery once and ignores repeats", async () => {
    const { path } = await seedJob();
    expect((await post(path)).status).toBe(200);
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
