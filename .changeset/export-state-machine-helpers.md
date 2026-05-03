---
"@adcp/sdk": minor
---

Export canonical state-machine transition maps and helpers from `@adcp/sdk/server`.

`MEDIA_BUY_TRANSITIONS`, `isLegalMediaBuyTransition`, `assertMediaBuyTransition`,
`CREATIVE_ASSET_TRANSITIONS`, `isLegalCreativeTransition`, `assertCreativeTransition`,
`CREATIVE_APPROVAL_TRANSITIONS`, `isLegalCreativeApprovalTransition`, and
`assertCreativeApprovalTransition` are now public exports.

The assertion helpers throw the spec-correct `AdcpError` codes: `NOT_CANCELLABLE`
for cancel-on-terminal-state, `INVALID_STATE` for all other illegal transitions.
These are the same maps used by the conformance runner's `status.monotonic`
invariant, so sellers who guard handlers with `assertMediaBuyTransition` are
guaranteed to agree with the storyboard runner.

The three example files that previously copy-pasted their own (diverged) transition
tables now import from the SDK. `skills/build-seller-agent/SKILL.md` is updated to
use the helpers in both the test-controller sketch and the production-handler example.
