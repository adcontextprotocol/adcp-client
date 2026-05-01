---
'@adcp/sdk': patch
---

fix(conformance): sync_accounts not_applicable no longer cascades to list_accounts

The F6 cascade-skip treated `sync_accounts` returning `not_applicable`
(explicit-mode: `require_operator_auth: true`) the same as "state never
materialized", which then cascade-skipped `list_accounts` as
`prerequisite_failed`. The AdCP spec defines `sync_accounts ↔
list_accounts` as mutually exclusive substitutes; explicit-mode adopters
use `list_accounts` to establish account state instead of `sync_accounts`.

The runner now exempts the cascade when `sync_accounts` skips
`not_applicable` AND `list_accounts` is in the agent's advertised tool
list. If `list_accounts` is also missing, the normal `missing_tool`
cascade fires on that step.

Reported by @bokelley from the scope3data/agentic-adapters workspace
migration (12 adapter storyboards collapsed to 1/10 passing steps).
