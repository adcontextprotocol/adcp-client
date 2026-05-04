---
'@adcp/sdk': minor
---

**`hello_seller_adapter_proposal_mode`** — canonical reference adapter for the v1.5 ProposalManager + DecisioningPlatform two-platform composition. New file at `examples/hello_seller_adapter_proposal_mode.ts`, ~550 LOC including all imports, types, comments, and boot wiring.

Validates the v1.5 design end-to-end:

- The full proposal lifecycle (brief → draft → refine → finalize → committed → accept) lives behind `ProposalManager` (~120 LOC of substantive logic). The framework's `InMemoryProposalStore` carries the `draft → committed → consuming → consumed` state machine; the adapter just wraps the upstream's `/v1/proposals*` endpoints.
- `sales.createMediaBuy(proposal_id)` reads `ctx.recipes` (populated by the framework from the committed proposal) and uses `recipe.upstream_ids.line_item_template_id` to drive order creation. There's no second round-trip to the upstream's proposal store — the recipe IS the contract between the proposal-side and execution-side platforms.
- Smoke-tested end-to-end against the `sales-guaranteed` mock-server: brief → draft proposal with 3 allocations → refine ("shift more to ctv") biases the mix → finalize commits with `expires_at` → `create_media_buy(proposal_id)` creates an upstream order + 2 line items keyed off the recipe's `ad_unit_ids` and `line_item_template_id`.

**LOC comparison vs. existing direct-buy `hello_seller_adapter_guaranteed`:** 549 LOC including the entire proposal lifecycle, vs. 1213 LOC for the direct-buy agent that has no proposal lifecycle. The v1.5 surface absorbs the lifecycle ceremony into the framework — adopters write business logic against a typed recipe instead of hand-rolling state machines.

Companion CI gate: `test/examples/hello-seller-adapter-proposal-mode.test.js` runs the standard three-gate suite (strict tsc, storyboard pass, façade upstream-traffic check) against `media_buy_seller/proposal_finalize`. **All three gates pass.** Setup, brief_with_proposals, finalize_proposal, and accept_proposal pass; one allowlisted failure on `refine_proposal` traces to a spec-side gap (the `proposal_finalize.yaml` scenario lacks `context_outputs` / `context_inputs` declarations to chain the seller-minted `proposal_id` from `brief_with_proposals` into the refine step — the runner sends the literal placeholder `balanced_reach_q2` from the spec's `sample_request`). The lifecycle works end-to-end when a real buyer threads the prior `proposal_id`, as confirmed by the manual smoke test in the commit message of the previous commit.
