---
'@adcp/sdk': patch
---

`examples/hello_seller_adapter_guaranteed.ts` now attaches a typed `GAMLikeRecipe` to each `Product`'s `implementation_config` via the new `buildGAMLikeRecipe` helper from `@adcp/sdk/mock-server`. Surgical change — keeps the agent direct-buy (the `sales_guaranteed` storyboard's flow) and preserves all existing HITL semantics. The recipe is opt-in: buyers using this agent's direct-buy path ignore it; buyers routing through proposal-mode (via a different adapter) read the same recipe via `ctx.recipes` after the framework hydrates it from the committed proposal.

**Why this is small instead of a full rebuild:** v1.5's value lands in *proposal-mode* adapters (where the framework absorbs the lifecycle ceremony around brief→refine→finalize→accept). Direct-buy adapters — where the buyer hands over `packages[]` to `create_media_buy` directly — don't engage `ctx.recipes`. Forcibly threading proposal-mode through this agent would break the existing `sales_guaranteed` storyboard or balloon the LOC. Instead, this change demonstrates v1.5 *interoperability*: the same agent emits typed recipes a future proposal-mode buyer can consume, without disrupting today's direct-buy path. The big-LOC-reduction story for v1.5 is in `hello_seller_adapter_proposal_mode.ts` (549 LOC vs. 1213 LOC for this direct-buy agent — a +full proposal lifecycle that this agent doesn't have).

Verified: existing three-gate CI (strict tsc, `sales_guaranteed` storyboard, façade upstream-traffic) passes 3/3 unchanged.
