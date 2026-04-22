---
'@adcp/client': patch
---

Fix `governance.denial_blocks_mutation` to allow expected-denial recovery
paths.

The invariant anchored any governance denial (`GOVERNANCE_DENIED`,
`TERMS_REJECTED`, `POLICY_VIOLATION`, etc.) and then flagged any later
successful mutation in the same run as a silent bypass. That fired on
first-party storyboards whose whole purpose is to test recovery —
`media_buy_seller/governance_denied_recovery` (buyer shrinks the buy
and retries) and `media_buy_seller/measurement_terms_rejected` (buyer
relaxes terms and retries) — because the retry step succeeded against
the same plan and tripped the anchor.

A denial step that the storyboard marks `expect_error: true` is the
author explicitly acknowledging the denial. The subsequent mutation is
a recovery path, not a silent bypass, so the invariant no longer
anchors when the denial step is expected. The silent-bypass signal is
preserved for `check_governance` 200s with `status: denied` and for
`adcp_error` responses the author did not declare expected.

When the invariant does fire on a wire-error denial, the failure
message now points the author at the `expect_error: true` escape so
the next author doesn't have to re-derive it from source. The hint is
suppressed on `check_governance` 200 denials where the flag has no
effect.

Closes #811.
