---
'@adcp/sdk': minor
---

Fail closed before the `expect_rate_limit_not_replayed` storyboard probe sends mutating requests. Runs must now provide both the `rate_limit_trip_runner` contract and top-level `allowLiveSideEffects: true`; otherwise the probe skips with canonical `unsatisfied_contract` and makes no agent calls. This option is independent from `request_signing.allowLiveSideEffects`, which controls request-signing vectors only.
