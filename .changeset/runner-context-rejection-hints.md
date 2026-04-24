---
"@adcp/client": minor
---

Runner emits non-fatal `context_value_rejected` hints when a seller's error
response lists the values it would have accepted (`available` / `allowed` /
`accepted_values`) and the rejected request value traces back to a prior-step
`$context.*` write. Collapses the "SDK bug vs seller bug" triage (issue #870)
— the hint cites which step wrote the context key and, for `context_outputs`,
the YAML response path. Pass/fail is unchanged; hints surface on
`StoryboardStepResult.hints[]`.

Also aligns context extraction with the rest of the pipeline: convention
extractors now resolve the effective task name from `$test_kit.*` references
consistently with validation and enrichment (previously the extractor lookup
used the pre-resolution token and silently missed in that case).

New exports on `@adcp/client/testing`:
- Types: `StoryboardStepHint`, `ContextValueRejectedHint`, `ContextProvenanceEntry`
- Runtime: `detectContextRejectionHints`, `extractContextWithProvenance`,
  `applyContextOutputsWithProvenance`
