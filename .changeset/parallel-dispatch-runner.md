---
'@adcp/sdk': minor
---

Add the `parallel_dispatch_runner` test-kit contract and swap the in-flight branch to `IDEMPOTENCY_IN_FLIGHT` (#1686, #1687).

**Storyboard runner** (#1686):

- New `parallel_dispatch` step field: fans out N concurrent dispatches against the same agent (process_local mode, via `Promise.all`) and grades the cross-response set. Drives the AdCP 3.1 concurrent-retry phase of the idempotency storyboard (rule 9 / first-insert-wins).
- Two new check kinds:
  - `cross_response_field_equal { path }` — every resolved dispatch carries the same value at the named path.
  - `cross_response_count_distinct { path, allowed_values }` — distinct cardinality across resolved dispatches is in `allowed_values`. Use `allowed_values: [1]` to assert "exactly one resource created" on a race.
- In-flight retry resolution: dispatches that return `IDEMPOTENCY_IN_FLIGHT` or legacy `SERVICE_UNAVAILABLE` retry with the same `idempotency_key` after the seller's `retry_after` hint elapses, up to the per-dispatch retry budget and the outer `barrier_timeout_ms` (default 5000 ms).
- Per-response checks (`response_schema`, `field_present`, `error_code`, …) run once per dispatch and aggregate. Cross-response checks run once with the resolved set.
- The step grades `not_applicable` when the `parallel_dispatch_runner` contract is not in `options.contracts`, when `mode: distributed` is requested (out of scope for this SDK), or on a single-dispatch step that accidentally declared a `cross_response_*` check.
- Forward-compat unknown check kinds continue to grade `not_applicable` per the existing runner-output-contract behavior.

**Server middleware** (#1687):

- The idempotency middleware's in-flight branch now returns `IDEMPOTENCY_IN_FLIGHT` (AdCP 3.1 wire code) instead of `SERVICE_UNAVAILABLE`, with `recovery: transient`. Buyer SDKs that auto-retry transient + `retry_after` are unchanged.
- `retry_after` is derived from the in-flight claim's age rather than hardcoded `1` — short hint for fresh claims, longer for slow handlers, capped at 5 s so a long-running handler doesn't stall buyer retries past the outer barrier.
- The `IdempotencyCheckResult.kind === 'in-flight'` variant now carries `retryAfterSeconds` so custom store implementations can drive the same hint.

**Test impact**: `server-idempotency` tests updated to expect `IDEMPOTENCY_IN_FLIGHT` on parallel-retry paths. New `storyboard-parallel-dispatch` test covers the cross-response validators, the in-flight retry loop, barrier timeout, and `same_idempotency_key` opt-out.
