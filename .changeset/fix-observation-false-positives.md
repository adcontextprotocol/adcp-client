---
"@adcp/client": patch
---

fix: eliminate comply tester false positive observations

- Add `observation_data` field to `TestStepResult` to separate structured data (for observations) from display-only `response_preview`, eliminating false positives from snapshot-only `get_media_buys` previews
- Handle nested `media_buy` response envelope when extracting `canceled_by`, `canceled_at`, and `revision` from cancel step
- Suppress schema validation console noise via existing `logSchemaViolations` config instead of monkey-patching console
