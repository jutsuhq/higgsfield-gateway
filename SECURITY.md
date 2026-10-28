# Security policy

This project guards API keys and a prepaid balance, so security reports are a priority.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting instead:
open the **Security** tab of this repository and choose **Report a vulnerability**.

Include the affected file or component, steps to reproduce and the impact you expect.
You will get a reply within 7 days.

## Scope

In scope:
- webhook verification bypass;
- spending-limit bypass;
- cross-client access through RPC entrypoints;
- leaks of keys, presigned URLs or user media.

Out of scope:
- Higgsfield's or Cloudflare's own services. Report those to the vendors.

See [docs/security.md](docs/security.md) for the threat model.
