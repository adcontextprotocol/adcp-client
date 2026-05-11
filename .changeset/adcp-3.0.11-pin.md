---
"@adcp/sdk": patch
---

Bump AdCP pin to 3.0.11. Pulls in adcontextprotocol/adcp#4365 (3.0.11 release): collapses the `key_reuse_conflict` phase of `universal/idempotency.yaml` into `replay_same_payload` as a fourth step so the shared `$generate:uuid_v4#replay_key` alias stays within a single phase. This is the companion storyboard restructure for the runner-side phase-boundary alias reset shipped in 6.20.0 (#1658 / closes #1657): with the reset in place, a separate phase would mint a fresh UUID and the seller would treat the conflict step as a new request, masking the IDEMPOTENCY_CONFLICT assertion. No schema shape changes; regen diff is metadata only (adcp_version strings + entity-hydration source version comment).
