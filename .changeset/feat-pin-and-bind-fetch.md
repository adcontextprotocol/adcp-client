---
"@adcp/client": minor
---

feat(server): `createPinAndBindFetch` — DNS-rebinding-resistant fetch for outbound webhook delivery

Adopters who pass `createPinAndBindFetch()` as the `fetch` option to `createWebhookEmitter` (or `createAdcpServer({ webhooks: { fetch } })`) now get pin-and-bind SSRF defense for free: DNS is resolved at request time, every resolved IP is validated against the webhook SSRF policy (RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, IPv4-mapped IPv6, cloud metadata), and the TCP/TLS connection is pinned to the validated address. TLS SNI and the `Host:` header are preserved so HTTPS routing still works.

This closes the gap where validating only the literal hostname at `push_notification_config.url` registration time leaves the SDK vulnerable to a DNS-rebinding attack that flips the A record between validation and delivery — the literal-host check passes, then the connection routes to `169.254.169.254` (cloud metadata) or `127.0.0.1` (loopback) at fire time.

The default `fetch` for `createWebhookEmitter` remains `globalThis.fetch` in this release for backwards compatibility — pin-and-bind would block the storyboard runner's loopback http receiver and break in-process storyboard tests without a migration. The default flips to `createPinAndBindFetch()` in v6.

The webhook emitter also now walks `Error.cause` chains when reporting transport errors in `result.errors[]`, so operators see the actual blocked rule (e.g. `EADCP_SSRF_BLOCKED: hosts_denied_ipv4_cidrs:169.254.0.0/16`) instead of the opaque outer "fetch failed". Pin-and-bind SSRF blocks are treated as terminal — no retries — because the policy violation won't change on the next attempt.

Public API:

- `createPinAndBindFetch(options?: PinAndBindFetchOptions): typeof fetch` — re-exported from `@adcp/client/server`.
- `WEBHOOK_SSRF_POLICY` — the default strict policy (https-only, all common private ranges denied, IP literals allowed subject to CIDR rules).
- `LOOPBACK_OK_WEBHOOK_SSRF_POLICY` — pre-built relaxation that allows http and IPv4/IPv6 loopback for storyboard / in-process tests; every other deny range is preserved. Safer than swapping in `globalThis.fetch` as a test escape hatch because the rest of the SSRF policy still applies.
- `PinAndBindFetchOptions` — accepts a `policy` override and a `lookup` override (for tests / custom resolvers).

See `docs/guides/SIGNING-GUIDE.md` § Webhook SSRF defense for usage and the v6 default-flip migration plan.
