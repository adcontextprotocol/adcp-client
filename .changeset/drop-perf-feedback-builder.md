---
'@adcp/client': patch
---

Drop the `provide_performance_feedback` request builder from the storyboard runner so the spec-conformant `sample_request` from the storyboard drives the payload. The builder emitted non-spec `feedback`/`satisfaction`/`notes` fields that caused conformant sellers to reject the request with `INVALID_REQUEST`. Closes #689.
