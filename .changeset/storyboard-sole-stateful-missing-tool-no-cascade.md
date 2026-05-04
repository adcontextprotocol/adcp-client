---
'@adcp/sdk': patch
---

Storyboard runner: a stateful step that skips with `missing_tool` or `missing_test_controller` no longer trips the cross-phase cascade when it is the SOLE stateful step in its phase and has no `peer_substitutes_for` declarations targeting it. The sole-stateful-step exemption from #1146 (originally scoped to `not_applicable`) now extends to hard-missing skip reasons.

Surfaced by adcp-client-python#550 (ProposalManager v1.5): proposal-mode adopters don't advertise `sync_accounts` because account state materializes on the first `get_products` call, but the storyboard's setup phase has `sync_accounts` as the only stateful step. Pre-fix, every downstream stateful phase (refine_proposal / finalize_proposal / accept_proposal) collapsed to `prerequisite_failed`. Post-fix, downstream phases run and surface real diagnostics on their own merits.

Multi-stateful-step phases preserve existing behavior: a `missing_tool` skip with at least one stateful peer (and no rescue declaration) still trips the cascade.
