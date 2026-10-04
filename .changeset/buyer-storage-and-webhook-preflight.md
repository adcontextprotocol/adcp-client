---
'@adcp/sdk': minor
---

Add storage-agnostic wholesale mirror refresh/webhook functions with atomic revision-checked row writes. Keep WholesaleFeedSync on the shared protocol core. Add optional CAS account provisioning storage, durable dispatch/result hooks, and caller-owned idempotency keys. Classify policy-refused and HTTP 4xx capabilities/brand.json discovery failures as terminal for webhook retry decisions. Export version compatibility and secret-redaction helpers, and a secret-less legacy HMAC webhook preflight.

Legacy HMAC verification now rejects invalid headers or stale timestamps before checking for a missing secret.

Wholesale refreshes now reject missing entity IDs, inconsistent pagination or unchanged echoes, and clear tokens omitted by a full seller response. Failed reads retain the last good catalog.

Signing discovery enforces HTTPS unless the explicit development/private-address option is enabled. Resolver and signing errors expose cause-aware recovery without changing wire codes.

Start and manual refresh retry concurrent webhook updates with full reads; repeated supersession rejects after three attempts and reports an error. HTTP 408/429 during capabilities or brand.json discovery intentionally receive terminal recovery along with other 4xx responses.
