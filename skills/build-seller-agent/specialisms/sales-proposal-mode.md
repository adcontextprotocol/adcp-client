# Specialism: sales-proposal-mode

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-proposal-mode`.

**Fork target**: [`examples/hello_seller_adapter_proposal_mode.ts`](../../../examples/hello_seller_adapter_proposal_mode.ts) is the worked, passing reference adapter for this specialism. It demonstrates the v1.5 `ProposalManager` + `DecisioningPlatform` two-platform composition: `ProposalManager` curates, refines, and finalizes; `SalesCorePlatform.createMediaBuy` reads the committed recipe from `ctx.recipes` and creates the order. Replace the `// SWAP:` markers with calls to your real backend. See [SHAPE-GOTCHAS.md](../../SHAPE-GOTCHAS.md) for response-shape pitfalls.

Storyboard: `media_buy_seller/proposal_finalize` (subset of `media_buy_seller`).

## What's different from the baseline seller flow

The acceptance path inverts the baseline. Instead of the buyer composing a `packages[]` array and calling `create_media_buy`, the seller curates a media plan, the buyer iterates, and `create_media_buy(proposal_id=…, total_budget=…)` accepts the locked plan in one call.

Three new surfaces:

| Surface             | Owned by            | Does                                                                                            |
| ------------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `get_products`      | `ProposalManager`   | Returns curated `proposals[]` alongside `products[]` when the request carries a `brief`.        |
| `refine_products`   | `ProposalManager`   | Applies buyer asks to a draft proposal, returns updated `proposals[]` + `refinement_applied[]`. |
| `finalize_proposal` | `ProposalManager`   | Locks pricing, hands committed recipes to the framework's `InMemoryProposalStore`.              |
| `create_media_buy`  | `SalesCorePlatform` | Reads `ctx.recipes` (hydrated from the committed proposal); never re-fetches upstream.          |

The framework owns proposal-state transitions (`draft → committed → consumed`) via `InMemoryProposalStore`. The adapter is stateless — it projects upstream proposal documents onto the AdCP wire shape and lets the framework manage lifecycle.

## `ctx_metadata` for proposal-side identifiers

The fork target stashes the network code on the resolved account (`ctx.account.ctx_metadata.network_code`) so every proposal call routes to the correct upstream tenant without re-resolving. **Do not put bearer tokens or signing secrets in `ctx_metadata`** — re-derive credentials from `ctx.authInfo` per call. See [`docs/guides/CTX-METADATA-SAFETY.md`](../../../docs/guides/CTX-METADATA-SAFETY.md).

`ProposalManager.finalizeProposal` writes `upstream_ids.proposal_id` and `upstream_ids.line_item_template_id` onto the recipe. Those non-secret upstream IDs are exactly what `ctx_metadata` is for; the framework persists them in the committed-proposal store and rehydrates them in `sales.createMediaBuy(ctx)`.

## Sole-stateful-step exemption

The proposal-mode storyboard treats `finalize_proposal` as a sole stateful step in some scenarios — when the only stateful peer (e.g., a parallel governance check) was skipped, the runner applies the sole-stateful-step exemption (`adcp#4053`, `adcp-client#1146/#1545`) so the downstream `create_media_buy` step doesn't cascade-skip. The fork target's tests cover this branch (`hello_seller_adapter_proposal_mode` exercises the exemption path under the storyboard runner).

If your adapter fails this scenario with `cascade-skip-on-skip`, check that `finalize_proposal` returns a populated `recipes` map — an empty map looks to the runner like the proposal didn't commit, which suppresses the exemption.

## Refinement loop

`refine_products` accepts a `refine[]` array on the request. Each entry has `scope: 'request' | 'proposal'` and (when `scope='proposal'`) a `proposal_id` plus an `ask` string. Return:

- Updated `proposals[]` reflecting the applied ask.
- `refinement_applied[]` echoing each `refine[]` entry with `status: 'applied' | 'rejected'` so the buyer can audit which asks landed.

Reject `refine_products` calls without at least one `scope: 'proposal'` entry — there's nothing to refine.

## TTL + `PROPOSAL_EXPIRED`

Committed proposals carry `expires_at`. On `create_media_buy(proposal_id=…)`, validate the TTL; return structured `PROPOSAL_EXPIRED` (use the SDK's typed-error helper) if the proposal aged out. The framework's `expiresAtGraceSeconds` capability lets you tolerate clock skew (the fork target sets 60 seconds).

## When `proposal_id` is missing

Sellers that **only** accept proposals (no direct package-based buying) should reject `create_media_buy` without `proposal_id` with `INVALID_REQUEST` and a hint pointing at the proposal flow. The fork target shows the pattern. Sellers that accept both can fall through to the baseline packages path.
