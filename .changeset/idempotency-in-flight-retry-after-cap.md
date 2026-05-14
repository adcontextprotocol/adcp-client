---
'@adcp/sdk': minor
---

feat(server): return IDEMPOTENCY_IN_FLIGHT on in-flight idempotency key (closes #1687)

Tightens the in-flight retry-hint contract on the AdCP-3.1-held `IDEMPOTENCY_IN_FLIGHT` error code:

- `retry_after` is now derived from the in-flight claim's remaining TTL (`expiresAt - now`), capped at 30s. Previously the hint used elapsed time capped at 5s, which meant a freshly-claimed key surfaced `retry_after: 1` and buyers retried instantly. Buyers now wait closer to the expected completion and the hint decays as the claim ages.
- `error-compliance.ts` exempts the spec-reserved `IDEMPOTENCY_IN_FLIGHT` code from the `X_` vendor-prefix naming-convention check via a new `SPEC_RESERVED_PENDING_CODES` set. Without the exemption, agents emitting the held code would be flagged as non-standard until 3.1 codegen lands the value in `ErrorCodeValues`.

Wire shape is otherwise unchanged: `recovery: 'transient'` plus a numeric `retry_after` hint, behaviorally a no-op for buyer SDKs that already honor transient-retry.
