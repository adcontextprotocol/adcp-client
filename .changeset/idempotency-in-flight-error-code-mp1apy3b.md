---
'@adcp/sdk': minor
---

fix(server): return IDEMPOTENCY_IN_FLIGHT instead of SERVICE_UNAVAILABLE on in-flight idempotency key

The idempotency middleware now returns the spec-defined IDEMPOTENCY_IN_FLIGHT error code (AdCP rule 9) when a parallel request holds the same key, instead of the generic SERVICE_UNAVAILABLE. The retry_after hint is derived from the in-flight claim's expiresAt rather than a hardcoded 1s. IdempotencyCheckResult's in-flight branch gains an optional expiresAt field exposing the claim's unix expiry timestamp.
