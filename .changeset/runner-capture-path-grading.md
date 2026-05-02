---
"@adcp/sdk": patch
---

Storyboard runner now emits `capture_path_not_resolvable` when a `context_outputs` path resolves to absent, null, or "" (runner-output-contract v1.2.0). The capturing step grades **failed** and contributes to `run_summary.steps_failed`. Consumer steps that encounter an unresolved `$context.*` or `{{prior_step.*}}` token now include an `unresolved_substitution` ValidationResult (previously `validations: []`). Fixes silent-skip cascade diagnostic blind spot affecting 15 storyboards.
