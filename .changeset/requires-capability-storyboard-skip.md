---
"@adcp/client": minor
---

feat(conformance): add `requires_capability` storyboard-level skip gate

Storyboard runner now evaluates a `requires_capability: { path, equals }` predicate before running any phase. When the predicate is false (agent declared the capability unsupported), the runner emits a single `{ skipped: true, skip_reason: 'capability_unsupported' }` storyboard result instead of a cascade of misleading per-phase failures. This fixes the idempotency universal storyboard running against agents that declare `adcp.idempotency.supported: false` (added in PR #931). The same mechanism applies to any future capability-gated storyboard.

