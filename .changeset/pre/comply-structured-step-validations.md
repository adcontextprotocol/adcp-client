---
'@adcp/sdk': minor
---

Preserve authored `step_id` and compact per-validation verdicts in `ComplianceResult` steps, including advisory failures, not-applicable results, and advisory promotion flags. Keep existing display details and failure summaries unchanged while omitting request/response payloads and diagnostic values from the new validation list.
