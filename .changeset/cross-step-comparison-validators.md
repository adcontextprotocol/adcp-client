---
'@adcp/sdk': minor
---

Add `field_less_than` and `field_equals_context` cross-step comparison validators to the storyboard runner.

These two new `StoryboardValidationCheck` kinds let storyboard authors assert relationships between a current-step response field and a value captured from an earlier step via `context_outputs`. The runtime accumulator is the existing `storyboardContext` (option 2 / context-outputs style), consistent with the `refs_resolve` validator precedent.

- **`field_less_than`** — asserts a numeric field is strictly less than a comparand. The comparand is either a runtime context value (`context_key`) or a literal (`value`). Emits a type error if either operand is non-numeric; passes with a `context_key_absent` observation if the referenced context key was never populated (prior step may have been legitimately skipped on a branch-set path).
- **`field_equals_context`** — asserts a field deep-equals a context-captured runtime value. Requires `context_key`. Same skip-with-observation behavior when the key is absent.

Both validators require `path`. Both add `context_key?: string` to `StoryboardValidation` (ignored by all other check types).

Enables the runner side of adcp#2642, which adds these check kinds to the universal storyboard schema enum once this lands.
