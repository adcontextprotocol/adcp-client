---
"@adcp/sdk": minor
---

feat(storyboard): add response-derived not_applicable phase gate (#1959)

Adds `StoryboardPhase.not_applicable_if_response` — a generic phase gate that
fires based on a context key populated by a prior step's `context_outputs`
extraction. When the predicate matches, all steps in the phase are graded
`not_applicable` (passed: true, skipped: true) rather than executed.

Paired with `evaluateResponseNotApplicableGate()` helper (exported for testing).

The primary use case is the `pagination_integrity_list_accounts` storyboard:
single-publisher first-party sellers that return a single account are
conformant per AdCP spec (adcontextprotocol/adcp#4914 + #4918), but the
runner previously false-failed them because it has no way to detect terminality
before calling `list_accounts`. With this gate, the storyboard can capture
`pagination.next_cursor` from the first response and suppress the cursor-walk
phase when the cursor is absent.

**Adopter note:** Storyboards that currently false-fail single-account sellers
will see `failed_count` decrease and `skipped_count` increase once the
`pagination_integrity_list_accounts` storyboard YAML is updated to use this
gate (tracked in adcontextprotocol/adcp as a follow-up). CI gates that threshold
on `steps_failed === 0` are unaffected; gates that rely on a specific numeric
`steps_failed` value for single-account sellers should re-baseline.

Supported predicates: `'absent'`, `'present'`, `{ equals: V }`. Unknown
predicate shapes fail open (phase runs) for forward compatibility.
