---
'@adcp/client': patch
---

Auto-inject `idempotency_key` on mutating storyboard requests and untyped `executeTask` calls (adcp-client#625).

The storyboard runner now mints a UUID v4 `idempotency_key` on any mutating step whose `sample_request` omits one — matching how a real buyer operates, so compliance storyboards exercise handler logic rather than short-circuiting on the server's required-field check. Auto-injection applies to `expect_error` steps too, so scenarios that expect specific failures (GOVERNANCE_DENIED, UNAUTHORIZED, brand_mismatch, etc.) reach the error path they named instead of hitting INVALID_REQUEST first. Storyboards that intentionally test the server's missing-key rejection opt out with the new `step.omit_idempotency_key: true` flag.

The underlying `normalizeRequestParams` helper now derives its mutating-task set from the Zod request schemas (`MUTATING_TASKS` in `utils/idempotency`) rather than a hand-maintained list. The Zod-derived set adds auto-injection for `acquire_rights`, `update_media_buy`, `si_initiate_session`, `si_send_message`, `build_creative`, and the property / collection / content-standards writes — all of which the spec declares as mutating but the hand-maintained list was missing. Any caller using `client.executeTask(<mutating-task>, params)` — typed or untyped — now receives the same auto-injected key the typed methods already minted via `executeAndHandle`.
