---
'@adcp/client': patch
---

Add `docs/guides/idempotency-crash-recovery.md` — worked buyer-side recipe for crash-recovery using `IdempotencyConflictError` + `IdempotencyExpiredError` + natural-key lookup + `metadata.replayed`. No code changes.
