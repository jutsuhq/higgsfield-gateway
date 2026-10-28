// One instance per job: slot → request → exact price → submit → wait → deliver → settle → emit → clean up.
// See docs/architecture.md (Request flow, Timeouts).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  acquireSlot,
  adjustReservation,
  getClient,
  getJob,
  markSubmitUncertain,
  markTimeout,
  setRequest,
  settle,
  SUBMIT_UNCERTAIN,
  type JobRow,
} from "./db";
import { eventsQueue, usd, type Env, type JobStatus } from "./env";
import { Higgsfield, HiggsfieldError, TERMINAL, type StatusAnswer } from "./higgsfield";
import { buildRequest } from "./jobs";
import { deliverResult, hfConcurrency, type Delivery } from "./result";

/** 2 hours of 30 s waits for a concurrency slot. */
const SLOT_ROUNDS = 240;
/** 18 rounds of up to 5 min: the 90-minute limit, counted in rounds so replays stay deterministic. */
const WAIT_ROUNDS = 18;
/** 1 hour of replays after an uncertain submit, inside the presigned URLs' 4 h lifetime. */
const REPLAY_ROUNDS = 3;
const HF_RETRIES = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" } as const;
const SUBMIT_RETRIES = { retries: { limit: 8, delay: "30 seconds", backoff: "exponential" }, timeout: "1 minute" } as const;
/** A result can be 100 MB: give the download its own long timeout, not the metadata step's minute. */
const DELIVER_RETRIES = { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" } as const;

type Final = Exclude<JobStatus, "reserved" | "submitted" | "timeout">;

export class GenerateJob extends WorkflowEntrypoint<Env, { jobId: string }> {
  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep): Promise<{ status: string }> {
    const { jobId } = event.payload;
    const db = this.env.DB;
    const hf = new Higgsfield(this.env.HF_KEY, this.env.HF_BASE_URL);
    const load = async () => {
      const job = await getJob(db, jobId);
      if (!job) throw new NonRetryableError(`job ${jobId} not found`);
      return job;
    };

    // 1. Concurrency slot.
    for (let round = 0; ; round++) {
      if (round === SLOT_ROUNDS) return this.finish(step, jobId, hf, "failed", 0, "no_slot");
      const slot = await step.do(`slot ${round}`, async () => acquireSlot(db, await load(), hfConcurrency(this.env.HF_CONCURRENCY)));
      if (slot === "gone") return { status: "gone" };
      if (slot === "acquired") break;
      await step.sleep(`wait for slot ${round}`, "30 seconds");
    }

    // 2. Presigned URLs and the body, persisted so that every later retry sends the same bytes.
    let request: { endpoint: string; body: object };
    try {
      request = await step.do("request", async () => buildRequest(this.env, await load()));
    } catch (e) {
      return this.finish(step, jobId, hf, "failed", 0, `request: ${message(e)}`);
    }

    // 3. Exact price for this body; the reservation moves to it, checked against both ceilings:
    // the client's maxUsd and the operator's max_job_cents, which only createJob saw so far.
    const price = await step.do(
      "price",
      HF_RETRIES,
      async (): Promise<{ cents: number } | { error: string } | { lost: true }> => {
        const job = await load();
        const client = await getClient(db, job.client_id);
        if (!client) return { error: `unknown_client: ${job.client_id}` };
        let cents: number;
        try {
          cents = await hf.estimate(request.endpoint, request.body);
        } catch (e) {
          if (e instanceof HiggsfieldError && !e.retryable) return { error: `estimate_refused: ${e.message}` };
          throw e;
        }
        if (cents > job.max_cents) return { error: `over_max_usd: exact price $${usd(cents)}` };
        if (cents > client.max_job_cents) return { error: `over_job_cap: exact price $${usd(cents)}` };
        const adjusted = await adjustReservation(db, job, cents);
        if (adjusted === "lost") return { lost: true };
        if (!adjusted) return { error: "budget_exceeded" };
        return { cents };
      },
    );
    if ("lost" in price) return { status: "lost" };
    if ("error" in price) return this.finish(step, jobId, hf, "failed", 0, price.error);

    // 4. Submit. Refusals that charge nothing (busy, unavailable) and answers whose outcome is unknown
    // (5xx, network) throw and are retried with the same key and body; other refusals end the job.
    const submitOnce = async (): Promise<{ requestId: string } | { error: string }> => {
      try {
        const answer = await hf.submit(request.endpoint, request.body, {
          idempotencyKey: jobId,
          webhookUrl: this.webhookUrl(await load()),
          expiresAfterSeconds: 86_400,
        });
        await setRequest(db, jobId, answer.requestId, answer.correlationId);
        return { requestId: answer.requestId };
      } catch (e) {
        if (e instanceof HiggsfieldError && !e.retryable) return { error: `submit_refused: ${e.message}` };
        if (!(e instanceof HiggsfieldError) || e.kind === "server") await markSubmitUncertain(db, jobId);
        throw e;
      }
    };
    let submitted: { requestId: string } | { error: string } | null = null;
    try {
      submitted = await step.do("submit", SUBMIT_RETRIES, submitOnce);
    } catch (e) {
      // Only refusals: nothing was accepted, so nothing is charged.
      const uncertain = await step.do("submit outcome", async () => (await getJob(db, jobId))?.error === SUBMIT_UNCERTAIN);
      if (!uncertain) {
        return this.finish(step, jobId, hf, "failed", 0, `submit_failed: ${message(e)}`);
      }
      // Higgsfield may have accepted one of the attempts. A replay with the same key returns that
      // request instead of a new one, so keep replaying for a while before giving up.
      for (let round = 0; round < REPLAY_ROUNDS && !submitted; round++) {
        await step.sleep(`wait to replay submit ${round}`, "20 minutes");
        try {
          submitted = await step.do(`replay submit ${round}`, HF_RETRIES, submitOnce);
        } catch {
          // Still failing: try again after the next wait.
        }
      }
      if (!submitted) return this.giveUp(step, jobId);
    }
    if ("error" in submitted) return this.finish(step, jobId, hf, "failed", 0, submitted.error);
    const { requestId } = submitted;

    // 5. Wait: the webhook only wakes the job; the status endpoint is the authority.
    for (let round = 0; round < WAIT_ROUNDS; round++) {
      try {
        await step.waitForEvent(`hook ${round}`, { type: "hf-done", timeout: "5 minutes" });
      } catch {
        // No webhook within 5 minutes: poll anyway.
      }
      const answer = await step.do(`status ${round}`, HF_RETRIES, () => hf.status(requestId));
      if (TERMINAL.has(answer.status)) return this.complete(step, jobId, hf, answer);
    }

    // Time limit: cancel if still queued, otherwise keep the reservation for the cron to settle.
    const cancel = await step.do("cancel", HF_RETRIES, () => hf.cancel(requestId));
    if (cancel === "canceled") return this.finish(step, jobId, hf, "canceled", 0);
    return this.giveUp(step, jobId);
  }

  /**
   * Higgsfield may still run (or have run) the job: keep the reservation and the slot, tell the client
   * to treat it as failed, and leave the final accounting to the reconcile cron.
   */
  private async giveUp(step: WorkflowStep, jobId: string): Promise<{ status: string }> {
    await step.do("mark timeout", () => markTimeout(this.env.DB, jobId));
    await step.do("emit timeout", async () => {
      const job = (await getJob(this.env.DB, jobId))!;
      await eventsQueue(this.env, job.client_id).send({
        jobId,
        clientJobId: job.client_job_id,
        status: "timeout",
        usd: usd(job.est_cents),
        ...(job.error ? { error: job.error } : {}),
      });
    });
    return { status: "timeout" };
  }

  private async complete(step: WorkflowStep, jobId: string, hf: Higgsfield, answer: StatusAnswer) {
    const job = (await getJob(this.env.DB, jobId))!;
    switch (answer.status) {
      case "completed": {
        // Paid either way, so a missing or refused result still counts as spent.
        if (!answer.videoUrl) return this.finish(step, jobId, hf, "failed", job.est_cents, "missing_result");
        const videoUrl = answer.videoUrl;
        let delivered: Delivery;
        try {
          delivered = await step.do("deliver", DELIVER_RETRIES, () => deliverResult(this.env, jobId, videoUrl));
        } catch (e) {
          // Settle explicitly instead of letting the instance die with the reservation held.
          return this.finish(step, jobId, hf, "failed", job.est_cents, `deliver_failed: ${message(e)}`);
        }
        if ("error" in delivered) return this.finish(step, jobId, hf, "failed", job.est_cents, delivered.error);
        return this.finish(step, jobId, hf, "completed", job.est_cents, undefined, delivered.resultKey);
      }
      case "nsfw":
        return this.finish(step, jobId, hf, "nsfw", 0);
      case "canceled":
        return this.finish(step, jobId, hf, "canceled", 0);
      default:
        return this.finish(step, jobId, hf, "failed", 0, answer.error ?? "failed");
    }
  }

  /** Settles the budget, tells the client, and deletes the request's data on Higgsfield. */
  private async finish(
    step: WorkflowStep,
    jobId: string,
    hf: Higgsfield,
    final: Final,
    spentCents: number,
    error?: string,
    resultKey?: string,
  ): Promise<{ status: string }> {
    const job = await step.do("settle", async () => {
      const job = (await getJob(this.env.DB, jobId))!;
      return (await settle(this.env.DB, job, final, spentCents, { error, resultKey })) ? job : null;
    });
    // Reconcile closed it first: a second terminal event would refund and capture the same job.
    if (!job) return { status: "already_settled" };
    await step.do("emit", async () => {
      await eventsQueue(this.env, job.client_id).send({
        jobId,
        clientJobId: job.client_job_id,
        status: final,
        usd: usd(spentCents),
        ...(error ? { error } : {}),
      });
    });
    const requestId = await step.do("request id", async () => (await getJob(this.env.DB, jobId))?.hf_request ?? null);
    if (requestId) {
      try {
        await step.do("clean up", HF_RETRIES, () => hf.delete(requestId));
      } catch {
        // Higgsfield deletes it after Hf-Expires-After (24 h) anyway.
      }
    }
    return { status: final };
  }

  private webhookUrl(job: JobRow): string {
    return `${this.env.WEBHOOK_BASE_URL.replace(/\/+$/, "")}/hf/webhook/${job.id}/${job.hook_token}`;
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
