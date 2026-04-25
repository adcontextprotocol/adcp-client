---
'@adcp/client': minor
---

**Extend `StoryboardStepHint` taxonomy: `shape_drift`, `missing_required_field`, `format_mismatch`, `monotonic_violation`** (closes #935; supersedes #937).

Issue #935 proposed making `StoryboardStepHint` the canonical surface for **every** runner-side diagnostic that has structured fields a renderer can consume. PR #937 shipped the first member (`shape_drift`) but left the broader vision unfinished — the structured fields were added in parallel to the existing `ValidationResult.warning` prose, and no consumer rendered the structured fields. This release closes the loop:

**1. Base type + four new hint kinds.** New `StoryboardStepHintBase` constrains every hint to `{ kind, message }`; the union now includes `ShapeDriftHint` (PR #937), `MissingRequiredFieldHint`, `FormatMismatchHint`, and `MonotonicViolationHint`. Each kind carries machine-readable fields so renderers don't regex-parse the prose:

| `kind`                   | When it fires                                                                                                    | Structured fields                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `shape_drift`            | Bare-array list responses, platform-native `build_creative`, wrong-wrapper `sync_creatives` / `preview_creative` | `tool`, `observed_variant`, `expected_variant`, `instance_path`                                               |
| `missing_required_field` | Strict AJV reports `keyword: "required"` issues (lenient Zod accepted)                                           | `tool`, `instance_path`, `schema_path`, `missing_fields[]`, `schema_url?`                                     |
| `format_mismatch`        | Strict AJV rejected a `format` / `pattern` / other non-required keyword that lenient Zod accepted                | `tool`, `instance_path`, `schema_path`, `keyword`, `schema_url?`                                              |
| `monotonic_violation`    | `status.monotonic` invariant catches an off-graph transition                                                     | `resource_type`, `resource_id`, `from_status`, `to_status`, `from_step_id`, `legal_next_states[]`, `enum_url` |

**2. De-duplication.** Shape-drift detection moved to `shape-drift-hints.ts` as the canonical surface; the legacy `detectShapeDriftHint` (string) in `validations.ts` now delegates to it so the two surfaces can't drift apart, and the redundant shape-drift prose was removed from `ValidationResult.warning` (it lives only on `step.hints[]` going forward). Strict-AJV `warning` prose is **kept for one minor** for back-compat with consumers that scrape it; new code should consume `step.hints[]`.

**3. Assertion → hint plumbing.** `AssertionResult` gained an optional `hint?: StoryboardStepHint` that the runner mirrors into the owning step's `hints[]` for `scope: "step"` results. `status.monotonic` is the first user — it now emits a `MonotonicViolationHint` alongside the existing prose `error`. The hint surfaces under the same taxonomy regardless of which subsystem (validation, assertion, runner-internal detector) produced it.

**4. CLI renders structured fields.** `bin/adcp-step-hints.js` branches on `hint.kind` and prints per-kind detail lines under each prose hint:

```
   💡 Hint: media_buy mb-1: active → pending_creatives (step "create" → step "regress")...
            media_buy mb-1: active → pending_creatives
            from step: create
            legal next states: canceled, completed, paused
```

Renderers that don't recognize a `kind` literal still display the prose `message` verbatim (forward-compat per `StoryboardStepHintBase`).

**Wire-format compatibility.** Adding union members is non-breaking — the JSDoc on `StoryboardStepHint` already said "more kinds may be added over time," and existing consumers that only render `message` keep working. The `ValidationResult.warning` prose for shape-drift is removed (its content lives on `step.hints[*].message` instead), so consumers that scraped specifically `warning` for shape-drift recipes need to switch surfaces.

**Spec alignment.** None required — `StoryboardStepHint` is a runner-internal diagnostic surface defined by the runner-output contract. The structured fields mirror existing taxonomies the spec already uses (`SchemaValidationError.instance_path` / RFC 6901, `enums/*-status.json` URLs).
