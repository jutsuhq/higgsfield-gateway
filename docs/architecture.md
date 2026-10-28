# Architecture

Higgsfield Gateway is one Cloudflare Worker that owns everything specific to the Higgsfield API:
- the API key and the webhook secret,
- input and output media,
- the dollar budget,
- concurrency.

Clients (a chat bot, a web app) own users, credits, payments and delivery to the end user.

## Components

| Component | Cloudflare primitive | Role |
|---|---|---|
| RPC entrypoints | `WorkerEntrypoint` behind Service Bindings | The only way clients talk to the gateway. Not reachable from the internet. |
| `GenerateJob` | Workflows | One durable instance per job: submit, wait, deliver, settle, clean up. |
| Webhook route | Worker `fetch` handler, `POST /hf/webhook/<job>/<token>` | Receives Higgsfield webhooks, verifies the signature, wakes the Workflow. |
| Database | D1 (`hf_gateway`) | Jobs, per-client and global budgets, inputs, trend catalog, processed webhook ids. |
| Media | R2 (`hf-media`, private) | Inputs (`in/`) and results (`out/`), deleted by lifecycle rules. |
| Events | Queues (`hf-events-<client>`) | Job finished, failed or flagged. Clients consume these to settle credits and deliver. |

## Request flow

```
client ──RPC──► putInput(stream)            → R2 in/<id>
client ──RPC──► createJob({clientJobId, …}) → check allow-list, input ownership and list price ≤ maxUsd, max_job_cents
                                            → one D1 batch: reserve list price (client + global) and insert job
                                            → start Workflow
Workflow GenerateJob
  1 acquire concurrency slot: guarded UPDATE reserved → submitted (step.sleep 30 s while full)
  2 presign input URLs and build the request body in one step, so later retries reuse the same body
  3 exact price: POST /estimate/<model> with that body → above maxUsd or max_job_cents: fail and release
                                                      → else adjust the reservation to it
  4 submit: POST /<model>?hf_webhook=…  Idempotency-Key: job.id  Hf-Expires-After: 86400
  5 wait: loop { waitForEvent("hf-done", 5 min) | on timeout: GET /requests/{id}/status }
          overall limit 90 min, then see "Timeouts" below
  6 completed → check result host and size → stream video.url into R2 out/<job>.mp4
                (the cron runs the same delivery before settling a recovered job)
  7 settle: reserved → spent (exact estimate)   failed/nsfw/canceled → release
  8 emit: Queue message {jobId, clientJobId, status, usd}
  9 clean up: DELETE /requests/{id} on Higgsfield; R2 lifecycle removes files after 1–2 days
client (queue consumer) → capture or refund credits → openResult(jobId) → deliver
```

The submit body must be byte-for-byte stable across retries: Higgsfield fingerprints the endpoint, body, webhook URL and `Hf-Expires-After` under one `Idempotency-Key` and answers `422` to a mismatch.
That is why presigned URLs come from a separate step, whose result Workflows persist, and why the webhook token is fixed when the job is created.

The body follows Higgsfield's schemas: no `null` values, and for Seedance no unknown keys and no empty arrays or prompt, which are left out instead.
Seedance always gets an `aspect_ratio`, the one asked for or else the one nearest the source's frame, because the API's default is `16:9` and would turn a vertical trend horizontal.

Higgsfield's `/estimate` needs the full submit body, including the input URLs, so an exact price exists only after step 2.
Until then the gateway uses its own list-price table: the `estimate` RPC and `createJob` read it, and it is kept at or above the published list prices so that a reservation is an upper bound.

## Why Workflows

| Need | Workflows | Queues | Durable Object + alarms |
|---|---|---|---|
| Wait 1–30 min without paying for idle time | `waitForEvent` and `sleep` | `delaySeconds` (max 24 h), you keep the state | alarms, state in the object's SQLite |
| Webhook wakes the job | `instance.sendEvent()`, buffered if it arrives early | not supported, polling only | `fetch` into the object |
| Step retries and persisted results | built in | whole message retried | hand-written |

Queues are still used, but only for fan-out of finished-job events to clients.

## RPC contract

