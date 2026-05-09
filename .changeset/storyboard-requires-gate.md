---
"@adcp/sdk": minor
---

feat(storyboard): per-storyboard `requires:` gate + `--asserts-seeded-state` flag

Storyboards can now declare runtime requirements at the storyboard level, and the
runner skips the whole storyboard with a structured `requirement_unmet` skip when
a required runtime is unavailable — replacing the per-step
`missing_test_controller` cascade with a single, clearly-attributed skip.

```yaml
# Storyboard-level tag (additive — omitted is treated as [real_wire])
requires: [controller]
```

Recognised requirements:
- `controller` — agent must advertise `comply_test_controller`. Detected from
  `options.agentTools`.
- `seeded_state` — operator must pass `--asserts-seeded-state` declaring that
  initial state has been provisioned out-of-band (HTTP admin endpoint,
  pre-test script, staging fixture). The runner does NOT verify the
  assertion; scenarios still fail naturally if state isn't actually present.
- `real_wire` — always available; reserved for a future `--mock-only` mode.

Loader rejects unknown requirement names and `requires: []` so authoring
mistakes fail loud rather than silently dropping coverage.

`requires: [controller]` unmet maps to existing `skip_reason:
'missing_test_controller'` for back-compat — skip-cause aggregators and
dashboards keyed on the existing string keep grouping controller-driven
skips into the same bucket they already track. `requires: [seeded_state]`
unmet uses the new `requirement_unmet` skip reason. `RunnerSkipResult.requirement`
carries the unmet requirement name for consumers wanting per-requirement
granularity.

```
── Without --asserts-seeded-state ──
  Steps: 26 passed, 0 failed, 28 skipped
  Skip causes:
    [22] missing_test_controller — agent doesn't advertise comply_test_controller
    [ 6] requirement_unmet: seeded_state — pass --asserts-seeded-state
```

Migration:
- SDK-internal storyboard tagging is opt-in. Untagged storyboards keep their
  existing per-step `missing_test_controller` cascade behavior.
- Upstream storyboards in `compliance/cache/` are auto-synced from
  `adcontextprotocol/adcp` and should NOT be tagged locally — tagging will be
  proposed upstream once the schema has bedded in.
- Per-step `requires_tool` (#933) is unchanged and still applies for
  fine-grained per-step gating.

Spec: adcp-client#1626. The schema may be proposed upstream as an additive
storyboard contract once it has bedded in across SDK adopters.
