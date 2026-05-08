---
'@adcp/sdk': patch
---

fix(storyboard): proposal-mode `create_media_buy` request shape (closes adcp-client#1600)

After AdCP 3.0.7 (#1595) landed adcp#4088, the `proposal_finalize` storyboard runs end-to-end through `accept_proposal` for the first time. The runner's `create_media_buy` enricher in `request-builder.ts` was unaware of the proposal-mode request shape — it always returned `{ account, brand, start_time, end_time, packages }` even when the storyboard's `sample_request` carried `proposal_id: "$context.proposal_id"`. Two failures fell out:

1. **Schema rejection.** AdCP 3.0.7's `create-media-buy-request.json` declares `dependencies.proposal_id: ["total_budget"]` and disallows `packages` alongside `proposal_id`. Synthesising packages with the proposal_id elided made the request fail validation against the buyer-side strict gate.
2. **Account resolution.** `create_media_buy` is in `FIXTURE_AWARE_ENRICHERS`, so the enricher's output is used verbatim and the fixture's `account` does not flow through the generic merge. The non-proposal path always replaces `account` with `resolveAccount(options)` (default brand `test.example`); proposal-mode storyboards author a non-default brand (`acmeoutdoor.example`) that the adapter resolved end-to-end through brief/refine/finalize, so the override produced `ACCOUNT_NOT_FOUND` at the accept step.

The enricher now detects proposal-mode (either `step.sample_request.proposal_id` resolving via `$context.*` or `context.proposal_id` set directly) and returns the fixture spread (with `total_budget` and other proposal-mode-required fields preserved) plus the harness-normalised `start_time` / `end_time` and `proposal_id`. `account` and `brand` prefer the fixture when supplied so non-default brands survive to the wire; otherwise the same `context.account ?? resolveAccount(options)` fallback applies.

`hello_seller_adapter_proposal_mode` regression coverage updated: `EXPECTED_FAILURES` cleared (both `get_products_refine` — fixed by adcp#4088 — and `create_media_buy` — fixed here). `expectedRoutes` extended with `POST /v1/orders` and `POST /v1/orders/{id}/lineitems` so the façade gate now asserts the full proposal lifecycle reaches the upstream's order endpoints.
