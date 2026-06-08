---
'@adcp/sdk': minor
---

feat(storyboard): echo authored validation ids in runner results

Storyboard validation entries may now declare stable `id` values, and the runner echoes those IDs unchanged on authored `ValidationResult` output across passing, failing, advisory, not-applicable, and cross-response checks. Compliance failure summaries preserve the first failed validation's ID, while runner-synthesized validations continue to omit IDs.
