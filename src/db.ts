// D1 access for budgets, slots and job state. The SQL follows docs/architecture.md (Budget, Concurrency).

import { GatewayError, type JobStatus, type Model, type Resolution } from "./env";

export interface ClientRow {
  id: string;
  daily_cap_cents: number;
  max_job_cents: number;
  models: string;
  max_parallel: number;
}

export interface JobRow {
  id: string;
  client_id: string;
  client_job_id: string;
  model: Model;
  resolution: Resolution;
  spec: string;
  est_cents: number;
  max_cents: number;
  spent_cents: number | null;
  spend_day: string;
  hf_request: string | null;
  hf_correlation: string | null;
  hook_token: string;
  status: JobStatus;
  error: string | null;
  result_key: string | null;
  created_at: string;
  finished_at: string | null;
}

/** Statuses that still hold a reservation. */
const OPEN = "('reserved', 'submitted', 'timeout')";

export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10);

export async function getClient(db: D1Database, id: string): Promise<ClientRow | null> {
  return db.prepare("SELECT * FROM clients WHERE id = ?").bind(id).first<ClientRow>();
}

export async function getJob(db: D1Database, id: string, clientId?: string): Promise<JobRow | null> {
  return clientId === undefined
    ? db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>()
    : db.prepare("SELECT * FROM jobs WHERE id = ? AND client_id = ?").bind(id, clientId).first<JobRow>();
}

export interface NewJob {
  id: string;
  clientId: string;
  clientJobId: string;
  model: Model;
  resolution: Resolution;
  spec: string;
  estCents: number;
  maxCents: number;
  day: string;
  hookToken: string;
}

/**
 * Reserves `estCents` against the client's and the global daily cap and inserts the job, in one
 * transaction. Returns false when the client already has a job with this `clientJobId`.
 */
