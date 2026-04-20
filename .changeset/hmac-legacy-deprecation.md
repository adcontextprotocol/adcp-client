---
'@adcp/client': patch
---

Deprecate the webhook HMAC-SHA256 authentication path. Emits a one-time `console.warn` on first use per process; suppress with `ADCP_SUPPRESS_HMAC_WARNING=1`. `@deprecated` JSDoc tag added to `WebhookAuthentication.hmac_sha256`. Scheduled for removal in @adcp/client 6.0.0. Migrate to RFC 9421 webhook signatures (see `docs/migration-4.30-to-5.2.md#webhook-hmac-legacy-deprecation`).
