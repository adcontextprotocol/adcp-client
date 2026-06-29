---
'@adcp/sdk': patch
---

Storyboard runner: branch-set `any_of` peers no longer cascade-skip each other. When peer phases are `stateful: true`, an earlier peer's by-design failure was tripping the stateful cascade and skipping a later sibling peer with `prerequisite_failed` before it ran — so the only viable contribution never landed and the `any_of` gate returned `[]` (e.g. `media_buy_seller/refine_finalize_exclusivity` for a seller that rejects atomic multi-finalize). `cascadeForPhase` now excludes same-branch-set `any_of` peers from a phase's cascade dependencies; within-phase and cross-phase non-peer cascade behavior are unchanged.
