// Minimal REST client for api.higgsfield.ai: estimate, submit, status, cancel, delete.
// Behaviour is documented in docs/higgsfield-api.md.

export type HfErrorKind =
  | "busy" // concurrency limit or full queue: retry later
  | "unavailable" // 423, 503: model blocked or not ready
  | "server" // 5xx
  | "unauthorized" // 401
  | "insufficient_funds" // 403
  | "not_found" // 404
  | "idempotency_mismatch" // 422 for a reused Idempotency-Key with another body
  | "invalid"; // other 4xx

export class HiggsfieldError extends Error {
  constructor(
    readonly kind: HfErrorKind,
    readonly status: number,
    detail: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Higgsfield ${status} ${kind}: ${detail}`);
    this.name = "HiggsfieldError";
  }

  get retryable() {
    return this.kind === "busy" || this.kind === "unavailable" || this.kind === "server";
  }
}

export type HfStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";

export interface StatusAnswer {
  status: HfStatus;
  videoUrl?: string;
  error?: string;
}

export interface Submitted {
  requestId: string;
  correlationId?: string;
}

export const TERMINAL: ReadonlySet<HfStatus> = new Set(["completed", "failed", "nsfw", "canceled"]);

const CONCURRENCY_LIMIT = /Maximum number of concurrent requests/i;

export class Higgsfield {
  private readonly base: string;

  constructor(
    private readonly key: string,
    baseUrl: string,
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  /** Price in cents of exactly this body, rounded up. Charges nothing. */
  async estimate(endpoint: string, body: object): Promise<number> {
    const answer = await this.call<{ usd: string }>("POST", `/estimate/${endpoint}`, body);
    return usdToCents(answer.usd);
  }

  async submit(
    endpoint: string,
    body: object,
    opts: { idempotencyKey: string; webhookUrl: string; expiresAfterSeconds: number },
  ): Promise<Submitted> {
    const path = `/${endpoint}?hf_webhook=${encodeURIComponent(opts.webhookUrl)}`;
    const res = await this.send("POST", path, body, {
      "Idempotency-Key": opts.idempotencyKey,
      "Hf-Expires-After": String(opts.expiresAfterSeconds),
    });
    const answer = (await res.json()) as { request_id: string };
    return { requestId: answer.request_id, correlationId: res.headers.get("X-Correlation-ID") ?? undefined };
  }

  async status(requestId: string): Promise<StatusAnswer> {
    const answer = await this.call<{ status: string; video?: { url?: string }; error?: string }>(
      "GET",
      `/requests/${encodeURIComponent(requestId)}/status`,
    );
    return { status: normalizeStatus(answer.status), videoUrl: answer.video?.url, error: answer.error ?? undefined };
  }

  /** `canceled` while queued (202); `started` once processing has begun (400). */
  async cancel(requestId: string): Promise<"canceled" | "started"> {
    try {
      await this.send("POST", `/requests/${encodeURIComponent(requestId)}/cancel`);
      return "canceled";
    } catch (e) {
      if (e instanceof HiggsfieldError && e.status === 400) return "started";
      throw e;
    }
  }

  /** Deletes the request's data on Higgsfield. A request already gone counts as deleted. */
  async delete(requestId: string): Promise<void> {
    try {
      await this.send("DELETE", `/requests/${encodeURIComponent(requestId)}`);
    } catch (e) {
      if (!(e instanceof HiggsfieldError && e.kind === "not_found")) throw e;
    }
  }

  private async call<T>(method: string, path: string, body?: object): Promise<T> {
    return (await (await this.send(method, path, body)).json()) as T;
  }

  private async send(method: string, path: string, body?: object, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: `Key ${this.key}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await toError(res);
    return res;
  }
}

async function toError(res: Response): Promise<HiggsfieldError> {
  const text = await res.text();
  let detail = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text) as { detail?: unknown };
    if (parsed.detail !== undefined) detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail);
  } catch {
    // not JSON: keep the text
  }
  const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
  const s = res.status;
  // The docs describe 429 account_queue_full; the live API answers 400 with this message instead.
  if (s === 429 || (s === 400 && CONCURRENCY_LIMIT.test(detail))) return new HiggsfieldError("busy", s, detail, retryAfter);
  if (s === 401) return new HiggsfieldError("unauthorized", s, detail);
  if (s === 403) return new HiggsfieldError("insufficient_funds", s, detail);
  if (s === 404) return new HiggsfieldError("not_found", s, detail);
  if (s === 422 && /Idempotency-Key/i.test(detail)) return new HiggsfieldError("idempotency_mismatch", s, detail);
  if (s === 423 || s === 503) return new HiggsfieldError("unavailable", s, detail, retryAfter);
  if (s >= 500) return new HiggsfieldError("server", s, detail, retryAfter);
  return new HiggsfieldError("invalid", s, detail);
}

function normalizeStatus(status: string): HfStatus {
  if (status === "cancelled") return "canceled";
  if (status === "queued" || TERMINAL.has(status as HfStatus)) return status as HfStatus;
  // in_progress, or a stage added later: keep polling it.
  return "in_progress";
}

/** "0.094" → 10. Parsed as a decimal string, so 0.10 is 10 cents, not 11. */
export function usdToCents(value: string): number {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new HiggsfieldError("server", 200, `unreadable price ${value}`);
  const fraction = match[2] ?? "";
  const cents = Number(match[1]) * 100 + Number(fraction.slice(0, 2).padEnd(2, "0"));
  return /[1-9]/.test(fraction.slice(2)) ? cents + 1 : cents;
}
