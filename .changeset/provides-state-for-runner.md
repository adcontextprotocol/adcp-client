---
"@adcp/sdk": minor
---

feat(runner): honor `provides_state_for` storyboard field with `peer_substituted` skip reason

AdCP 3.0.3 (adcp#3734) introduced an optional `provides_state_for: <step_id> | <step_id>[]` field on storyboard steps, declaring that a stateful step's pass establishes equivalent state for the named peer step(s) in the same phase. When the rescue fires, the spec mandates that the rescued target be graded with `skip_reason: 'peer_substituted'` and the detail string `"<target_step_id> state provided by <phase_id>.<substitute_step_id>"` per `runner-output-contract.yaml`.

The SDK already implemented the rescue mechanism in 6.4.1 (#1144) under the field name `peer_substitutes_for`. This change aligns with the spec:

- **Type alias**: `provides_state_for` is now the canonical field on `StoryboardStep`. `peer_substitutes_for` is retained as a `@deprecated` synonym for one minor cycle so existing storyboards keep parsing. Both fields normalize at parse time; the runner reads `provides_state_for ?? peer_substitutes_for`.
- **Loader validation**: works on whichever field is declared. If both are declared, the loader rejects mismatching values (the deprecation contract is "synonym for", not "additive with"). All same-phase / both-stateful / acyclic / no-self-reference rules apply identically.
- **Skip reason**: new `peer_substituted` value on `RunnerSkipReason`, distinct from `peer_branch_taken` (branch-set routing) and `not_applicable` (coverage gap). Detail format matches the spec contract.
- **Runner re-grading**: when a deferred `missing_tool` / `missing_test_controller` skip is rescued by a passing same-phase substitute, the runner re-grades the target's step result from the original hard-missing-state reason to `peer_substituted` with the spec detail string. Without this, the target kept its original `missing_tool` grade — misleading because state DID materialize via the substitute path.

Closes #1267.

Operational impact: `sales-social` explicit-mode platforms (Snap, Meta, TikTok) that pre-provision advertiser accounts out-of-band — and declare `provides_state_for: sync_accounts` on their `list_accounts` step per the 3.0.3 storyboard — graduate from `1/9/0` to `9/10` once their compliance cache refreshes against AdCP 3.0.3+.