export async function reserveAndInsert(db: D1Database, job: NewJob, globalCapCents: number): Promise<boolean> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO spend (client_id, day, cap_cents)
           SELECT id, ?2, daily_cap_cents FROM clients WHERE id = ?1
           ON CONFLICT (client_id, day) DO UPDATE SET cap_cents = excluded.cap_cents`,
        )
        .bind(job.clientId, job.day),
      db
        .prepare(
          `INSERT INTO spend (client_id, day, cap_cents) VALUES ('_global', ?1, ?2)
           ON CONFLICT (client_id, day) DO UPDATE SET cap_cents = excluded.cap_cents`,
        )
        .bind(job.day, globalCapCents),
      db
        .prepare("UPDATE spend SET reserved_cents = reserved_cents + ?3 WHERE day = ?2 AND client_id IN (?1, '_global')")
        .bind(job.clientId, job.day, job.estCents),
      db
        .prepare(
          `INSERT INTO jobs (id, client_id, client_job_id, model, resolution, spec, est_cents, max_cents, spend_day, hook_token, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`,
        )
        .bind(job.id, job.clientId, job.clientJobId, job.model, job.resolution, job.spec, job.estCents, job.maxCents, job.day, job.hookToken),
    ]);
    return true;
  } catch (e) {
    const message = String(e);
    if (/budget_exceeded/.test(message)) throw new GatewayError("budget_exceeded");
    if (/UNIQUE constraint failed: jobs\.client_id/.test(message)) return false;
    throw e;
  }
}

export async function findByClientJobId(db: D1Database, clientId: string, clientJobId: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE client_id = ? AND client_job_id = ?").bind(clientId, clientJobId).first<JobRow>();
}

/**
 * Moves a reserved job to `submitted` when the client's share and the account's tier have room.
 * `gone` means the job left `reserved` some other way (canceled while waiting).
 */
export async function acquireSlot(db: D1Database, job: JobRow, concurrency: number): Promise<"acquired" | "busy" | "gone"> {
  const result = await db
    .prepare(
      `UPDATE jobs SET status = 'submitted'
       WHERE id = ?1 AND status = 'reserved'
         AND (SELECT COUNT(*) FROM jobs WHERE client_id = ?2 AND status IN ('submitted', 'timeout'))
             < (SELECT max_parallel FROM clients WHERE id = ?2)
         AND (SELECT COUNT(*) FROM jobs WHERE status IN ('submitted', 'timeout')) < ?3`,
    )
    .bind(job.id, job.client_id, concurrency)
    .run();
  if (result.meta.changes > 0) return "acquired";
  const status = (await getJob(db, job.id))?.status;
  // A retried step whose first run already took the slot.
  if (status === "submitted") return "acquired";
  return status === "reserved" ? "busy" : "gone";
}

/**
 * Moves the reservation from `est_cents` to `exactCents`. False when a cap would be exceeded, `lost`
 * when the job left `submitted` in the meantime (canceled while the price was being checked).
 */
export async function adjustReservation(db: D1Database, job: JobRow, exactCents: number): Promise<boolean | "lost"> {
  try {
    const [, update] = await db.batch([
      db
        .prepare(
          `UPDATE spend SET reserved_cents = reserved_cents + ?1
           WHERE day = ?2 AND client_id IN (?3, '_global')
             AND EXISTS (SELECT 1 FROM jobs WHERE id = ?4 AND status = 'submitted' AND est_cents = ?5)`,
        )
        .bind(exactCents - job.est_cents, job.spend_day, job.client_id, job.id, job.est_cents),
      db
        .prepare("UPDATE jobs SET est_cents = ?1 WHERE id = ?2 AND status = 'submitted' AND est_cents = ?3")
        .bind(exactCents, job.id, job.est_cents),
    ]);
    if ((update?.meta.changes ?? 0) > 0) return true;
    // A retried step whose first run already applied the new price.
    const current = await getJob(db, job.id);
    return current?.status === "submitted" && current.est_cents === exactCents ? true : "lost";
  } catch (e) {
    if (/budget_exceeded/.test(String(e))) return false;
    throw e;
  }
}

/**
 * Cancels a job that still waits for a slot, releasing its reservation in the same batch. False when
 * the job was submitted first: the guarded statements then change nothing, so no budget is released.
 */
export async function cancelReserved(db: D1Database, job: JobRow): Promise<boolean> {
  const [, update] = await db.batch([
    db
      .prepare(
        `UPDATE spend SET reserved_cents = reserved_cents - ?1
         WHERE day = ?2 AND client_id IN (?3, '_global')
           AND EXISTS (
             SELECT 1 FROM jobs
             WHERE id = ?4 AND status = 'reserved' AND hf_request IS NULL AND finished_at IS NULL
           )`,
      )
      .bind(job.est_cents, job.spend_day, job.client_id, job.id),
    db
      .prepare(
        `UPDATE jobs SET status = 'canceled', spent_cents = 0, finished_at = CURRENT_TIMESTAMP
         WHERE id = ?1 AND status = 'reserved' AND hf_request IS NULL AND finished_at IS NULL`,
      )
      .bind(job.id),
  ]);
  return (update?.meta.changes ?? 0) > 0;
}

export async function setRequest(db: D1Database, jobId: string, requestId: string, correlationId?: string) {
  await db
    .prepare("UPDATE jobs SET hf_request = ?, hf_correlation = ? WHERE id = ?")
    .bind(requestId, correlationId ?? null, jobId)
    .run();
}

/**
 * Closes the job: the reservation becomes `spentCents` of spend (0 releases it) and the job takes its
 * final status. A no-op when the job is already closed, so retried steps don't count twice.
 */
export async function settle(
  db: D1Database,
  job: JobRow,
  final: Exclude<JobStatus, "reserved" | "submitted" | "timeout">,
  spentCents: number,
  extra: { error?: string; resultKey?: string } = {},
): Promise<boolean> {
  const [, update] = await db.batch([
    db
      .prepare(
        `UPDATE spend SET reserved_cents = reserved_cents - ?1, spent_cents = spent_cents + ?2
         WHERE day = ?3 AND client_id IN (?4, '_global')
           AND EXISTS (SELECT 1 FROM jobs WHERE id = ?5 AND status IN ${OPEN})`,
      )
      .bind(job.est_cents, spentCents, job.spend_day, job.client_id, job.id),
    db
      .prepare(
        `UPDATE jobs SET status = ?1, spent_cents = ?2, error = ?3, result_key = COALESCE(?4, result_key),
           finished_at = CURRENT_TIMESTAMP
         WHERE id = ?5 AND status IN ${OPEN}`,
      )
      .bind(final, spentCents, extra.error ?? null, extra.resultKey ?? null, job.id),
  ]);
  return (update?.meta.changes ?? 0) > 0;
}

export const SUBMIT_UNCERTAIN = "submit_uncertain";

/** A submit attempt ended without an answer that says whether Higgsfield accepted it. */
export async function markSubmitUncertain(db: D1Database, jobId: string) {
  await db.prepare("UPDATE jobs SET error = ? WHERE id = ? AND status = 'submitted'").bind(SUBMIT_UNCERTAIN, jobId).run();
}

/** Past the time limit while Higgsfield still runs it: keeps the reservation and the slot for the cron. */
export async function markTimeout(db: D1Database, jobId: string) {
  await db.prepare("UPDATE jobs SET status = 'timeout' WHERE id = ? AND status = 'submitted'").bind(jobId).run();
}
