---
'@adcp/sdk': patch
---

Storyboard runner now cascade-skips stateful steps when a prior stateful step skipped for a missing-state reason (`missing_tool`, `missing_test_controller`, `not_applicable`). Previously the cascade tripped only on FAILED stateful steps, so a setup step that skipped because the agent didn't advertise the required tool left subsequent stateful steps to run against absent state — surfacing as misleading "X didn't match" assertion failures instead of the cleaner `prerequisite_failed` skip. Benign skips (`peer_branch_taken`, `oauth_not_advertised`, `controller_seeding_failed`) deliberately don't trip the cascade because state DID materialize via another path. Surfaced by training-agent v6 spike (F6) on cross-specialism `signal_marketplace/governance_denied`.
