# Costs

All prices were checked on 2026-10-26 and are linked to their source. Check them again before you set your own prices.

## Higgsfield cost per video

Genjutsu Light bills **output seconds plus input video seconds** ([model page](https://open.higgsfield.ai/models/higgsfield/genjutsu-light/motion-transfer/v1.0)).
A 10-second trend video produces about a 10-second result, so it bills 20 seconds.

| Resolution | 10 s, list | 10 s, max discount | 11 s, list | 11 s, max discount |
|---|---|---|---|---|
| 480p | $1.00 | $0.50 | $1.10 | $0.55 |
| 720p | $2.00 | $1.00 | $2.20 | $1.10 |
| 1080p | $4.00 | $2.00 | $4.40 | $2.20 |

**Seedance 2.5 reference-to-video, 11 s:** about 22 billable seconds at $0.17–0.96 per second, which is **$3.80–21.00** depending on resolution.
Call `/estimate` with your exact parameters.

Failed, NSFW-flagged and canceled jobs cost nothing ([billing](https://docs.higgsfield.ai/docs/concepts/billing-and-retention)).

## Cloudflare cost

### Plan and prices

Workers Paid is $5/month ([pricing](https://developers.cloudflare.com/workers/platform/pricing/)). These amounts are included each month:

| Resource | Included per month | Price above that | Source |
|---|---|---|---|
| Worker requests | 10M | | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| CPU time | 30M ms | | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workflow steps | 500k | $0.80 per 100k | [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/) |
| D1 rows written | 50M | | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows read | 25B | | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 storage | 10 GB | $0.015 per GB-month | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 Class A operations | 1M | | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| R2 egress | free | free | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Queue operations | 1M | | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |

### Usage per video

Assumed usage for one video:

- about 17 requests, counting RPC calls and the webhook;
- 12 Workflow steps;
- 20 D1 rows written;
- 3 R2 Class A operations;
- 25 MB stored in R2 for 1 day;
- 3 Queue operations.

### Monthly total

| Videos per month | Steps | D1 writes | R2 storage | Queue ops | Cloudflare total |
|---|---|---|---|---|---|
| 1,000 | 12k | 20k | ~0.8 GB-month | 3k | **$5** |
| 10,000 | 120k | 200k | ~8 GB-month | 30k | **$5** |

At 10,000 videos a month, every line is still inside the included usage.
Keeping results for 7 days instead of 1 adds about $0.72 at 10,000 videos.

**Bottom line:** infrastructure costs under $0.005 per video. Higgsfield is 99%+ of the unit cost.
