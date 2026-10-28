# Higgsfield API notes

These are facts from the official documentation that the gateway depends on, collected on 2026-10-26.
Higgsfield changes prices and limits, so re-check the linked pages before relying on a number.
The whole documentation is available as one file: https://docs.higgsfield.ai/llms-full.txt

Facts marked **(live)** were seen in calls to the real API.
Where the live behaviour differs from the docs, both are listed, and the gateway handles both.

## Authentication

- Use the header `Authorization: Key KEY_ID:KEY_SECRET`. ([authentication](https://docs.higgsfield.ai/docs/authentication))
- Keys are created in the Higgsfield Console and can have an expiry date.
  - Keys have no scopes: a key bills the whole account.
  - To rotate a key, create a new one, deploy it, then delete the old one. ([access control](https://docs.higgsfield.ai/docs/enterprise/access-control))
- Never ship the key in a browser or mobile client. The Terms of Use (§11.3) forbid it.

## Endpoints

- **Base URL:** `https://api.higgsfield.ai`. ([overview](https://docs.higgsfield.ai/docs/api-reference/overview))
- **Genjutsu Light motion transfer:** `POST /higgsfield/genjutsu-light/motion-transfer/v1.0` with `video_url`, `image_urls` (1–8 images), `prompt` and `resolution`.
  - It uses the first 15 s of the source video and keeps the source audio. ([model page](https://open.higgsfield.ai/models/higgsfield/genjutsu-light/motion-transfer/v1.0))
  - `/higgsfield/genjutsu/motion-transfer/v1.0` is the full Genjutsu model, which is a different and much more expensive model. It needs a source of at least 4 s, trims it to 30 s, and the output length follows the trimmed source **(live)**.
  - **Risk: the Genjutsu Light REST endpoint is not confirmed.** Its request schema was not in `llms.txt` or `openapi.json` on 2026-10-21. The body above comes from the open.higgsfield.ai model page. Call `/estimate` on it with a real key before building on it; if it is refused, the fallback is the full Genjutsu endpoint at its higher price.
- **Seedance 2.5:** `POST /bytedance/seedance-2.5/{text-to-video|image-to-video|reference-to-video|video-edit|video-extend}`. ([seedance 2.5](https://docs.higgsfield.ai/docs/models/seedance-2-5))
  - Reference-to-video accepts up to 30 images, 10 videos and 10 audio files, with video and audio limited to 30 s in total.
  - Reference-to-video takes `video_urls` (the source first), `image_urls`, `prompt`, `duration` (4–30), `resolution`, `aspect_ratio`, `generate_audio` and `bitrate_mode` (`standard` or `high`, default `high`).
  - `aspect_ratio` has no `auto` and defaults to `16:9`. A vertical source rebuilt without `aspect_ratio: "9:16"` comes back horizontal, so the gateway always sends the ratio nearest the source's frame.
- **Request bodies:** the API rejects `null`. Leave optional fields out or send `""`/`[]` where the schema allows them **(live)**.
  - Genjutsu always takes `prompt` and `image_urls`; an empty prompt is `""`.
  - Seedance schemas forbid unknown keys, and their arrays and `prompt` have a minimum length of 1, so empty values are left out, not sent empty.
- **Submit response:** `{status: "queued", request_id, status_url, cancel_url, expires_after: 604800}`. ([requests](https://docs.higgsfield.ai/docs/concepts/requests))
  - Every response carries `X-Correlation-ID`. Keep it with the job for support requests **(live)**.
  - Use the returned `status_url` and `cancel_url` only when they are HTTPS on `api.higgsfield.ai`; otherwise build the documented path. The key must never go to another host.
- **Price estimate:** `POST /estimate/<model path>` with **the same body as the submit** returns `{"usd": "…", "credits": "…"}` as decimal strings; `credits` may be missing. Nothing is charged. ([billing](https://docs.higgsfield.ai/docs/concepts/billing-and-retention))
  - The body includes the input URLs, so an exact price exists only once the inputs have URLs. Before that, only a local price table can give a figure.
  - The billing page calls the answer authoritative for the account. There is no dry-run flag on submit.

## Statuses and charges

- **Statuses:** `queued`, `in_progress`, `completed`, `failed`, `nsfw`, `canceled`. The last four are terminal.
  - Accept `cancelled` as `canceled`, and treat an unknown status as still running **(live)**.
  - A completed video is `{status: "completed", video: {url}}`. A `completed` answer without `video.url` is a paid request whose result is missing: don't release its reservation.
- **Endpoints:**
  - `GET /requests/{id}/status` returns the status. Poll from 2 s, back off ×1.5 up to 10 s, with jitter; keep polling on `5xx` and network errors, stop on `401` and `404`.
  - `POST /requests/{id}/cancel` works only while the request is `queued`: it answers `202` with an empty body, and `400` once processing has started **(live)**.
  - `DELETE /requests/{id}` deletes the request's data after it finishes.
- **Charges:** requests that end as `failed` or `nsfw` are not charged, and any reserved amount is refunded. Canceled and timed-out requests are not charged either. ([billing](https://docs.higgsfield.ai/docs/concepts/billing-and-retention))

## Idempotency

- The `Idempotency-Key` header takes 1–255 visible ASCII characters. It applies to generation submissions only. ([idempotency](https://docs.higgsfield.ai/docs/concepts/idempotency))
- A replay returns the original `request_id` with no new charge. Read `status_url` for the current state: the replay may say `queued` for a request that has already finished **(live)**.
- The key's fingerprint covers the endpoint, the body, the webhook URL and `Hf-Expires-After`. The same key with different parameters returns `422 "Idempotency-Key was already used with different request parameters"`. Don't recover by generating a new key.
- Field order doesn't matter. Array order, omitted fields and different URLs do.
- Requests rejected before acceptance (`401`, validation) don't use up the key **(live)**.
- The key's lifetime is not documented.

## Webhooks

- Set the webhook per request with `?hf_webhook=<url-encoded HTTPS URL>`. It fires on `completed`, `failed` and `nsfw`. ([webhooks](https://docs.higgsfield.ai/docs/how-to/webhooks))
- **Body:** `{request_id, status, error, expires_at, payload: {video: {url, content_type}}}`.
- **Signature:** Standard Webhooks. ([webhook security](https://docs.higgsfield.ai/docs/enterprise/webhook-security))
  - Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature`. The signature header holds one or more `v1,<base64>` values separated by spaces.
  - The signature is HMAC-SHA256 over `{id}.{timestamp}.{raw body}`. The key is the `whsec_` secret without the prefix, base64-decoded.
  - Reject timestamps more than 5 minutes off. Compare signatures in constant time.
  - **Deliveries are unsigned until the secret is first revealed in Console › Settings.** Reveal it before going live.
  - After a rotation the old secret stays valid for 24 h.
- **Not checked live.** The signature, the body and the retry behaviour above come from the docs only.
- **Retries:** your endpoint must answer 2xx within 10 s. Network errors and `5xx` are retried for up to 2 h; `4xx` responses are not retried. Duplicates happen, so dedupe by `webhook-id`.

## Rate limits

- The limit is on concurrency per account, and sometimes per model. Requests over the limit wait as `queued`.
- **Docs:** the queue is capped at a multiple of the concurrency limit. When it is full, the API returns `429 account_queue_full` with `Retry-After`, and nothing is charged. ([rate limits](https://docs.higgsfield.ai/docs/concepts/rate-limits))
- **Live:** at the limit the API answered `400 {"detail": "Maximum number of concurrent requests (N) has been reached"}`, with no `Retry-After` and no rate-limit headers. The message text is the only signal, and the number in it is the account's current limit.
- The gateway treats both answers as "slot busy": the submit step retries with a fixed 30 s exponential backoff (`Retry-After` is parsed but Workflows retries cannot use it), and the `400` text is matched before other `400`s are treated as validation errors.
- Concurrency tiers by funds added in the last 28 days ([pricing](https://open.higgsfield.ai/pricing)):

  | Funds added | Concurrent requests |
  |---|---|
  | new account | 2 |
  | $25 or more | 10 |
  | $100 or more | 20 |
  | $1,000 or more | 40 |

## Files

- **Inputs** must be public HTTPS URLs, or files sent through the upload API. ([file uploads](https://docs.higgsfield.ai/docs/concepts/file-uploads))
  - Upload: `POST /files/generate-upload-url` returns an `upload_url`, valid for 1 h, and a `public_url`.
  - Uploaded files are deleted within 7 days.
- **Formats:** jpeg, png, webp and gif images; mp4 video; wav audio. Maximum file sizes are not documented for these models.
- **Outputs** are kept for 7 days after the request finishes. Shorten this per request with `Hf-Expires-After` (minimum 3600 s). ([data retention](https://docs.higgsfield.ai/docs/enterprise/data-retention))

## Pricing (USD, 2026-10-26)

The API is pay-as-you-go from a prepaid USD balance. Added funds expire after one year.

**Genjutsu Light motion transfer.** Billable seconds are the output duration plus the sum of input video durations. ([model page](https://open.higgsfield.ai/models/higgsfield/genjutsu-light/motion-transfer/v1.0))

| Resolution | List, $/s | Max discount, $/s |
|---|---|---|
| 480p | 0.05 | 0.025 |
| 720p | 0.10 | 0.05 |
| 1080p | 0.20 | 0.10 |

**Seedance 2.5** is priced in tokens: $0.0214 per 1k tokens at 480p/720p and $0.0234 at 1080p. ([model page](https://open.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video))
- Text-to-video at 16:9 works out to about $0.21, $0.46 and $1.14 per second at 480p, 720p and 1080p, with up to 30% max discount.
- With video input, input seconds are billable too. The catalogue lists $0.17–0.96 per second after discount.
- Use `/estimate` for exact numbers.

The documentation does not say how an account qualifies for the max discount; it only says that volume discounts apply automatically. ([pricing](https://open.higgsfield.ai/pricing))

## Balance and spending

- No balance endpoint is documented. `GET /models/usage` returns spend analytics, but it "is not a billing record". ([usage and billing](https://docs.higgsfield.ai/docs/enterprise/usage-and-billing))
- A finished request doesn't report its cost, and REST has no history endpoint. The gateway settles at the `/estimate` answer for the exact body.
- An empty balance returns `403`.
- No spending caps or low-balance alerts are documented. Auto top-up exists; the gateway assumes it is **off**.

## SDK

- [`@higgsfield/client`](https://github.com/higgsfield-ai/higgsfield-js) (MIT) is built on `axios` and `form-data`.
  - Its v2 API does not expose `Idempotency-Key` or `hf_webhook`.
  - It has not been tested on Workers.
- The gateway calls the REST API with `fetch` instead. Five calls are needed: estimate, submit, status, cancel and delete.

## Terms of Use

([terms](https://higgsfield.ai/terms-of-use-agreement), updated 2026-10-23)

- Building apps for end users is allowed. Reselling raw access as a pass-through with no added value is not (§11.5).
- Content involving minors is prohibited.
- Bypassing moderation is prohibited (§5.2(xiii)).