```ts
estimate({ model, resolution, inputSeconds }): Promise<{ usd: number }>   // list price, an upper bound; inputSeconds must be > 0
putInput(body: ReadableStream, contentType: string): Promise<{ inputId: string }>  // at most 50 uploads per client in 24 h
createJob({
  clientJobId: string,               // idempotency key on the client side
  model: "genjutsu-light/motion-transfer" | "seedance-2.5/reference-to-video",
  resolution: "480p" | "720p" | "1080p",
  imageInputIds: string[],
  video: { trendId: string } | { inputId: string },
  prompt?: string,
  seedance?: {                       // Seedance only
    aspectRatio?: "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16",  // default: nearest to the source
    duration?: number,               // 4–30 s; default: the source's length
    generateAudio?: boolean,         // default: false, the source keeps its sound
  },
  maxUsd: number,                    // checked against the list price now and the exact /estimate before submit, as is the operator's max_job_cents
}): Promise<{ jobId: string; estUsd: number }>      // estUsd: the list price reserved
getJob(jobId): Promise<{ status: JobStatus; usd?: number; error?: string }>
cancelJob(jobId): Promise<void>      // effective while waiting for a slot or queued at Higgsfield
openResult(jobId): Promise<ReadableStream>
```

- Clients never pass URLs, only streams and ids. That rules out SSRF and input substitution.
- The client identity comes from the entrypoint class bound in the client's config, not from an argument:

  ```jsonc
  "services": [{ "binding": "HF", "service": "higgsfield-gateway", "entrypoint": "BotEntrypoint" }]
  ```

- `estimate` and `createJob` reject a malformed spec with `invalid_input` before touching D1 or R2: `inputSeconds` must be a finite number above 0, and `video` must name exactly one of `trendId` or `inputId`.
- `putInput` accepts at most 50 uploads per client per 24 h (`MAX_PENDING_INPUTS`), counted from `inputs.created_at`; over that it returns `over_quota`. Nothing deletes unused inputs yet, so this bounds the table and R2.
- Every query by `jobId` or `inputId` also filters on that client id. A job or input that belongs to another client gets the same `not_found` error as one that does not exist, so ids cannot be probed.
- `createJob` with an existing `(client, clientJobId)` returns the existing job.

## D1 schema

