# Contributing

Thanks for your interest. The gateway is in alpha, so the most useful contributions are:

- corrections to [docs/higgsfield-api.md](docs/higgsfield-api.md) when Higgsfield changes prices, limits or endpoints, with a link to the source;
- design feedback on [docs/architecture.md](docs/architecture.md), especially failure cases we missed;
- answers to the open questions at the end of the architecture doc;
- bug reports and tests for failure cases, with `npm run typecheck` and `npm test` passing.

Before a pull request, run both checks CI runs:

```bash
npm run typecheck
npm test
```

## Guidelines

- Every number about Higgsfield or Cloudflare needs a link to official documentation and the date you checked it.
- Never commit secrets, `.dev.vars` or real API responses that contain signed URLs.
- Keep changes small and focused, one topic per pull request.
