# Security model

The gateway exists to keep the Higgsfield key and the prepaid balance safe from bugs and abuse in the apps that use it.

## Isolation

- The Worker has no public API.
  - Set `workers_dev: false` and `preview_urls: false`.
  - The only public route is `POST /hf/webhook/<job>/<token>`; everything else returns 404.
- Clients reach the gateway only through Service Bindings from Workers in the same account.
- Each client binds its own `WorkerEntrypoint` class, and that class carries the client id. A client cannot claim to be another client.
- The entrypoint name is not a secret: any Worker in the account can bind `{ "service": "higgsfield-gateway", "entrypoint": "BotEntrypoint" }`. Isolation rests on per-Worker bindings and **deploy rights**, not on an unguessable name. Do not give one client's team deploy access to another client's Worker, or to the gateway.
- Every lookup of a job or input filters on that client id. Another client's ids return `not_found`, the same as ids that do not exist.
- Only the gateway holds:
  - the Higgsfield key,
  - the webhook secret,
  - the R2 bucket binding,
  - the S3 credentials used for presigned URLs.

  A compromised client can spend at most its own daily budget, as long as it cannot deploy a Worker that binds another entrypoint.
- Deploy rights for the gateway should be limited to the owner. Use a separate Cloudflare account or API token if other people work on the clients.

## Spending limits

Each layer stops a different failure:

| Layer | Stops |
|---|---|
| Prepaid Higgsfield balance, auto top-up off | Everything else failing. It is the only hard cap, because Higgsfield has no API spending limit. |
| Global and per-client daily cap in D1, enforced by a trigger | A runaway client or a bug that loops on job creation |
| Per-job `maxUsd`, checked against `/estimate` | Price changes and wrong parameters (e.g. 1080p instead of 480p) |
| Model and resolution allow-list per client | Clients using premium models they shouldn't |
| Concurrency slots | Long Higgsfield queues and `429` storms |
| `Idempotency-Key = job.id` | Duplicate charges when a step is retried |

Cloudflare budget alerts only send email and never stop usage, so they are a signal, not a limit.
Keep `limits.cpu_ms` low on public routes.

## Webhooks

1. Reveal the webhook secret in the Higgsfield Console before going live. Until then, deliveries are unsigned.
2. Verify the Standard Webhooks HMAC-SHA256 signature over the raw body. Compare in constant time and reject timestamps more than 5 minutes off.
3. Check that the path token matches the job's `hook_token`.
4. Deduplicate by `webhook-id` using a D1 primary key, and record the id only once the job is `submitted`: a delivery that arrives before submit must not consume it.
5. Treat the webhook as a wake-up signal only. Before settling money, read the authoritative status with `GET /requests/{id}/status`.

## Inputs and outputs

- Clients upload streams, not URLs, so the gateway never fetches a URL a client chose.
- Check every input's MIME type from its magic bytes. Images: at most 10 MB and at least 300 px a side, read from the header. Videos: at most 200 MB, streamed to R2 in parts and read back by range for their length and frame size; Genjutsu Light takes 4–15 s.
- Presigned R2 GET URLs are created right before submit, live for 4 hours and are signed with a read-only key scoped to one bucket. They work only on `<account>.r2.cloudflarestorage.com`.
- Before downloading a result, check that `video.url` points to a host in `RESULT_HOSTS` (an exact match, and required) and that its size is within `MAX_RESULT_BYTES`. Redirects are refused, so the allow-list covers every hop, and a missing `Content-Length` is counted as the stream arrives.
- Never pass third-party URLs that embed secrets as inputs. For example, some bot platforms put the bot token in file URLs.

## Data retention

- Send `Hf-Expires-After: 86400` and call `DELETE /requests/{id}` after delivery.
- R2 lifecycle rules delete `in/` and `out/` after 1–2 days.
- D1 keeps ids, statuses and amounts, but not only those: `jobs.spec` holds the prompt and the input ids, `jobs.error` holds the failure reason, and `inputs` rows name the uploaded objects. Nothing deletes them automatically, so D1 retains prompts indefinitely. Media lives only in R2.
- Logs contain `jobId`, status and cost only. Never log presigned URLs or webhook bodies.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
