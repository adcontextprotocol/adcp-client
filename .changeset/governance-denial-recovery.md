---
'@adcp/client': patch
---

Fix `governance.denial_blocks_mutation` false-positives on denial-recovery
storyboards.

A step authored with `expect_error: true` is the storyboard declaring
"this denial is a planned part of the flow" — the canonical shape for
denial-recovery scenarios where the buyer reads the findings, corrects
the payload (shrink the buy, relax the terms), and retries. The
subsequent successful mutation is the recovery path, not a silent
bypass, and the invariant no longer anchors on it.

Unacknowledged denials — e.g. a `check_governance` 200 with
`status: "denied"`, or an `adcp_error` denial code on a step the author
did not mark `expect_error` — continue to anchor as before. That is the
real silent-bypass shape the invariant guards.

Narrowed scope: the invariant no longer catches a buggy mutation that
fires immediately after an author-acknowledged denial. Correctness of
the recovery payload itself (right budget, relaxed terms, etc.) is a
storyboard-level concern — covered by per-step `validations` and status
checks on the retry, not by this run-wide guard.

Unblocks two first-party storyboards whose whole point is exercising
denial-recovery:
- `media_buy_seller/governance_denied_recovery`
- `media_buy_seller/measurement_terms_rejected`

Closes #811.
