---
'@adcp/client': patch
---

Auto-inject `idempotency_key` on mutating storyboard requests and untyped `executeTask` calls (adcp-client#625).

The storyboard runner now mints a UUID v4 `idempotency_key` on any mutating step whose `sample_request` omits one — matching how a real buyer operates, so compliance storyboards exercise handler logic rather than short-circuiting on the server's required-field check. Suppressed when the step has `expect_error: true` so missing-key rejection scenarios still flow through unchanged.

The underlying `normalizeRequestParams` helper now derives its mutating-task set from the Zod request schemas (`MUTATING_TASKS` in `utils/idempotency`) rather than a hand-maintained list that was missing `acquire_rights`, `update_media_buy`, `si_initiate_session`, `si_send_message`, and the property/collection/content-standards writes. Any caller using `client.executeTask(<mutating-task>, params)` — typed or untyped — now receives the same auto-injected key the typed methods already minted via `executeAndHandle`.