The schema is [migrations/0001_init.sql](../migrations/0001_init.sql). Besides ids and statuses, `jobs` keeps:
- `spec`: the inputs and options `createJob` received, so the Workflow rebuilds the same body;
- `est_cents` (list price, then the exact estimate), `max_cents` (the client's `maxUsd`) and `spent_cents`, set when the job closes;
- `spend_day`, `hook_token`, `hf_request` and `hf_correlation` (the submit's `X-Correlation-ID`, for Higgsfield support).

`inputs` and `trends` keep each video's length and display size, read from the MP4 header, so a job can be priced and given an aspect ratio without downloading the video again.
The `spend_cap` trigger enforces the daily caps (see [Budget](#budget)).

Job statuses:

| Status | Meaning | Holds a concurrency slot |
|---|---|---|
| `reserved` | Budget reserved, waiting for a slot | no |
| `submitted` | Slot taken; submitted or about to be submitted to Higgsfield | yes |
| `timeout` | 90-min limit passed while Higgsfield was still running it | yes, until reconciled |
| `expired` | A `timeout` job closed by the cron; never a success, so a client that refunded stays right | no |
| `completed`, `failed`, `nsfw`, `canceled` | Terminal, settled | no |

## Budget

The per-job ceiling is checked in code first: `est_cents <= max_job_cents` and `est_cents <= maxUsd`. The exact `/estimate` is then checked against both again, because a ratio or option can price above the list table; `max_job_cents` is re-read from the client row for that check.
Then `createJob` runs one `db.batch()`, which D1 executes as a transaction:

```sql
-- ?1 client, ?2 UTC day, ?3 est_cents, ?4 GLOBAL_DAILY_CAP_CENTS (env)
-- 1. Create today's rows, or refresh their caps if the config changed
INSERT INTO spend (client_id, day, cap_cents)
SELECT id, ?2, daily_cap_cents FROM clients WHERE id = ?1
ON CONFLICT (client_id, day) DO UPDATE SET cap_cents = excluded.cap_cents;

INSERT INTO spend (client_id, day, cap_cents) VALUES ('_global', ?2, ?4)
ON CONFLICT (client_id, day) DO UPDATE SET cap_cents = excluded.cap_cents;

-- 2. Reserve on both rows. If either cap would be exceeded, the trigger
--    aborts and the whole batch rolls back.
UPDATE spend SET reserved_cents = reserved_cents + ?3
WHERE day = ?2 AND client_id IN (?1, '_global');

-- 3. Create the job. A duplicate (client_id, client_job_id) also rolls back
--    the reservation; createJob then returns the existing job.
INSERT INTO jobs (id, client_id, client_job_id, model, resolution, est_cents, spend_day, hook_token, status)
VALUES (?5, ?1, ?6, ?7, ?8, ?3, ?2, ?9, 'reserved');
```

A `budget_exceeded` error from the batch goes back to the client as is.

Step 3 moves the reservation from the list price to the exact estimate in one batch. A lower price shrinks it; a higher one grows it, so the trigger checks the caps again and a `budget_exceeded` fails the job and releases it:

```sql
-- ?delta = exact_cents - est_cents
UPDATE spend SET reserved_cents = reserved_cents + ?delta
WHERE day = ?spend_day AND client_id IN (?client, '_global')
  AND EXISTS (SELECT 1 FROM jobs WHERE id = ?job AND status = 'submitted' AND est_cents = ?old_est);

UPDATE jobs SET est_cents = ?exact_cents
WHERE id = ?job AND status = 'submitted' AND est_cents = ?old_est;
```

The `est_cents = ?old_est` guard makes a retried step a no-op. Settling then uses the new `est_cents`, because Higgsfield reports no cost for a finished request.

Settling and releasing use one statement shape (`?actual` = 0 for a release), guarded by the job's status so a retried step changes nothing.
Both statements run in one batch, in this order:

```sql
UPDATE spend
SET reserved_cents = reserved_cents - ?est, spent_cents = spent_cents + ?actual
WHERE day = ?spend_day AND client_id IN (?client, '_global')
  AND EXISTS (SELECT 1 FROM jobs WHERE id = ?job AND status IN ('reserved', 'submitted', 'timeout'));

UPDATE jobs
SET status = ?final, spent_cents = ?actual, error = ?error,
    result_key = COALESCE(?result_key, result_key), finished_at = CURRENT_TIMESTAMP
WHERE id = ?job AND status IN ('reserved', 'submitted', 'timeout');
```

`settle` returns whether the jobs UPDATE changed a row. `finish` skips the event when it did not, so a job closed by the cron first cannot emit a second terminal event.

`spend_day` is the day of the reservation, not today, so a job that runs past midnight UTC settles against the row it reserved on.

## Concurrency

There is no separate slot table: the slots in use are jobs in `submitted` or `timeout`.
`createJob` parses `HF_CONCURRENCY` before reserving anything, so a non-positive or non-integer value fails the call instead of a job at step 1.
Step 1 takes a slot with one guarded statement and sleeps 30 s while it returns `meta.changes = 0`:

```sql
-- ?1 job, ?2 client, ?3 HF_CONCURRENCY (env, the account's tier)
UPDATE jobs SET status = 'submitted'
WHERE id = ?1 AND status = 'reserved'
  AND (SELECT COUNT(*) FROM jobs WHERE client_id = ?2 AND status IN ('submitted', 'timeout'))
      < (SELECT max_parallel FROM clients WHERE id = ?2)
  AND (SELECT COUNT(*) FROM jobs WHERE status IN ('submitted', 'timeout')) < ?3;
```

A slot is freed when the job reaches a terminal status. If an instance crashes while holding one, the reconcile cron frees it.

## Timeouts

At the 90-min limit the Workflow reads the status once more:

- `queued`: call `cancel`. `202` means the job is `canceled` and the reservation is released. A `400` whose message says it already started (`already started`, `already processing`) means it has started in the meantime: handle it as `in_progress`. Any other `400` is a non-retryable error.
- `in_progress`: Higgsfield will still finish and charge for it. Mark the job `timeout` and **keep the reservation**, emit a `timeout` event so the client refunds its user, and end the instance.

A submit whose outcome stays unknown after its replays ends the same way, with `error: "submit_uncertain"` and no `hf_request`.
- terminal: handle it normally.

The reconcile cron later closes each `timeout` job as `expired`: a `completed` request moves the estimate to spent (its result is not downloaded), other terminal statuses release it. `expired` cannot be mistaken for success by a client that already saw `timeout` and refunded. A `submit_uncertain` job has no request to ask about, so its estimate counts as spent.

## Failure handling

| Stage | Failure | Handling |
|---|---|---|
| createJob | budget exceeded, model not allowed, input of another client, list price above `maxUsd` or `max_job_cents`, malformed spec, missing events queue, bad `HF_CONCURRENCY` | Error to the client. The batch rolls back, nothing is reserved. |
| exact price | `/estimate` above `maxUsd` or `max_job_cents`, or the higher price exceeds a cap | Mark failed, release, emit the event with the reason. |
| exact price | `/estimate` refuses the body (`4xx`) | Same handling as a validation error at submit. |
| submit | `400 "Maximum number of concurrent requests (N) …"`, `429 account_queue_full`, `503` | Refused, nothing accepted: step retry with a fixed 30 s exponential backoff. `Retry-After` is parsed but Workflows step retries cannot use it. Same `Idempotency-Key` and same body, so there is no duplicate charge. If retries run out, fail and release. |
| submit | `5xx` other than `503`, network error, timeout | Outcome unknown: the job is flagged `submit_uncertain` and retried the same way. If retries run out, replay the submit every 20 min for 1 h, inside the 4 h presigned URLs: a replay returns the request Higgsfield may have accepted. If none answers, see [Timeouts](#timeouts); the cron then counts the estimate as spent and logs the job for a check against `GET /models/usage`. |
| submit | `403` (balance empty), other `4xx` validation | The step returns a plain error result: fail and release the reservation. There is no alerting; the job's `error` is the record. |
| submit | `422` idempotency mismatch | A bug: the body changed between retries. Fail the job and reconcile by hand. |
| wait | webhook lost | Polling finds the status. |
| wait | 90 min overall limit | See [Timeouts](#timeouts). |
| deliver | `completed` without `video.url` | Paid but missing: settle as spent, mark failed. |
| deliver | download fails after its retries | Settle as spent and mark failed, so the instance never dies with the reservation held. |
| deliver | result larger than `MAX_RESULT_BYTES`, unexpected host, redirect | Mark failed as spent; nothing is kept. There is one global size limit, not a per-client one. |
| settle | step retried | Idempotent: the status guard turns the second run into a no-op. |
| any | instance crashed | An hourly Cron Trigger reconciles jobs stuck in `reserved`/`submitted` for more than 3 h, oldest first, and every `timeout` job, against Higgsfield status. |

## Open questions

1. **Unverified: does the Genjutsu Light REST endpoint work?** It has no published request schema (see [Higgsfield API notes](higgsfield-api.md#endpoints)). Check with one `/estimate` call and a real key before relying on it. If it is refused, fall back to full Genjutsu, which costs several times more.
2. Webhooks have never been seen live: the signature headers, the body and the retries come from the docs only. Test them on the first paid run, with polling as the fallback.
3. Does Higgsfield fetch input URLs on accept, or when the job starts? `/estimate` may fetch them as well. URLs are presigned right before the estimate, live for 4 h and cover the 1 h replay window; slots keep the Higgsfield queue short.
4. Is the Genjutsu Light output as long as its input, up to 15 s? Full Genjutsu's output follows the source, trimmed to 30 s.
5. Output file sizes at 720p and 1080p, which matter for clients with an upload limit.
6. How to measure user-uploaded video length without ffmpeg: parse MP4 `mvhd`, or trust the client's metadata?
7. The account's real concurrency limit, and whether models have their own. An observed `400` reported a limit that matches none of the documented tiers (2, 10, 20, 40), and the docs describe a `429` instead.
8. Are Service Binding calls billed as Worker requests? The cost is negligible either way.
