export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  GENERATE_JOB: Workflow<{ jobId: string }>;

  HF_BASE_URL: string;
  HF_CONCURRENCY: string;
  GLOBAL_DAILY_CAP_CENTS: string;
  WEBHOOK_BASE_URL: string;
  RESULT_HOSTS: string;
  MAX_RESULT_BYTES: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;

  HF_KEY: string;
  HF_WEBHOOK_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;

  // EVENTS_<CLIENT>: one queue per client, see eventsQueue().
  [binding: `EVENTS_${string}`]: Queue<JobEvent>;
}

export type Model = "genjutsu-light/motion-transfer" | "seedance-2.5/reference-to-video";
export type Resolution = "480p" | "720p" | "1080p";
export type AspectRatio = "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type JobStatus = "reserved" | "submitted" | "completed" | "failed" | "nsfw" | "canceled" | "timeout";

export interface JobEvent {
  jobId: string;
  clientJobId: string;
  status: JobStatus;
  usd: number;
  error?: string;
}

/** A client-facing failure. Its message is a stable code the client can switch on. */
export class GatewayError extends Error {
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GatewayError";
  }
}

export function eventsQueue(env: Env, clientId: string): Queue<JobEvent> {
  const queue = env[`EVENTS_${clientId.toUpperCase()}`];
  if (!queue) throw new Error(`No events queue bound for client ${clientId}`);
  return queue;
}

export const usd = (cents: number) => cents / 100;
