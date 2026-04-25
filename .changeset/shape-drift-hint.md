---
"@adcp/client": minor
---

feat(conformance): add ShapeDriftHint to StoryboardStepHint taxonomy

Extends `StoryboardStepHint` from a single-member alias to a proper discriminated union by adding `ShapeDriftHint` — a structured hint the runner emits when a response payload shape diverges from the expected variant (bare array instead of `{ wrapper_key: [...] }`, platform-native fields instead of `{ creative_manifest }`, etc.).

The runner already surfaced these conditions via `ValidationResult.warning` (prose only). `ShapeDriftHint` carries the same diagnosis in machine-readable fields (`tool`, `observed_variant`, `expected_variant`, `instance_path`) so downstream renderers (Addie, CLI, JUnit) can build per-case fix plans without parsing the message string.

`message` is always present as a human-readable fallback; renderers that don't recognise the new `kind` continue to work verbatim. Pass/fail is unaffected — hints remain non-fatal. Closes #935.
