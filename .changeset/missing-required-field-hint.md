---
"@adcp/client": minor
---

feat(conformance): add MissingRequiredFieldHint to StoryboardStepHint taxonomy

Extends `StoryboardStepHint` with a new `MissingRequiredFieldHint` member — a
structured hint the runner emits when the strict AJV validator detects a
`required`-field violation in the agent's response.

The runner already surfaced these conditions via `ValidationResult.warning`
(prose only). `MissingRequiredFieldHint` carries the same diagnosis in
machine-readable fields (`tool`, `field_path`, `schema_ref`) so downstream
renderers (Addie, CLI, JUnit) can build per-field fix plans (locate → fill →
verify) without parsing the warning string.

`field_path` uses RFC 6901 JSON Pointer conventions, matching the
`instance_path` convention adopted by `ShapeDriftHint` in #937.
`message` is always present as a human-readable fallback; renderers that don't
recognise the new `kind` continue to work verbatim. Pass/fail is unaffected —
hints remain non-fatal. Closes #946.
