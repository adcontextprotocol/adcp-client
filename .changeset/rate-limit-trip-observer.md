---
'@adcp/sdk': minor
---

Add the rate-limit trip/replay observer for the AdCP 3.1 `rate_limit_trip_runner` storyboard contract.

The storyboard runner now executes `expect_rate_limit_not_replayed` by bursting fresh idempotency keys until `RATE_LIMITED`, waiting the advertised `retry_after`, replaying the same key, and grading the new `replay_not_cached_rate_limit` check. If the burst exhausts `max_attempts` without a rate-limit response, the step emits `skip_reason: "rate_limit_not_triggered"` and canonical `skip.reason: "not_applicable"`. The public `RateLimitTripObserver` helper is exported from both `@adcp/sdk` and `@adcp/sdk/testing`.
