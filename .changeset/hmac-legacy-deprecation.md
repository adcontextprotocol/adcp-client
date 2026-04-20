---
'@adcp/client': patch
---

Flag the webhook HMAC-SHA256 authentication path as SDK-deprecated. Emits a one-time `console.warn` on first use per process; suppress with `ADCP_SUPPRESS_HMAC_WARNING=1`. `@deprecated` JSDoc tag added to `WebhookAuthentication.hmac_sha256`. HMAC remains in the AdCP spec as a legacy fallback for buyers that registered `push_notification_config.authentication.credentials`, so the SDK keeps supporting it — no hard removal date. Migrate to RFC 9421 webhook signatures when your counterparties are ready (see `docs/migration-4.30-to-5.2.md#webhook-hmac-legacy-deprecation`).
