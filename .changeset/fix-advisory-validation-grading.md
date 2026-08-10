---
'@adcp/sdk': minor
---

Honor storyboard advisory validation severity: preserve failed advisory findings without failing their steps, promote expiry-gated advisories against the runner capability semver, and expose advisory counts in machine and human summaries. Unknown future validation checks now follow the runner-output contract by grading not_applicable across runner/spec version skew instead of producing a false agent verdict.
