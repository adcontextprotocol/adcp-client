---
'@adcp/client': minor
---

Storyboard steps can now opt out of a default invariant for that step
only. New `StoryboardStep.invariants.disable: string[]` mirrors the
existing storyboard-level `invariants.disable` but scoped to one step:
the runner skips calling the named invariants' `onStep` for that step
and leaves every other invariant (and every other step) untouched.

```yaml
- id: check_plan_first_pass
  task: check_governance
  invariants:
    disable: [governance.denial_blocks_mutation]
```

Motivating case: storyboards that exercise buyer recovery from a
`check_governance` 200 `status: denied`. The `expect_error: true`
escape introduced in 5.12.1 only covers wire-error denials
(`adcp_error` responses). A 200 with `status: denied` is not a wire
error, so the flag was semantically inapplicable — the invariant would
anchor and flag every subsequent mutation in the run as a silent
bypass. `invariants.disable` covers both shapes uniformly.

Validation is fail-fast at runner start (matches the storyboard-level
precedent):
- unknown assertion id in step `invariants.disable` throws;
- id already disabled storyboard-wide throws (dead code — remove one);
- unknown top-level key (e.g. `disabled`) throws.

The `governance.denial_blocks_mutation` failure message now names this
field and renders the exact YAML snippet to paste, for every anchor
shape. The previous message branched on anchor kind and suppressed the
hint for 200-status denials — that suppression pointed authors at
nothing. Unified under the one escape that works for both.

`expect_error: true`'s implicit skip is unchanged. It remains the
zero-ceremony path for expected-error contracts; `invariants.disable`
is the explicit surface for everything else.

Closes #815.
