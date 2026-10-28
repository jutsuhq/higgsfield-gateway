import type { Env } from "./env";
import { reconcile } from "./reconcile";
import { verifyWebhook } from "./webhook";

export { BotEntrypoint, WebEntrypoint } from "./rpc";
export { GenerateJob } from "./workflow";

const WEBHOOK_PATH = /^\/hf\/webhook\/([0-9a-f-]{36})\/([0-9a-f]{48})$/;
const MAX_WEBHOOK_BYTES = 64 * 1024;

export default {
  // The only public route. Everything else is 404, so the Worker has no other surface.
  async fetch(request, env): Promise<Response> {
    const match = WEBHOOK_PATH.exec(new URL(request.url).pathname);
    if (!match || request.method !== "POST") return new Response(null, { status: 404 });
    const [, jobId, token] = match as unknown as [string, string, string];

    if (Number(request.headers.get("Content-Length") ?? 0) > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });

    // 4xx answers are not retried by Higgsfield, which is right for forged or stray calls.
    const signed = await verifyWebhook(
      env.HF_WEBHOOK_SECRET,
      {
        id: request.headers.get("webhook-id"),
        timestamp: request.headers.get("webhook-timestamp"),
        signature: request.headers.get("webhook-signature"),
      },
      body,
    );
    if (!signed) return new Response(null, { status: 401 });

    const job = await env.DB.prepare("SELECT hook_token, status FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ hook_token: string; status: string }>();
    if (!job || !sameText(job.hook_token, token)) return new Response(null, { status: 404 });

    const fresh = await env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id) VALUES (?)")
      .bind(request.headers.get("webhook-id"))
      .run();
    // A repeat, or a job no longer waiting on Higgsfield (closed, or left to the cron): nothing to wake.
    if (fresh.meta.changes === 0 || job.status !== "submitted") return new Response(null, { status: 200 });

    // Only a wake-up: the Workflow reads the authoritative status itself, never this body.
    try {
      await (await env.GENERATE_JOB.get(jobId)).sendEvent({ type: "hf-done", payload: {} });
    } catch {
      // The instance has already finished; polling or the cron covers it.
    }
    return new Response(null, { status: 200 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(reconcile(env));
  },
} satisfies ExportedHandler<Env>;

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}
