// Hourly cron: settles jobs whose Workflow died, and jobs past their time limit, against Higgsfield.

import { settle, SUBMIT_UNCERTAIN, type JobRow } from "./db";
import { eventsQueue, usd, type Env } from "./env";
import { Higgsfield, TERMINAL } from "./higgsfield";

const ALIVE = new Set(["queued", "running", "waiting", "paused", "waitingForPause"]);

export async function reconcile(env: Env): Promise<void> {
  const hf = new Higgsfield(env.HF_KEY, env.HF_BASE_URL);
  const { results } = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE status = 'timeout'
        OR (status IN ('reserved', 'submitted') AND created_at < datetime('now', '-3 hours'))
     LIMIT 50`,
  ).all<JobRow>();

  for (const job of results) {
    try {
      await reconcileJob(env, hf, job);
    } catch (e) {
      console.error(`reconcile ${job.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await env.DB.prepare("DELETE FROM webhook_events WHERE received_at < datetime('now', '-7 days')").run();
}

async function reconcileJob(env: Env, hf: Higgsfield, job: JobRow): Promise<void> {
  const timedOut = job.status === "timeout";
  if (!timedOut && (await workflowAlive(env, job.id))) return;

  if (!job.hf_request) {
    if (timedOut && job.error === SUBMIT_UNCERTAIN) {
      // Higgsfield may have charged for a request we never learned about: count it as spent, so the
      // caps stay safe, and leave a log line to check against GET /models/usage.
      console.error(`job ${job.id}: submit outcome unknown, counted as spent ($${usd(job.est_cents)})`);
      await settle(env.DB, job, "failed", job.est_cents, { error: SUBMIT_UNCERTAIN });
      return;
    }
    if (await settle(env.DB, job, "failed", 0, { error: "lost_before_submit" })) await emit(env, job, "failed", 0, "lost_before_submit");
    return;
  }

  const answer = await hf.status(job.hf_request);
  if (!TERMINAL.has(answer.status)) return;
  const spent = answer.status === "completed" ? job.est_cents : 0;
  const final = answer.status as Exclude<typeof answer.status, "queued" | "in_progress">;
  // A timed-out job's client was told and refunded its user already; its late result is discarded.
  const error = timedOut ? "finished_after_timeout" : "workflow_lost";
  if (await settle(env.DB, job, final, spent, { error })) {
    if (!timedOut) await emit(env, job, final, spent, error);
    await hf.delete(job.hf_request);
  }
}

async function workflowAlive(env: Env, jobId: string): Promise<boolean> {
  try {
    const instance = await env.GENERATE_JOB.get(jobId);
    return ALIVE.has((await instance.status()).status);
  } catch {
    return false;
  }
}

async function emit(env: Env, job: JobRow, status: "completed" | "failed" | "nsfw" | "canceled", spentCents: number, error: string) {
  await eventsQueue(env, job.client_id).send({ jobId: job.id, clientJobId: job.client_job_id, status, usd: usd(spentCents), error });
}
