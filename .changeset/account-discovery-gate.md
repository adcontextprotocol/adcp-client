---
'@adcp/sdk': minor
---

feat(comply): account-discovery spec-conformance gate (#1624)

Closes #1624. AdCP 3.0.9 §accounts/overview (per
[adcp#4302](https://github.com/adcontextprotocol/adcp/issues/4302)) makes
explicit a long-standing protocol invariant: every seller agent MUST
expose at least one of `list_accounts` or `sync_accounts`. The compliance
runner now enforces this universally — if an agent declares any
account-bearing specialism (`sales-*`, `audience-sync`, `governance-*`)
but advertises neither tool, the run produces a structured failure
distinct from per-step `missing_tool` skips.

Previously the runner skipped each affected scenario individually with
`overall_passed: true`, letting spec-noncompliant agents pass with a
green `STORYBOARD-OK` despite missing protocol-required capabilities.

```
── Without account-discovery tools ──
  Steps:     X passed, 1 failed, Y skipped
  STORYBOARD-FAIL 1 step(s):
    - __spec_conformance__/account_discovery/list_or_sync_accounts [core]:
        Agent declared account-bearing specialism(s) [sales-guaranteed]
        but advertises neither list_accounts nor sync_accounts.
        AdCP 3.0.9 §accounts/overview requires every seller agent to
        expose at least one of these tools.
```

The gate fires before track grouping and produces a synthetic
`StoryboardResult` with stable storyboard ID
`__spec_conformance__/account_discovery` — dashboards / badges can grep
for it. The synthetic result flows through the existing failure
extraction, summary aggregation, and skip-cause pipelines unchanged
(failures, not skips, so it appears in the failures list rather than the
skip-cause block).

The gate is a no-op when:
- Agent doesn't expose `get_adcp_capabilities` (specialisms unknown — a
  separate observation already surfaces the missing capability call;
  we don't double-report)
- Agent declares no account-bearing specialism (signals-only, brand-
  rights-only, creative-only adopters are unaffected)
- Agent already advertises `list_accounts` or `sync_accounts`

Will migrate to a per-storyboard `required_any_of_tools` tag once
[adcp#4325](https://github.com/adcontextprotocol/adcp/issues/4325) lands
in AdCP 3.1 — see [#1642](https://github.com/adcontextprotocol/adcp-client/issues/1642)
for the migration checklist. Today's runner-level gate covers the same
spec invariant against the auto-synced cache without requiring upstream
schema changes.

Tests: 11 new tests covering pass/fail/no-op cases for every
account-bearing specialism family (`sales-*`, `audience-sync`,
`governance-*`) and exempt agent shapes (signals, creative).
