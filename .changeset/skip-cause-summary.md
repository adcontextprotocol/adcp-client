---
"@adcp/sdk": minor
---

feat(comply): surface skip causes in always-on storyboard summary

The always-on storyboard summary now includes a grouped "Skip causes" block
when steps are skipped. Previously only the skip count was shown; now each
actionable cause is listed with a step count, human-readable description, and
the affected scenario IDs — matching what the issue author's internal script
already scraped from `--json` output.

```
  Steps:     26 passed, 3 failed, 30 skipped
  Skip causes:
    [26] missing_test_controller — agent doesn't expose comply_test_controller
         Affected: capability_discovery/setup, account_setup/setup, … 21 more
    [ 2] missing_tool: sync_accounts — agent doesn't advertise tool
         Affected: refine_products/setup
    [ 2] missing_tool: list_accounts — agent doesn't advertise tool
         Affected: refine_products/setup
```

Non-actionable runner-routing reasons (`peer_branch_taken`, `not_applicable`,
`probe_skipped`, etc.) are excluded. The same block appears in the
`$GITHUB_STEP_SUMMARY` markdown output as a collapsible `<details>` table.

Additive: `ComplianceSummaryArtifact` gains an optional `skip_causes` field
(`schema_version` stays at 1; treat unknown fields as ignorable per the
existing contract). `buildCrashSummary` omits `skip_causes` — the runner
never reached storyboard execution on crash paths.

Follow-up: a `--max-skip-causes N` gate flag for CI ratcheting was proposed
in #1623 but is deferred to give the naming and semantics proper design time.
