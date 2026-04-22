---
'@adcp/client': patch
---

Fix unbounded re-execution when a buyer SDK retries a mutating request against a handler whose response fails strict-mode validation (issue #758).

Under the strict response-validation default, a drifted handler produced a `VALIDATION_ERROR` and released its idempotency claim on the way out, so the next retry re-entered the handler with the same drift — looping as fast as the buyer's retry budget allowed. The dispatcher now caches the `VALIDATION_ERROR` envelope under the same `(principal, key, payloadHash)` tuple for 10 seconds; retries on the same key short-circuit to the cached error instead of re-running side effects, and the cache clears itself before a handler fix would be gated on TTL expiry.

A retry with a different canonical payload still produces `IDEMPOTENCY_CONFLICT` (the cache scopes on payload hash, same as the success cache), and a buyer that generates a fresh idempotency key per retry is not short-circuited — both behaviors are intentional. Same-key retry storms are the dominant failure mode; fresh-key loops already have the buyer's backoff as the correct control point.

New `IdempotencyStore.saveTransientError(...)` method is optional on the interface — custom store implementations that want retry-storm protection can implement it; omitting it preserves the prior release-on-error behavior. Stores built via `createIdempotencyStore` pick it up automatically.

**Operational note.** A drifted handler reachable by a hostile buyer is a cache-fill vector (every fresh key writes a 10s entry). Alert on sustained `VALIDATION_ERROR` rates per principal — steady-state should be zero.
