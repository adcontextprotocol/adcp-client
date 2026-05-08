---
'@adcp/sdk': patch
---

fix(storyboard-runner): preserve sample_request fields when enriching mutating-tool requests (#1604)

Fixture-aware enrichers in `src/lib/testing/storyboard/request-builder.ts` rebuilt their request body from scratch and only copied an enumerated set of fields from `step.sample_request` (`start_time`, `end_time`, `packages`). Anything else the storyboard authored at the top level — `total_budget`, `buyer_ref`, `currency`, `reporting_webhook`, scenario-specific extensions — was silently dropped before the request hit the wire. The non-proposal `create_media_buy` path was the immediate trigger; PR #1603's proposal-mode branch already spread the fixture but the structural fix wasn't applied to the rest of the enricher.

The fix spreads `sample_request` first (after `$context` injection), then layers the runner's substitutions (account, brand, normalised dates, packages with discovery-derived identifiers) on top. Envelope fields (`context`, `ext`, `push_notification_config`, `idempotency_key`) are deliberately omitted from the local spread and re-applied by the outer `enrichRequest` with `runnerVars` so mustache substitutions like `{{runner.webhook_url:<step_id>}}` expand correctly. The same `omitEnvelopeFields` discipline is now applied uniformly across `create_media_buy`, `update_media_buy`, `get_media_buys`, `get_media_buy_delivery`, and `comply_test_controller`.
