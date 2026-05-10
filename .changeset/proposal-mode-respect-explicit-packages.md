---
"@adcp/sdk": patch
---

fix(storyboard): proposal-mode enricher respects fixture's explicit `packages` over auto-captured `context.proposal_id`

PR #1603 introduced proposal-mode in the `create_media_buy` request enricher by reading `context.proposal_id`. `context.proposal_id` is auto-captured by `context.ts::get_products()` from any prior `get_products` response that returned `proposals[0].proposal_id` — which is essentially every brief flow against a seller that supports proposal-mode discovery.

The enricher fell back to `context.proposal_id` whenever the fixture didn't explicitly set `proposal_id`. That meant a storyboard authoring `packages` directly in `sample_request` would still have its packages dropped in favor of the auto-captured proposal — forcing every sales storyboard whose brief returned proposals through the seller's strict proposal-lifecycle validation.

Concrete impact (surfaced when consuming sellers like `test-agent.adcontextprotocol.org` that enforce proposal-status / IO-acceptance / total_budget rules on `proposal_id`-shaped requests): `sales_guaranteed`, `sales_non_guaranteed`, `schema_validation`, `media_buy_seller/*`, `creative_generative/seller`, and similar package-mode storyboards regressed below their step floors with `PROPOSAL_NOT_COMMITTED` errors.

Fix: the enricher now reads `context.proposal_id` only when the fixture authors NEITHER `proposal_id` NOR `packages`. Fixture intent wins:

| Fixture                                  | Mode chosen      |
|------------------------------------------|------------------|
| `proposal_id` set                        | proposal-mode    |
| `packages` set, no `proposal_id`         | package-mode (was: incorrectly proposal-mode via context fallback) |
| neither                                  | proposal-mode if `context.proposal_id` set; otherwise package-mode |

Tests added for all four cases; existing `hello_seller_adapter_proposal_mode` integration coverage continues to pass (proposal-mode storyboards explicitly author `proposal_id`).

Patch-eligible per the additive-fix rule: behavior aligns with the original PR #1603 intent (proposal-mode for proposal-mode storyboards), only narrows the over-applied fallback that was masking the proposal-validation path entirely.
